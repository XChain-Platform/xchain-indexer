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
 * XChain Platform Action - SLASH (WI-2 bump 2: equivocation slashing)
 *
 * A PERMISSIONLESS, submitter-driven proof that a capability validator
 * EQUIVOCATED (signed two CONFLICTING values for the same protocol slot
 * (same engine, same round, same view). The proof is self-contained and
 * verified deterministically on every BTC indexer with no cross-chain data,
 * so the burn is identical fleet-wide.
 *
 * FORMAT (spec §4.1.1):
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
 *      `EQUIV|<EQUIV_KEY>||` (same engine, round, AND view; the R-3 defence: an
 *      honest view change re-signs under a DIFFERENT view, so it can never be
 *      paired here; and v0/v1 checkpoints have DISTINCT keys, the R-4 fix, so
 *      they can never be falsely paired either);
 *   2. their <CONTENT> differs (identical bytes = the same message, e.g. PREPARE
 *      then COMMIT, which is not equivocation);
 *   3. BOTH signatures verify against OFFENDER_PUBKEY;
 *   4. OFFENDER_PUBKEY was in the locked capability snapshot for CAPABILITY at the
 *      slot's snapshot_block (recovered deterministically from the proof itself;
 *      see _resolveSlot);
 *   5. not already slashed for (pubkey, capability): a first proof burns the whole
 *      bond; later proofs are no-ops (idempotent, reorg-safe).
 *
 * On success: burn the offender's ENTIRE capability bond (active stakes + cooldown-
 * locked unstakes) via db.slashCapabilityStake, pay the submitter a capped bounty,
 * route the remainder to the governance treasury (BURN sentinel until set), and
 * record a capability_slash_events audit row. BTC-only (capability stake is BTC-only).
 *
 * SCOPE NOTES (carried for the reviewer; see the Phase-C handover):
 *   - XCONFIG IS slashable (WI-2 bump 2, Phase-A amendment): the XCONFIG signed content
 *     carries the round's locked snapshot_block as `snapshot_block|config_digest`, so the
 *     proof alone yields the membership block. Because config-change PBFT is authorized by
 *     the WHOLE federation (not a capability subset; see xchain-hub Consensus._lockSnapshot),
 *     it carries the sentinel CAPABILITY label 'config' and membership resolves against
 *     getActiveValidators(snapshot_block), not a capability set. The whole bond still burns
 *     (slashCapabilityStake is capability-agnostic). Inert until the EQUIV flag-day.
 *   - Bounty/treasury amounts are governance config (Phase D). Absent config this
 *     defaults to a PURE BURN (bounty 0, no treasury credit). Sound, just no payout.
 *   - PERMANENT disqualification: a slashed pubkey is barred from the effective signer set
 *     GLOBALLY and permanently. db._effectiveCapabilitySetSql / _stakeWeightsSql / hasCapability
 *     exclude any key in capability_slash_events (block-gated, reorg-safe), so a fresh re-stake
 *     of a slashed key never re-qualifies in any capability. The burn here zeroes the CURRENT
 *     bond; the query exclusion makes it permanent.
 *
 ********************************************************************/

const ed25519 = require('../ed25519.js');
const eq      = require('../equivocation_header.js');

