/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform Action - SLASH (equivocation slashing)
 *
 * A PERMISSIONLESS, submitter-driven proof that a capability validator
 * EQUIVOCATED (signed two CONFLICTING values for the same protocol slot
 * (same engine, same round, same view). The proof is self-contained and
 * verified deterministically on every BTC indexer with no cross-chain data,
 * so the burn is identical fleet-wide.
 *
 * FORMAT (one wire version):
 *   v0 - VERSION|CAPABILITY|OFFENDER_PUBKEY|MSG_A|SIG_A|MSG_B|SIG_B
 *
 *   CAPABILITY      the membership label the equivocation was in (cross_chain /
 *                   oracle_publish / price / attestation, or the sentinel 'config' for
 *                   XCONFIG, whole-federation scope). MUST match the engine the EQUIV header
 *                   names (derived, not trusted).
 *   OFFENDER_PUBKEY 64-hex Ed25519 capability signing key being slashed.
 *   MSG_A/MSG_B     base64url of the two signed canonicals (each an EQUIV-headered
 *                   string `EQUIV|<ENGINE_TAG|ROUND_ID|VIEW>||<CONTENT>`). Equal through
 *                   the header, DIFFERENT in <CONTENT>.
 *   SIG_A/SIG_B     128-hex Ed25519 signatures over MSG_A/MSG_B by OFFENDER_PUBKEY.
 *
 *   The EQUIV key is NOT a wire field: it contains '|' (and so would shatter the
 *   pipe-delimited action) and is fully recoverable from MSG_A's header. The verifier
 *   derives it from the bytes after `EQUIV|` up to the first `||` (the key has no empty
 *   segment, so that boundary is unambiguous).
 *
 * SOUNDNESS: the burn only fires when ALL hold:
 *   1. both messages carry the EQUIV header and share the EXACT same key prefix
 *      `EQUIV|<EQUIV_KEY>||` (same engine, round, AND view; the view-change defence: an
 *      honest view change re-signs under a DIFFERENT view, so it can never be
 *      paired here; and v0/v1 checkpoints have DISTINCT keys, so
 *      they can never be falsely paired either);
 *   2. their <CONTENT> differs (identical bytes = the same message, e.g. PREPARE
 *      then COMMIT, which is not equivocation);
 *   3. BOTH signatures verify against OFFENDER_PUBKEY;
 *   4. OFFENDER_PUBKEY was in the locked capability snapshot for CAPABILITY at the
 *      slot's snapshot_block (recovered deterministically from the proof itself;
 *      see resolveSlot). The proof declares a RAW height; membership, and the
 *      delegated-owner lookup that names whose bond burns, both resolve at
 *      snapshot_reorg_buffer.buriedSnapshotBlock() of it, which is where the hub
 *      that locked the slot resolved its own signer set (flag-day gated);
 *   5. not already slashed for (pubkey, capability): a first proof burns the whole
 *      bond; later proofs are no-ops (idempotent, reorg-safe).
 *
 * On success: burn the offender's ENTIRE capability bond (active stakes + cooldown-
 * locked unstakes) via db.slashCapabilityStake, pay the submitter a capped bounty,
 * route the remainder to the governance treasury (BURN sentinel until set), and
 * record a capability_slash_events audit row. BTC-only (capability stake is BTC-only).
 *
 * SCOPE NOTES (what this action covers and what it leaves out):
 *   - XCONFIG IS slashable: the XCONFIG signed content
 *     carries the round's locked snapshot_block as `snapshot_block|config_digest`, so the
 *     proof alone yields the membership block. Because config-change PBFT is authorized by
 *     the WHOLE federation (not a capability subset; see xchain-hub Consensus._lockSnapshot),
 *     it carries the sentinel CAPABILITY label 'config' and membership resolves against
 *     getActiveValidators(snapshot_block), not a capability set. The whole bond still burns
 *     (slashCapabilityStake is capability-agnostic). Inert until the EQUIV flag-day.
 *   - Bounty/treasury amounts are governance config. Absent config this
 *     defaults to a PURE BURN (bounty 0, no treasury credit). Sound, just no payout.
 *   - PERMANENT disqualification: a slashed pubkey is barred from the effective signer set
 *     GLOBALLY and permanently. db._effectiveCapabilitySetSql / _stakeWeightsSql / hasCapability
 *     exclude any key in capability_slash_events (block-gated, reorg-safe), so a fresh re-stake
 *     of a slashed key never re-qualifies in any capability. The burn here zeroes the CURRENT
 *     bond; the query exclusion makes it permanent.
 *
 ********************************************************************/