// ENGINE_TAG → the membership label the locked snapshot governs that engine's signer
// set under. For the five capability-scoped engines this is the staking capability whose
// MIN_STAKE-qualified set signed the slot. XCONFIG is the exception: config-change PBFT is
// authorized by the WHOLE federation (every active staker, no capability subset; see
// xchain-hub Consensus._lockSnapshot), so it carries the sentinel label 'config' and its
// membership resolves against getActiveValidators (handled in parse()), not a capability set.
const CONFIG_CAPABILITY = 'config';
const ENGINE_CAPABILITY = {
    [eq.ENGINE_TAGS.DEX]:        'cross_chain',
    [eq.ENGINE_TAGS.XCALL]:      'cross_chain',
    [eq.ENGINE_TAGS.CHECKPOINT]: 'oracle_publish',
    [eq.ENGINE_TAGS.ORACLE]:     'price',
    [eq.ENGINE_TAGS.ATTEST]:     'attestation',
    [eq.ENGINE_TAGS.CONFIG]:     CONFIG_CAPABILITY,
};

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

        // Validate format
        let format = data['FORMAT'];
        if(!error && (format === null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        // Extract fields
        data['CAPABILITY']      = params[1];
        data['OFFENDER_PUBKEY'] = params[2];
        let msgAb64 = params[3], sigA = params[4], msgBb64 = params[5], sigB = params[6];

        // SLASH is BTC-only (capability stake is BTC-only)
        if(!error && data['COIN'] !== 'BTC')
            error = 'invalid: ACTION (BTC only)';

        // Field presence
        if(!error && (this.util.isNull(data['OFFENDER_PUBKEY']) ||
                      this.util.isNull(msgAb64) || this.util.isNull(sigA) ||
                      this.util.isNull(msgBb64) || this.util.isNull(sigB) || this.util.isNull(data['CAPABILITY'])))
            error = 'invalid: missing field';

        // OFFENDER_PUBKEY format
        let offender = String(data['OFFENDER_PUBKEY'] || '').toLowerCase();
        if(!error && !/^[0-9a-fA-F]{64}$/.test(offender))
            error = 'invalid: OFFENDER_PUBKEY (format)';

        // Decode the two signed canonicals (base64url → utf8 string)
        let msgA = null, msgB = null;
        if(!error){
            try { msgA = Buffer.from(String(msgAb64), 'base64url').toString('utf8'); } catch(e){ msgA = null; }
            try { msgB = Buffer.from(String(msgBb64), 'base64url').toString('utf8'); } catch(e){ msgB = null; }
            if(msgA === null || msgB === null) error = 'invalid: MSG (base64)';
        }

        // (1) Derive the EQUIV key from MSG_A's header. The wire action does NOT carry it
        // (it contains '|' and would break the pipe split). The header is
        // `EQUIV|<ENGINE_TAG|ROUND_ID|VIEW>||<CONTENT>`; the key has no `||` (no empty
        // segment), so the FIRST `||` is the unambiguous key/content boundary.
        let equivKey = '', prefix = '';
        if(!error){
            let sep = msgA.startsWith('EQUIV|') ? msgA.indexOf('||') : -1;
            if(sep < 0){
                error = 'invalid: MSG_A has no EQUIV header';
            } else {
                prefix   = msgA.slice(0, sep + 2);            // 'EQUIV|<key>||'
                equivKey = msgA.slice('EQUIV|'.length, sep);  // '<key>'
            }
        }

        // Both messages must share that EXACT header prefix (same engine, round, AND view).
        if(!error && !msgB.startsWith(prefix))
            error = 'invalid: EQUIV header/key mismatch';

        // (2) Their content must DIFFER (identical bytes = the same message, not equivocation).
        if(!error && msgA === msgB)
            error = 'invalid: identical messages (not equivocation)';

        // Parse the key into (engineTag, roundId, view). ROUND_ID may contain '|',
        // so take the FIRST segment as the tag and the LAST as the view.
        let engineTag = '', roundId = '', view = '';
        if(!error){
            let firstPipe = equivKey.indexOf('|');
            let lastPipe  = equivKey.lastIndexOf('|');
            if(firstPipe < 0 || lastPipe <= firstPipe){
                error = 'invalid: EQUIV_KEY (format)';
            } else {
                engineTag = equivKey.substring(0, firstPipe);
                view      = equivKey.substring(lastPipe + 1);
                roundId   = equivKey.substring(firstPipe + 1, lastPipe);
            }
        }

        // CAPABILITY must be the one the engine maps to (derived, not trusted). XCONFIG
        // (and any unknown engine) has no slashable membership here → reject.
        let capability = null;
        if(!error){
            capability = ENGINE_CAPABILITY[engineTag];
            if(!capability)
                error = 'invalid: ENGINE_TAG (not slashable)';
            else if(String(data['CAPABILITY']) !== capability)
                error = 'invalid: CAPABILITY (does not match engine)';
        }

        // (3) BOTH signatures verify against OFFENDER_PUBKEY over the FULL signed bytes.
        if(!error && !ed25519.verify(msgA, String(sigA), offender))
            error = 'invalid: SIG_A (does not verify)';
        if(!error && !ed25519.verify(msgB, String(sigB), offender))
            error = 'invalid: SIG_B (does not verify)';

        // (4) Recover the slot's snapshot_block deterministically from the proof and
        // confirm OFFENDER_PUBKEY was in CAPABILITY's locked snapshot at that block.
        let snapshotBlock = null;
        if(!error){
            let slot = await this._resolveSlot(engineTag, roundId, msgA.substring(prefix.length), msgB.substring(prefix.length));
            if(slot.error) error = slot.error;
            else snapshotBlock = slot.snapshotBlock;
        }
        if(!error){
            // XCONFIG is authorized by the WHOLE federation (getActiveValidators), every other
            // engine by its capability-scoped snapshot. Both return [{pubkey,...}] at the block.
            let validators = (capability === CONFIG_CAPABILITY)
                ? await this.indexerDb.getActiveValidators(snapshotBlock)
                : await this.indexerDb.getValidatorsByCapability(capability, snapshotBlock);
            let inSet = Array.isArray(validators) &&
                validators.some(v => String(v.pubkey || '').toLowerCase() === offender);
            if(!inSet)
                error = 'invalid: OFFENDER_PUBKEY not in ' +
                    (capability === CONFIG_CAPABILITY ? 'federation' : 'capability') +
                    ' snapshot at block ' + snapshotBlock;
        }

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

        console.log("\t SLASH : capability=" + String(data['CAPABILITY']) +
            ' : offender=' + offender.substring(0, 16) + '...' +
            ' : key=' + equivKey.substring(0, 24) + '...' +
            ' : ' + status);

        let credits = [], debits = [];

        if(status === 'valid'){
            // Burn the whole bond (active stakes + cooldown unstakes); returns total XCHAIN burned.
            let burned = await this.indexerDb.slashCapabilityStake(pubkeyId, data['BLOCK_INDEX'], data['ACTION_INDEX']);

            // Bounty / treasury split. Governance config (Phase D); absent → pure burn.
            let split = this._bountyTreasurySplit(capability, burned);

            // Bounty re-enters circulation to the submitter; treasury to its destination
            // (a configured address, else BURN = no credit). Burned stake left circulation
            // at STAKE time, so there is NO debit here; only the redirected credits.
            let gas = this.config['GAS'];
            if(this.util.bcgt(split.bounty, '0'))
                credits.push([gas, split.bounty, data['SOURCE']]);
            if(split.treasuryAddr && this.util.bcgt(split.treasury, '0'))
                credits.push([gas, split.treasury, split.treasuryAddr]);

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

            if(split.treasuryAddr) this.util.addAddressTicker(split.treasuryAddr, gas);
            this.util.addAddressTicker(data['SOURCE'], gas);
        }

        // Apply ledger changes + reconcile balances/supply.
        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits);
        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);

        await this.mapper.createMappings(data);
    }

    // Recover the slot's snapshot_block from the proof, deterministically per engine.
    // The two CONTENT strings (header already stripped) must agree on the block where
    // it is carried in-content; for engines that don't carry it, derive from the round.
    async _resolveSlot(engineTag, roundId, contentA, contentB){
        // In-content snapshot_block field index per engine (raw canonical layout).
        const FIELD = {
            [eq.ENGINE_TAGS.DEX]:        2,   // XMATCH|match_id|snapshot_block|...
            [eq.ENGINE_TAGS.XCALL]:      3,   // XCALL|DISPATCH|call_id|snapshot_block|...  (RESULT: same index)
            [eq.ENGINE_TAGS.CHECKPOINT]: 9,   // XCHECKPOINT|chain|network|block_index|block_hash|ledger|actions|contract|checkpoint_seq|snapshot_block[|batch_seq..]
            [eq.ENGINE_TAGS.CONFIG]:     0,   // XCONFIG content = snapshot_block|config_digest (Phase-A amendment: block carried in-content so config equivocation is slashable)
        };
        if(FIELD[engineTag] !== undefined){
            let i  = FIELD[engineTag];
            let fa = contentA.split('|')[i];
            let fb = contentB.split('|')[i];
            if(this.util.isNull(fa) || fa !== fb || !/^[0-9]+$/.test(String(fa)))
                return { error: 'invalid: snapshot_block (mismatch or format)' };
            return { snapshotBlock: Number(fa) };
        }
        // XORACLE: the ROUND_ID IS the BTC block.
        if(engineTag === eq.ENGINE_TAGS.ORACLE){
            if(!/^[0-9]+$/.test(String(roundId)))
                return { error: 'invalid: ORACLE round (not a block)' };
            return { snapshotBlock: Number(roundId) };
        }
        // XATTEST: the canonical is delimiter-less and carries no block. Recover it from
        // the mirrored request row keyed by the ROUND_ID (= request_id). Deterministic
        // (the request is indexed state present on every BTC indexer).
        if(engineTag === eq.ENGINE_TAGS.ATTEST){
            let request = await this.indexerDb.getAttestationRequestById(String(roundId).toLowerCase());
            if(!request || request.block_index == null)
                return { error: 'invalid: ATTEST request unknown (cannot resolve snapshot_block)' };
            return { snapshotBlock: Number(request.block_index) };
        }
        return { error: 'invalid: ENGINE_TAG (no snapshot_block rule)' };
    }

    // Bounty/treasury split for a burned bond. Governance-configured (Phase D). The submitter's
    // bounty = clamp(BOUNTY_BPS·burned, BOUNTY_FLOOR, BOUNTY_CAP), never exceeding the bond; the
    // remainder goes to TREASURY_ADDRESS, or is BURNED when unset. Config shape:
    //   config.STAKING.CAPABILITIES[capability].SLASH  for the 5 capability-scoped engines, or
    //   config.CONFIG_SLASH                            for XCONFIG (capability === 'config',
    //                                                  whole-federation scope, no CAPABILITIES home)
    //   = { BOUNTY_BPS, BOUNTY_FLOOR, BOUNTY_CAP, TREASURY_ADDRESS }  (all optional)
    // Absent / zero → PURE BURN (bounty 0, no treasury credit). Never pays validators.
    _bountyTreasurySplit(capability, burned){
        let total = String(burned || '0');
        if(!this.util.bcgt(total, '0')) return { bounty: '0', treasury: '0', treasuryAddr: null };

        // XCONFIG has no staking capability, so its SLASH policy lives at config.CONFIG_SLASH;
        // every other engine reads its capability's SLASH block.
        let cfg;
        if(capability === 'config'){
            cfg = this.config['CONFIG_SLASH'] || {};
        } else {
            let caps = (this.config['STAKING'] && this.config['STAKING']['CAPABILITIES']) ? this.config['STAKING']['CAPABILITIES'] : {};
            cfg = (caps[capability] && caps[capability]['SLASH']) ? caps[capability]['SLASH'] : {};
        }

        let bps = Number(cfg['BOUNTY_BPS'] || 0);
        if(!Number.isFinite(bps) || bps < 0) bps = 0;
        if(bps > 10000) bps = 10000;

        // bc* return mathjs BigNumbers → String() so the ledger sees plain amount strings
        // (the convention everywhere else, e.g. STAKE's debits).
        let bounty = (bps > 0)
            ? String(this.util.bcdiv(this.util.bcmul(total, String(bps), 8), '10000', 8))
            : '0';
        // FLOOR: guarantee a minimum payout so a submitter always clears the (BTC-tx + protocol)
        // submission cost, even on a bond at MIN_STAKE. Applied before the cap; the final clamp
        // to `total` keeps a sub-floor bond from minting (bounty = whole bond, treasury 0).
        let floor = cfg['BOUNTY_FLOOR'];
        if(floor != null && this.util.bcgt(String(floor), bounty))
            bounty = String(floor);
        // CAP: hard ceiling (detection cost is constant; don't scale the reward with whale bonds).
        let cap = cfg['BOUNTY_CAP'];
        if(cap != null && this.util.bcgt(bounty, String(cap)))
            bounty = String(cap);
        // Never pay out more than was burned.
        if(this.util.bcgt(bounty, total))
            bounty = total;

        let treasury     = String(this.util.bcsub(total, bounty, 8));
        let treasuryAddr = cfg['TREASURY_ADDRESS'] ? String(cfg['TREASURY_ADDRESS']) : null;  // null = BURN
        return { bounty: bounty, treasury: treasury, treasuryAddr: treasuryAddr };
    }
}

module.exports = Slash;