const ed25519 = require('../consensus/ed25519.js');
const srb     = require('../snapshot_reorg_buffer.js');

const { getLogger } = require('../observability/index.js');
// The proof's own parts. The handler keeps the chain-facing rules (signatures,
// membership, idempotency, settlement) and delegates the rules that are purely
// about the submitted bytes or about payout policy.
const { CONFIG_CAPABILITY, readProofWire, deriveEquivKey,
        capabilityForEngine } = require('./slash/proof_wire.js');
const { resolveSlot: resolveProofSlot } = require('./slash/resolve_slot.js');
const { bountyTreasurySplit: splitBountyTreasury } = require('./slash/bounty.js');

class Slash {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.formats = {};
        // NOTE: the EQUIV key is NOT a wire field. It contains '|' (ENGINE_TAG|ROUND_ID|VIEW)
        // and would shatter the pipe-delimited action. It is derived from MSG_A's header.
        this.formats[0] = 'VERSION|CAPABILITY|OFFENDER_PUBKEY|MSG_A|SIG_A|MSG_B|SIG_B';
    }

    async parse(params, data, error){

        // Read the wire, derive the EQUIV key, then the capability the engine is
        // judged under. Each phase carries the error forward untouched, so the FIRST
        // failure is still the one that is reported.
        let wire = readProofWire(this.formats, this.util, params, data, error);
        let key  = deriveEquivKey(wire.msgA, wire.msgB, wire.error);
        let cap  = capabilityForEngine(key.engineTag, key.error);
        let offender   = wire.offender;
        let equivKey   = key.equivKey;
        let capability = cap.capability;
        error = cap.error;

        // (3) BOTH signatures verify against OFFENDER_PUBKEY over the FULL signed bytes.
        if(!error && !ed25519.verify(wire.msgA, String(wire.sigA), offender))
            error = 'invalid: SIG_A (does not verify)';
        // Verify SIG_B is the offender's own signature over MSG_B
        if(!error && !ed25519.verify(wire.msgB, String(wire.sigB), offender))
            error = 'invalid: SIG_B (does not verify)';

        let slot = await this.resolveSlotAndCapability(data, wire, key, capability, error);
        error      = slot.error;
        capability = slot.capability;

        error = await this.verifyMembership(data, capability, offender, slot, error);

        // (5) Idempotency: a first proof burns the whole bond; later (pubkey,capability)
        // proofs are no-ops.
        let pubkeyId = null;
        if(!error){
            pubkeyId = await this.indexerDb.getOrCreatePubkeyId(offender);
            if(await this.indexerDb.hasCapabilitySlashEvent(pubkeyId, capability))
                error = 'invalid: already slashed (pubkey, capability)';
        }

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        getLogger().info("\t SLASH : capability=" + String(data['CAPABILITY']) +
            ' : offender=' + offender.substring(0, 16) + '...' +
            ' : key=' + equivKey.substring(0, 24) + '...' +
            ' : ' + status);

        await this.settleSlash(data, status, capability, pubkeyId, slot.resolveBlock, equivKey);
    }

    // (4) Recover the slot the proof is about, and with it the capability that
    // actually governs the content family, then hold the submitter to it.
    async resolveSlotAndCapability(data, wire, key, capability, error){
        // (4) Recover the slot's snapshot_block deterministically from the proof and
        // confirm OFFENDER_PUBKEY was in CAPABILITY's locked snapshot at that block.
        //
        // DECLARED vs RESOLVED. `snapshotBlock` is the RAW height the proof declares, and
        // it stays raw: it is what the offender's own signed bytes say, so it is what the
        // reject message names and what any future gate keys on. `resolveBlock` is the
        // height the set is actually re-derived at. The hub that locked this slot resolved
        // its membership through CapabilitySnapshot, which subtracts CANONICAL_REORG_BUFFER
        // first, so re-deriving at the raw height selects a DIFFERENT set than the signer
        // whenever a validator's stake activated or deactivated inside
        // (declared - 6, declared]. That gap cuts both ways here: it can leave a genuine
        // equivocator out of the set (a real proof that burns nothing) and it can put a key
        // in a set it never signed under. Same fix, same shared constant, same flag day as
        // the existing consumers (attest.js, recovery.js, sdk light.js); below the gate this
        // is the declared height unchanged, so pre-flag-day acceptance is byte-identical.
        let snapshotBlock = null, resolveBlock = null;
        if(!error){
            // At/after SLASH_ORACLE_ROUND_DISCRIMINATED, an XORACLE pair
            // must agree on the oracle round carried in-content. Gated, not unconditional,
            // because narrowing which proofs burn a bond is a consensus acceptance rule.
            let oracleRoundGate = await this.actions.protocolChanges.isEnabled('SLASH_ORACLE_ROUND_DISCRIMINATED', data['BLOCK_INDEX']);
            let slot = await this.resolveSlot(key.engineTag, key.roundId, wire.msgA.substring(key.prefix.length),
                wire.msgB.substring(key.prefix.length), oracleRoundGate);
            if(slot.error) error = slot.error;
            else {
                snapshotBlock = slot.snapshotBlock;
                resolveBlock  = srb.buriedSnapshotBlock(snapshotBlock, this.config['NETWORK']);
                // One engine tag can host content families locked under DIFFERENT
                // capabilities: XATTEST's relay legs are verified against `cross_chain`
                // (attest.js verifyRelayQuorum), not `attestation`. The slot
                // resolver names the governing one, so the derived-CAPABILITY check runs
                // HERE, after the family is known, rather than off the tag alone.
                if(slot.capability) capability = slot.capability;
            }
        }
        // CAPABILITY is derived, never trusted: the submitter declares it and must match.
        if(!error && String(data['CAPABILITY']) !== capability)
            error = 'invalid: CAPABILITY (does not match engine)';
        return { error: error, capability: capability, snapshotBlock: snapshotBlock, resolveBlock: resolveBlock };
    }

    // Returns the error chain, unchanged when it already carries a failure.
    async verifyMembership(data, capability, offender, slot, error){
        // Verify the offender was actually in the signing set for this slot (a non-member cannot equivocate in it)
        if(!error){
            // XCONFIG is authorized by the WHOLE federation (getActiveValidators), every other
            // engine by its capability-scoped snapshot. Both return [{pubkey,...}] at the block.
            // Read at the BURIED height (see above); the message still names the declared one,
            // matching attest.js, so the reject bytes do not move with the buffer.
            let validators = (capability === CONFIG_CAPABILITY)
                ? await this.indexerDb.getActiveValidators(slot.resolveBlock)
                : await this.indexerDb.getValidatorsByCapability(capability, slot.resolveBlock);
            let inSet = Array.isArray(validators) &&
                validators.some(v => String(v.pubkey || '').toLowerCase() === offender);
            if(!inSet)
                error = 'invalid: OFFENDER_PUBKEY not in ' +
                    (capability === CONFIG_CAPABILITY ? 'federation' : 'capability') +
                    ' snapshot at block ' + slot.snapshotBlock;
        }
        return error;
    }

    // Split out of the settlement so the two questions it answers (burn pending
    // stakes? whose bond is it?) read together.
    async burnWholeBond(data, pubkeyId, resolveBlock){
        // Burn the whole bond (active stakes + cooldown unstakes); returns total XCHAIN burned.
        // At/after SLASH_BURNS_PENDING_STAKE (EQUIV-height-gated) burn pending-activation
        // stakes too, so an equivocator's just-submitted top-up can't survive the burn.
        let burnPending = await this.actions.protocolChanges.isEnabled('SLASH_BURNS_PENDING_STAKE', data['BLOCK_INDEX']);

        // If the offender was a DELEGATED signing key, the bond is held by
        // the source that delegated to it, not by rows keyed on the delegated pubkey.
        // Burning by signing_pubkey_id matched nothing and burned ZERO while still
        // writing a valid slash event, so equivocating through a delegated key cost
        // the staker nothing. Resolve the owner AT THE EQUIVOCATION HEIGHT
        // (recovered from the proof above) rather than at processing time, so a
        // delegation revoked after the offence cannot orphan the proof and the target
        // is a pure function of the proof itself.
        //
        // The height read is `resolveBlock`, the SAME buried height the membership
        // check above used, not the raw declared one. The two must agree or the pair
        // is incoherent: a delegation that activated inside the buried window puts the
        // key in the raw-height set while the buried-height owner lookup returns null
        // (burn nothing), and a delegation revoked inside it does the mirror. Deciding
        // "was this key authorized to sign" and "whose bond does that make it" at two
        // different heights is what produces a valid slash event that burns zero.
        //
        // A key that stakes in its own name resolves to null and keeps the original
        // targeting. A bond that has since fully unstaked and withdrawn burns zero:
        // that is deliberate, not a rejection, so the outcome never depends on stake
        // motion after the offence.
        let ownerSourceId = await this.indexerDb.getStakeSourceForDelegatedPubkey(pubkeyId, resolveBlock);
        let burn   = await this.indexerDb.slashCapabilityStake(pubkeyId, data['BLOCK_INDEX'], data['ACTION_INDEX'], burnPending, ownerSourceId);
        return burn;
    }

    async recordSlashEvent(data, capability, equivKey, pubkeyId, burned, split){
        // Audit row (also the (pubkey,capability) dedup record).
        let submitterId  = await this.indexerDb.getAddressId(data['SOURCE']);
        let destinationId = split.treasuryAddr ? await this.indexerDb.getAddressId(split.treasuryAddr) : null;
        await this.indexerDb.createCapabilitySlashEvent({
            SLASH_ACTION_INDEX: data['ACTION_INDEX'],
            SIGNING_PUBKEY_ID:  pubkeyId,
            CAPABILITY:         capability,
            EQUIV_KEY:          equivKey,
            AMOUNT:             burned,
            BOUNTY_AMOUNT:      split.bounty,
            TREASURY_AMOUNT:    split.treasury,
            SUBMITTER_ID:       submitterId,
            DESTINATION_ID:     destinationId,
            BLOCK_INDEX:        data['BLOCK_INDEX']
        });
    }

    // Apply the verdict to the ledger. A rejected proof still lands here with empty
    // arrays, so balances and mappings are reconciled on every path.
    async settleSlash(data, status, capability, pubkeyId, resolveBlock, equivKey){
        let credits = [], debits = [], escrows = [];

        if(status === 'valid'){
            let burn   = await this.burnWholeBond(data, pubkeyId, resolveBlock);
            let burned = burn.total;

            // Bounty / treasury split. Governance config; absent → pure burn.
            let split = this.bountyTreasurySplit(capability, burned);

            let gas = this.config['GAS'];
            // Release the bond from the staker's escrow BEFORE redirecting any of it: a bond
            // is LOCKED at STAKE time, so the credits below move tokens already inside the
            // supply equation. Supply falls by exactly the un-redirected remainder.

            // Keyed per owner, never to data['SOURCE']: one burn spans several rows, and a
            // DELEGATED key's bond lives on the OWNING source rather than the submitter.
            for(let r of burn.releases){
                escrows.push([gas, this.util.bcsub(0, r.amount, 64), r.address]);
                this.util.addAddressTicker(r.address, gas);
            }

            // Bounty re-enters circulation to the submitter; treasury to its destination
            // (a configured address, else BURN = no credit).
            if(this.util.bcgt(split.bounty, '0'))
                credits.push([gas, split.bounty, data['SOURCE']]);
            if(split.treasuryAddr && this.util.bcgt(split.treasury, '0'))
                credits.push([gas, split.treasury, split.treasuryAddr]);

            await this.recordSlashEvent(data, capability, equivKey, pubkeyId, burned, split);

            if(split.treasuryAddr) this.util.addAddressTicker(split.treasuryAddr, gas);
            this.util.addAddressTicker(data['SOURCE'], gas);
        }

        // Apply ledger changes + reconcile balances/supply.
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);
        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        await this.mapper.createMappings(data);
    }

    // Recover the slot's snapshot_block from the proof. The per-engine layouts live
    // in slash/resolve_slot.js; this handler only needs the answer, and hands those
    // readers the state they need (util for isNull, indexerDb for the XATTEST read).
    async resolveSlot(engineTag, roundId, contentA, contentB, oracleRoundGate){
        return await resolveProofSlot(this, engineTag, roundId, contentA, contentB, oracleRoundGate);
    }

    // The payout policy lives in slash/bounty.js. The method stays because it is the
    // handler's public shape: callers and tests reach the split through it.
    bountyTreasurySplit(capability, burned){
        return splitBountyTreasury(this.config, this.util, capability, burned);
    }
}

module.exports = Slash;
