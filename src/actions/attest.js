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
 * XChain Platform Action - ATTEST
 *
 * External-data attestation lifecycle with five version-discriminated phases:
 *   v0: Request (VM emission only; originated by xchain.attestation.request())
 *   v1: Response (validator-broadcast PBFT bundle with signatures)
 *   v2: Expire (system-synthesized; never user-broadcast)
 *   v3: Relay request  (cross_chain-federation-broadcast, BTC only)
 *   v4: Relay response (cross_chain-federation-broadcast, origin chain only)
 *
 * v3/v4 are the cross-chain delivery legs (spec §12, framework Phase 5). All
 * `attestation` capability stake lives on BTC, so an ATTEST emitted by an LTC or
 * DOGE contract has no responsible set of its own and cannot be fulfilled where
 * it landed. v3 materializes such a request ONTO BTC, giving it a real BTC
 * block_index: that is the whole point of the model, because CapabilitySnapshot
 * keys the responsible set on a BTC height, and a foreign-origin block_index
 * (DOGE ~6.3M / LTC ~3.16M against BTC ~962K) has no deterministic anchor. Once
 * materialized, the existing v0/v1 machinery services it unchanged. v4 carries
 * the BTC response back so the origin chain can fire the contract callback.
 * Both legs are flag-day gated; see attest_relay_activation.js.
 *
 * Spec: xchain-documentation/protocol/actions/ATTEST.md
 *
 * FORMATS:
 *   v0 - VERSION|REQUEST_ID|PROVIDER_ID|REQUEST_PAYLOAD|CALLBACK_METHOD|CALLBACK_PARAMS_JSON|REDUNDANCY|DEADLINE_BLOCKS
 *   v1 - VERSION|REQUEST_ID|PROVIDER_ID|RESPONSE_PAYLOAD|STATUS|META|SIG_COUNT|PUBKEY|SIG|...
 *   v2 - VERSION|REQUEST_ID         (synthesized only; REQUEST_ID is sufficient, handler looks up the row)
 *   v3 - VERSION|REQUEST_ID|ORIGIN_CHAIN|ORIGIN_ACTION_INDEX|PROVIDER_ID|REQUEST_PAYLOAD|REDUNDANCY|DEADLINE_BLOCKS|SNAPSHOT_BLOCK|SIG_COUNT|PUBKEY|SIG|...
 *   v4 - VERSION|REQUEST_ID|HOME_RESPONSE_ACTION_INDEX|RESPONSE_PAYLOAD|STATUS|META|SNAPSHOT_BLOCK|SIG_COUNT|PUBKEY|SIG|...
 *
 ********************************************************************/

const crypto  = require('crypto');
const ed25519 = require('../ed25519.js');
const swq     = require('../stake_weighted_quorum.js');
const attestAdmission = require('../attest_admission_activation.js');
const attestRequestCap = require('../attest_request_cap_activation.js');
const attestRelay     = require('../attest_relay_activation.js');
const attestBcastFee  = require('../attest_broadcast_fee_activation.js');
const eq      = require('../equivocation_header.js');
const srb     = require('../snapshot_reorg_buffer.js');
const ProviderRegistry = require('../attestation/providerRegistry.js');
const pmsh    = require('../attestation/providerMinStakeHistory.js');
const { rethrowIfInfraFault } = require('./faultGuard.js');
const { buildInjectedExecContext, SYNTH_EXEC_TX_HASH, SYNTH_TAGS } = require('./execContext.js');

// The chain every `attestation` capability stake lives on, and therefore the only
// chain whose heights can key a responsible set. Relay requests are materialized
// here (v3) and nowhere else.
const HOME_CHAIN = 'BTC';

// Chains a relay request may originate from. Deliberately not derived from the
// coin registry: a chain becomes relay-eligible by protocol decision, not by
// being configured, and BTC is excluded because it needs no relay.
const ALLOWED_ORIGIN_CHAINS = ['LTC', 'DOGE'];

// request_id preimage fields, in preimage order. This list is the single in-file
// source of truth for the ORDER and the COUNT, so a skew against the VM's
// derivation is one visible edit rather than a miscounted string concatenation.
// Exported and pinned against the canonical xchain-vm GOLDEN_VECTORS.requestId
// tuple by bin/check-preimage-golden-parity.js, the same way xcall.js pins
// CALL_ID_PREIMAGE_FIELDS; before this list existed a request_id field skew
// surfaced only as an opaque hash difference in a unit suite.
const REQUEST_ID_PREIMAGE_FIELDS = [
    'TX_HASH', 'ROOT_ACTION_INDEX', 'EMITTER_PATH', 'CONTRACT_INDEX', 'EMITTER_POSITION'
];

class Attest {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Providers are the built-in DEFAULTS (http_get, llm) overlaid with any
        // ATTESTATION.PROVIDERS block in the coin config (see providerRegistry.js).
        this.providerRegistry = new ProviderRegistry(this.config);

        // Per-version format strings
        this.formats = {};
        // FEE_TICK|FEE_AMOUNT are optional trailing fields (E1 paid-attestation
        // wire prep): absent on the wire → null, and the SDK serializer trims
        // trailing empties, so feeless requests stay byte-identical to the
        // 8-field format. v1 consensus accepts only FEE_TICK == GAS (XCHAIN);
        // arbitrary ticks are a post-launch rule loosening, not a wire change.
        this.formats[0] = 'VERSION|REQUEST_ID|PROVIDER_ID|REQUEST_PAYLOAD|CALLBACK_METHOD|CALLBACK_PARAMS_JSON|REDUNDANCY|DEADLINE_BLOCKS|FEE_TICK|FEE_AMOUNT';
        this.formats[1] = 'VERSION|REQUEST_ID|PROVIDER_ID|RESPONSE_PAYLOAD|STATUS|META|SIG_COUNT|PUBKEY|SIG|...';
        this.formats[2] = 'VERSION|REQUEST_ID';
        // Cross-chain relay legs. Both are broadcast by the elected cross_chain
        // leader on behalf of the federation and carry their quorum inline,
        // structurally mirroring v1. Both are flag-day gated: below activation
        // the handlers write nothing and persist nothing, which is byte-identical
        // to how a node without relay support treats an unknown VERSION.
        this.formats[3] = 'VERSION|REQUEST_ID|ORIGIN_CHAIN|ORIGIN_ACTION_INDEX|PROVIDER_ID|REQUEST_PAYLOAD|REDUNDANCY|DEADLINE_BLOCKS|SNAPSHOT_BLOCK|SIG_COUNT|PUBKEY|SIG|...';
        this.formats[4] = 'VERSION|REQUEST_ID|HOME_RESPONSE_ACTION_INDEX|RESPONSE_PAYLOAD|STATUS|META|SNAPSHOT_BLOCK|SIG_COUNT|PUBKEY|SIG|...';
    }

    // Stringified request_id preimage values, in REQUEST_ID_PREIMAGE_FIELDS order.
    // Every field is chain data, so every node derives the same bytes. String() is
    // the coercion the derivation has always used and is load-bearing on two of
    // them: CONTRACT_INDEX is deliberately not null-checked here (the caller's
    // guard chain above decides that), and ROOT_ACTION_INDEX must stay the raw
    // string, never Number()-coerced, because a BATCH subcommand root is the
    // composite "<TX_VOUT>.<position>".
    _requestIdPreimageValues(data){
        return REQUEST_ID_PREIMAGE_FIELDS.map((f) => String(data[f]));
    }

    // Dispatch on VERSION
    async parse(params, data, error){

        let format = data['FORMAT'];
        if(!error && (format === null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        if(format === 0) return await this._parseRequest(params, data, error);
        if(format === 1) return await this._parseResponse(params, data, error);
        if(format === 2) return await this._parseExpire(params, data, error);
        if(format === 3) return await this._parseRelayRequest(params, data, error);
        if(format === 4) return await this._parseRelayResponse(params, data, error);
    }

    // ATTEST v0: Request (VM emission only)
    async _parseRequest(params, data, error){

        // VM-emission-only: reject anything user-initiated.
        // execute.processEmission sets IS_EMISSION=true when synthesizing the action.
        if(!error && !data['IS_EMISSION'])
            error = 'invalid: ATTEST v0 must originate from VM emission';

        // Extract positional params
        data['REQUEST_ID']      = params[1];
        data['PROVIDER_ID']     = params[2];
        data['REQUEST_PAYLOAD'] = params[3];
        data['CALLBACK_METHOD'] = params[4];
        data['CALLBACK_PARAMS'] = params[5];
        data['REDUNDANCY']      = params[6];
        data['DEADLINE_BLOCKS'] = params[7];
        data['FEE_TICK']        = (params[8] !== undefined && String(params[8]).trim() !== '') ? String(params[8]).trim() : null;
        data['FEE_AMOUNT']      = (params[9] !== undefined && String(params[9]).trim() !== '') ? String(params[9]).trim() : null;
        // EMITTER carries the contract's action_index (set by execute.processEmission)
        data['CONTRACT_INDEX']  = data['EMITTER'];

        if(!error)
            data = this.util.setNumberFormats(data);

        if(!error && (!data['REQUEST_ID'] || !/^[0-9a-fA-F]{64}$/.test(String(data['REQUEST_ID']))))
            error = 'invalid: REQUEST_ID (format)';

        if(!error && this.util.isNull(data['PROVIDER_ID']))
            error = 'invalid: PROVIDER_ID (required)';

        if(!error && !this.providerRegistry.isKnown(data['PROVIDER_ID']))
            error = 'invalid: PROVIDER_ID (unknown)';

        if(!error && this.util.isNull(data['CALLBACK_METHOD']))
            error = 'invalid: CALLBACK_METHOD (required)';

        let redundancy = parseInt(data['REDUNDANCY']);
        if(!error && !this.providerRegistry.isRedundancyAllowed(data['PROVIDER_ID'], redundancy))
            error = 'invalid: REDUNDANCY (not allowed for provider)';

        let payloadBytes = Buffer.byteLength(String(data['REQUEST_PAYLOAD'] || ''), 'utf8');
        if(!error && !this.providerRegistry.isPayloadSizeAllowed(data['PROVIDER_ID'], payloadBytes))
            error = 'invalid: REQUEST_PAYLOAD (exceeds provider max)';

        let deadlineBlocks = parseInt(data['DEADLINE_BLOCKS']);
        let deadlineBlock  = parseInt(data['BLOCK_INDEX']) + (Number.isFinite(deadlineBlocks) ? deadlineBlocks : 0);
        data['DEADLINE_BLOCK'] = deadlineBlock;
        if(!error && !this.providerRegistry.isDeadlineAllowed(data['PROVIDER_ID'], parseInt(data['BLOCK_INDEX']), deadlineBlock))
            error = 'invalid: DEADLINE (outside provider window)';

        // Optional request fee (E1). XCHAIN-only in v1: the validator_rewards →
        // COLLECT payout chain is GAS-denominated, so consensus pins FEE_TICK to
        // the GAS tick. The field exists on the wire so post-launch multi-tick
        // support is a rule loosening, not a format change.
        if(!error && !this.util.isNull(data['FEE_TICK']) && data['FEE_TICK'] !== this.config['GAS'])
            error = 'invalid: FEE_TICK (only ' + this.config['GAS'] + ' accepted)';

        // isValidFiatFormat = isValidAmountFormat + a decimal-place cap. The fee
        // must not carry more precision than the GAS tick is issued with: the
        // escrow/debit/credit ledger rows round to the tick's decimals
        // (createLedgerChangeRecord), so a finer fee would be CHARGED rounded
        // while attests.fee_amount keeps the unrounded string, desyncing the
        // reward split (computed from the unrounded fee_amount) from the escrow.
        // Cap at min(8, gasDecimals): 8 is the hard ceiling the equal split
        // floors to (bcmulfloor(...,8)); gasDecimals is the consensus precision
        // of the GAS tick (8 for the production XCHAIN genesis issuance, 0 on
        // the decimals-0 regtest GAS tick). Deterministic: every validator
        // replaying from genesis reads the same issues-table state at this block.
        if(!error && !this.util.isNull(data['FEE_AMOUNT'])){
            let gasDecimals = await this.indexerDb.getTokenDecimalPrecision(
                await this.indexerDb.getTickerId(this.config['GAS'])
            );
            let feeCap = Math.min(8, gasDecimals);
            if(!this.util.isValidFiatFormat(feeCap, data['FEE_AMOUNT']))
                error = 'invalid: FEE_AMOUNT (precision > ' + feeCap + ' dp)';
        }

        let feePresent = !error && !this.util.isNull(data['FEE_AMOUNT']) && this.util.bcgt(data['FEE_AMOUNT'], '0');
        if(!error && feePresent && this.util.isNull(data['FEE_TICK']))
            error = 'invalid: FEE_TICK (required when FEE_AMOUNT > 0)';

        // Validate contract_index references a real contract
        if(!error && data['CONTRACT_INDEX'] != null){
            let contract = await this.indexerDb.getContract(data['CONTRACT_INDEX']);
            if(!contract)
                error = 'invalid: CONTRACT_INDEX (unknown)';
        } else if(!error){
            error = 'invalid: CONTRACT_INDEX (missing emitter)';
        }

        // Re-derive request_id and compare. Defends against a compromised VM by anchoring
        // the on-chain request_id to (tx_hash, emitter_path, contract_index,
        // emitter_position). EMITTER_PATH (the emitting execution's deterministic call-path
        // (the '>'-joined per-execution emission positions from the root on-chain action
        // down to this execution, root = '') is part of the preimage because cross-contract
        // calls let the SAME contract run more than once in the SAME tx; without it, two
        // such runs derive identical request_ids for their first attestation. Unlike the old
        // EMITTER_ACTION_INDEX it is content-derived, so it stays byte-stable across nodes
        // and reorgs (action_index advanced with synthetic-action injection timing → forked
        // the PBFT). MUST byte-match the VM's derivation in xchain-vm/src/gateway.js
        // (attestation.request). All inputs are REQUIRED for a legitimate VM emission
        // (execute.processEmission); their absence is a hard failure, not a silent bypass.
        // NOTE: EMITTER_PATH '' (the root on-chain action) is VALID; check === undefined /
        // null, never falsy, or every root-level attestation would be rejected.
        if(!error){
            if(data['EMITTER_POSITION'] === undefined || data['EMITTER_POSITION'] === null){
                error = 'invalid: EMITTER_POSITION (required for request_id derivation)';
            } else if(data['EMITTER_PATH'] === undefined || data['EMITTER_PATH'] === null){
                error = 'invalid: EMITTER_PATH (required for request_id derivation)';
            } else if(data['ROOT_ACTION_INDEX'] === undefined || data['ROOT_ACTION_INDEX'] === null){
                // The per-root discriminator (deterministic root on-chain action_index). Required
                // for every legitimate VM emission; check === undefined/null (0 is a valid index).
                // Hashed as the raw string it arrives as: for a root that is a BATCH subcommand it
                // is the composite "<TX_VOUT>.<position>" (src/batch_root_discriminator.js), which
                // must NOT be Number()-coerced here or by the VM ('3.10' and '3.1' would fold
                // together and re-collide the roots the discriminator exists to separate).
                error = 'invalid: ROOT_ACTION_INDEX (required for request_id derivation)';
            } else if(!data['TX_HASH']){
                error = 'invalid: TX_HASH (required for request_id derivation)';
            } else {
                let preimage = this._requestIdPreimageValues(data).join(':');
                let expected = crypto.createHash('sha256').update(preimage).digest('hex');
                if(expected !== String(data['REQUEST_ID']).toLowerCase())
                    error = 'invalid: REQUEST_ID (does not match deterministic derivation)';
            }
        }

        // GAS_ESCROW is not yet deducted from the fee-payer's balance at request time;
        // the fee-funding check below validates the payer holds the amount, and
        // REQUEST_STATUS is assigned once `error` is final so structural failures
        // do not enter the 'pending' pool (see the assignment after the fee-funding check).
        data['GAS_ESCROW']     = '0';
        data['FEE_PAYER']      = data['FEE_PAYER'] || data['SOURCE']; // execute.processEmission carries FEE_PAYER

        // Fee escrow funding check: FEE_PAYER (the EXECUTE caller) must hold the
        // fee. Read at (BLOCK_INDEX, ACTION_INDEX) so accept/reject is identical
        // across all validators (same determinism rule as COLLECT's pool check).
        if(!error && feePresent){
            let tokenInfo = await this.indexerDb.getTokenInfo(this.config['GAS'], data['BLOCK_INDEX'], data['ACTION_INDEX']);
            let balances  = await this.indexerDb.getAddressBalances(data['FEE_PAYER'], null, data['BLOCK_INDEX'], data['ACTION_INDEX']);
            if(!tokenInfo || !this.util.hasBalance(balances, tokenInfo['TICK_ID'], data['FEE_AMOUNT']))
                error = 'invalid: insufficient funds (FEE_AMOUNT)';
        }

        // Pkg 7 / 87441a53 admission rejection (flag-day gated): at/above the
        // ATTEST_ADMISSION activation, reject a request whose responsible set at
        // this block is smaller than REDUNDANCY. Unservable by construction: the
        // v1 path requires >= REDUNDANCY valid signatures and only responsible-set
        // members can sign, so the hub skips the round (unfinalizable-round guard)
        // and pre-gate the request would sit pending until deadline expiry. The
        // shrink comes from SWQ source-dedupe (one slot per staking source) or a
        // small qualifying snapshot. Below the gate the legacy accept-then-expire
        // path runs verbatim so replay stays bit-identical. Deterministic: the set
        // derives from block-anchored stake state every validator replays alike.
        // The computed set is reused as the pinned RESPONSIBLE_SET_JSON below.
        // Framework Phase 5 (spec §12): the origin-side half of the cross-chain relay.
        // On LTC/DOGE _computeResponsibleSet returns [] by construction (attestation
        // stake is BTC-only), and ATTEST_ADMISSION is already satisfied there on local
        // height, so today EVERY off-BTC request is rejected at admission. At/above
        // ATTEST_RELAY_ORIGIN such a request is instead admitted 'pending' and stamped
        // with its origin chain, which is what makes it visible to the hub's relay
        // driver; the driver materializes it onto BTC as a v3, where it gets a real BTC
        // block_index and a real responsible set. Nothing else about admission moves:
        // every other validation above still rejects, and on BTC this is a no-op
        // (relayOrigin is false there, and a BTC responsible set is never empty by
        // construction). Gated on block TIME, not height, because the rule must flip on
        // LTC and DOGE whose local heights sit millions of blocks above any BTC-derived
        // threshold; see the ATTEST_RELAY_ORIGIN note in protocol_changes.js.
        let relayOrigin = false;
        if(!error && this.config['COIN'] !== HOME_CHAIN)
            relayOrigin = await this.actions.protocolChanges.isEnabled('ATTEST_RELAY_ORIGIN', data['BLOCK_INDEX']);

        let admissionSet = null;
        // LOCAL-HEIGHT plane: BLOCK_INDEX is this request's height on
        // its own chain, which is what this gate is defined against. It is deliberately
        // NOT the BTC-anchored plane the stake_weighted_quorum / price_sig_tally gates
        // use; see attest_admission_activation.js for why the two differ and why the
        // difference must not be "corrected" without its own flag-day.
        if(!error && !relayOrigin && attestAdmission.isAttestAdmissionActive(data['BLOCK_INDEX'], this.config['NETWORK'])){
            admissionSet = await this._computeResponsibleSet(
                String(data['REQUEST_ID'] || '').toLowerCase(), data['REDUNDANCY'], data['BLOCK_INDEX'], data['PROVIDER_ID']);
            let neededSlots = Math.max(1, Number(data['REDUNDANCY']) || 1);
            if(admissionSet.length < neededSlots)
                error = 'invalid: REDUNDANCY (responsible set ' + admissionSet.length + ' < ' + neededSlots + ' at request block)';
        }

        // Framework spec §11.1 per-block admission caps (flag-day gated). An admitted
        // request obliges REDUNDANCY validators to make a provider call, which for the
        // `llm` provider is a real invoice on each operator's own vendor account, while
        // the requester pays the same flat VM_ATTEST_REQUEST gas either way. Fees bound
        // that on a fee-bearing network; on testnet nothing is scarce, so the bound has
        // to be this rule. Rejection rather than deferral, because the action is already
        // in this block and there is no later block to carry it to - see the semantics
        // note in attest_request_cap_activation.js.
        //
        // Checked LAST among the admission rules, and only for an otherwise-valid
        // request, so a structurally invalid one never consumes a capped slot. Same
        // LOCAL-HEIGHT plane as the responsible-set gate directly above.
        if(!error && attestRequestCap.isAttestRequestCapActive(data['BLOCK_INDEX'], this.config['NETWORK'])){
            let caps   = attestRequestCap.ATTEST_REQUEST_CAPS;
            let counts = await this.indexerDb.getAttestationAdmissionCounts(
                data['BLOCK_INDEX'], data['ACTION_INDEX'], data['CONTRACT_INDEX']);
            if(counts.byContract >= caps.perContract)
                error = 'invalid: ATTEST cap (contract already has ' + counts.byContract +
                        ' request(s) this block, max ' + caps.perContract + ')';
            else if(counts.total >= caps.perBlock)
                error = 'invalid: ATTEST cap (block already has ' + counts.total +
                        ' request(s), max ' + caps.perBlock + ')';
        }

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Terminal request-lifecycle status. A structurally invalid request is
        // recorded as 'rejected' (preserving the audit row) but NEVER enters the
        // 'pending' pool: the hub poll (getPendingAttestationRequests), the
        // deadline-expiry sweep (getExpiredAttestationRequests), and the v1
        // response path all key solely off request_status='pending', so a
        // 'rejected' row is invisible to every one of them. Without this branch a
        // protocol-rejected request (oversize payload, unknown provider, bad
        // deadline, insufficient fee funds, …) would be fetched, quorum-signed,
        // and fire a real callback EXECUTE exactly as if it had passed validation.
        // 'rejected' is terminal at creation (resolved_block stays NULL), so the
        // reorg-rollback reset, which only re-pends rows that went terminal via a
        // later block's flip (request_status IN ('fulfilled','errored','expired')
        // AND resolved_block >= reorg point), never promotes it back to pending.
        data['REQUEST_STATUS'] = (error) ? 'rejected' : 'pending';

        // Stamp the origin chain on an admitted relay-eligible request. This is
        // the ONLY marker the hub's relay poll keys on, and it is written only for a
        // row that actually reached 'pending', so a rejected request is never relayed.
        data['ORIGIN_CHAIN'] = (relayOrigin && data['REQUEST_STATUS'] === 'pending')
                             ? String(this.config['COIN']) : null;
        // Paired half of the same relay identity, on the IDENTICAL predicate. On an origin
        // v0 row "the origin chain's v0 action_index" is this row's own action_index, which
        // is what the response leg (ATTEST v4) and the BTC-side exactly-once guard correlate
        // on; writing only ORIGIN_CHAIN left the identity half-formed and the column NULL.
        // Sharing the predicate keeps the two columns inseparable: a rejected
        // or native request leaves BOTH NULL, exactly as the v3 handler sets BOTH together.
        data['ORIGIN_ACTION_INDEX'] = (relayOrigin && data['REQUEST_STATUS'] === 'pending')
                                    ? data['ACTION_INDEX'] : null;

        console.log("\t ATTEST v0 : id=" + (data['REQUEST_ID'] ? String(data['REQUEST_ID']).substring(0,16) + '...' : '?') +
                    ' : provider=' + data['PROVIDER_ID'] +
                    ' : contract=' + data['CONTRACT_INDEX'] +
                    ' : redundancy=' + data['REDUNDANCY'] +
                    ' : fee=' + (feePresent ? data['FEE_AMOUNT'] + ' ' + data['FEE_TICK'] : 'none') +
                    ' : ' + data['STATUS']);

        // ATT-RECOMP-1: pin the responsible set AS-OF this request's block so the reorg
        // missed_count recompute (rollback._recomputeAttestationValidatorStats) reads the
        // historical set verbatim rather than re-deriving it against the CURRENT mutable
        // stakes.amount (a later SURVIVING slash reduces it, so a bare re-derive charges
        // missed_count to the wrong set). Only a 'pending' request can ever expire and reach
        // the recompute; a 'rejected' row is invisible to the expiry sweep, so skip the stake
        // query for it. Uses the SAME _computeResponsibleSet the v1 verify + v2 expiry paths
        // use, evaluated at the request's own block_index (the set the recompute keys on).
        // (Reuses the admission-gate set when the gate already computed it.)
        if(data['REQUEST_STATUS'] === 'pending'){
            let responsibleSet = admissionSet !== null ? admissionSet : await this._computeResponsibleSet(
                String(data['REQUEST_ID'] || '').toLowerCase(), data['REDUNDANCY'], data['BLOCK_INDEX'], data['PROVIDER_ID']);
            data['RESPONSIBLE_SET_JSON'] = JSON.stringify(responsibleSet);
        }

        await this.indexerDb.createAttestationRequest(data);

        // Escrow the fee from FEE_PAYER (debit + escrow at this v0 action_index;
        // released to the REWARD pool on fulfillment, refunded on expiry/error).
        // Rollback safety is the generic path: escrows/debits delete by
        // action_index, and the request row resets via resolved_block.
        if(status === 'valid' && feePresent){
            let gas = this.config['GAS'];
            this.util.addAddressTicker(data['FEE_PAYER'], gas);
            let debits  = [[gas, data['FEE_AMOUNT'], data['FEE_PAYER']]];
            let escrows = [[gas, data['FEE_AMOUNT'], data['FEE_PAYER']]];
            await this.util.processTransactionLedgerChanges(this.indexerDb, data, [], debits, escrows);
            let tickers   = this.util.getTickersList(),
                addresses = Object.keys(this.util.getAddressesList());
            await this.indexerDb.updateBalances(addresses);
            await this.indexerDb.updateTokens(tickers);
        }

        await this.mapper.createMappings(data);
    }

    // ATTEST v1: Response (validator broadcast)
    async _parseResponse(params, data, error){

        // Extract fixed-position fields. RESPONSE_PAYLOAD travels as base64
        // (binary-safe, no embedded `|` chars). We decode to bytes for
        // signature verification (must hash the same bytes the hub signed)
        // and to UTF-8 text for storage + callback delivery.
        let requestId          = params[1];
        let providerId         = params[2];
        let responsePayloadB64 = String(params[3] || '');
        let responseBodyBytes;
        try { responseBodyBytes = Buffer.from(responsePayloadB64, 'base64'); }
        catch(_)            { responseBodyBytes = Buffer.alloc(0); }
        let responsePayload    = responseBodyBytes.toString('utf8');
        let responseStatus     = params[4];
        let meta               = params[5];

        if(!error && (!requestId || !/^[0-9a-fA-F]{64}$/.test(String(requestId))))
            error = 'invalid: REQUEST_ID (format)';
        if(!error && this.util.isNull(providerId))
            error = 'invalid: PROVIDER_ID (required)';
        let allowedStatuses = ['ok', 'timeout', 'no_quorum', 'provider_error', 'expired'];
        if(!error && allowedStatuses.indexOf(String(responseStatus)) === -1)
            error = 'invalid: STATUS (unknown)';

        // Normalize the id for every non-consensus use (request lookup, responsible-set
        // hash, the stored row): the hub signs the LOWERCASE rid
        // (AttestationConsensus._buildCanonical) and the only live producer lowercases
        // before broadcast. The CANONICAL signing bytes themselves are the exception:
        // whether they use the raw wire case or the lowercased id is CONSENSUS
        // BEHAVIOUR. Legacy nodes build the canonical from the RAW wire id,
        // so a case-mutated replay of a pending v1 fails signature verification there;
        // lowercasing ungated would make the same wire bytes verify on an upgraded
        // node and fork the fleet. The raw id is therefore kept for the canonical
        // below the ATTEST_CANONICAL_LOWERCASE_ID flag-day and the lowercased id used
        // at/after it (making the byte-identity with the hub self-contained instead of
        // resting on the producer invariant).
        let requestIdRaw = (requestId == null) ? requestId : String(requestId);
        if(requestId != null) requestId = String(requestId).toLowerCase();

        // Parse variable-length sig list
        let sigCount, sigs = [];
        if(!error){
            try {
                sigCount = parseInt(params[6]);
                if(!Number.isFinite(sigCount) || sigCount < 1)
                    throw new Error('invalid SIG_COUNT');
                for(let i = 0; i < sigCount; i++){
                    let pubkey = params[7 + 2 * i];
                    let sig    = params[7 + 2 * i + 1];
                    if(!pubkey || !sig) throw new Error('missing sig data at index ' + i);
                    if(!/^[0-9a-fA-F]{64}$/.test(pubkey))  throw new Error('invalid pubkey format at index ' + i);
                    if(!/^[0-9a-fA-F]{128}$/.test(sig))    throw new Error('invalid sig format at index ' + i);
                    sigs.push({ pubkey: pubkey.toLowerCase(), sig: sig.toLowerCase() });
                }
            } catch(e){
                if(!error) error = 'invalid: ' + e.message;
            }
        }

        // Look up the original request
        let request = null;
        if(!error){
            request = await this.indexerDb.getAttestationRequestById(requestId);
            if(!request){
                error = 'invalid: REQUEST_ID (no matching request)';
            } else if(request.request_status !== 'pending'){
                error = 'invalid: REQUEST already ' + request.request_status;
            } else if(request.provider_id !== String(providerId)){
                error = 'invalid: PROVIDER_ID does not match request';
            } else if(parseInt(data['BLOCK_INDEX']) > parseInt(request.deadline_block)){
                error = 'invalid: REQUEST expired (deadline_block=' + request.deadline_block + ')';
            }
        }

        // The DECLARED height of this round: the REQUEST's block, deterministic from the
        // request_id every signer keyed on. Two different things are derived from it and
        // they must not be conflated.
        //
        // 1. The flag-day inputs (EQUIV header below) are evaluated on the DECLARED height,
        //    verbatim. Shifting a flag-day boundary by the reorg buffer would move the
        //    cutover block itself, which is its own fork.
        // 2. The height the capability set is RESOLVED at is the declared height BURIED by
        //    the canonical reorg buffer, because that is what the hub actually resolved at:
        //    CapabilitySnapshot subtracts CANONICAL_REORG_BUFFER from every height it is
        //    handed (_buriedBlockIndex) while AttestationRound passes the raw
        //    request.block_index, so the responsible set the hub signed is the set at
        //    (declared - 6). Verifying at the raw height resolved a DIFFERENT set whenever a
        //    validator's stake activated or deactivated inside (declared - 6, declared],
        //    which rejects a correct deterministic response or stalls the round. Gated:
        //    below the flag-day this is the declared height unchanged, so pre-flag-day
        //    acceptance is byte-preserved.
        let declaredBlock = request ? Number(request.block_index) : Number(data['BLOCK_INDEX']);
        let snapshotBlock = srb.buriedSnapshotBlock(declaredBlock, this.config['NETWORK']);

        // Build canonical signing message (UTF-8 Buffer). At/above the EQUIV flag-day
        // (WI-2 bump 2) the raw string is wrapped in the uniform header (TAG=XATTEST,
        // ROUND_ID=request_id, VIEW=0, no view change), gated on the request's block +
        // network; below it, the bare bytes. Byte-matches AttestationConsensus._buildCanonical.
        let responseHash = crypto.createHash('sha256').update(responseBodyBytes).digest('hex');
        // The id case inside the canonical is gated (see the normalization
        // note above). Raw wire bytes below the flag-day (byte-identical to legacy
        // verification), lowercased at/after it.
        let canonId      = (await this.actions.protocolChanges.isEnabled('ATTEST_CANONICAL_LOWERCASE_ID', data['BLOCK_INDEX']))
                         ? String(requestId) : String(requestIdRaw);
        let canonRaw     = canonId + String(providerId) + responseHash + String(responseStatus) + String(meta || '');
        if(eq.isEquivHeaderActive(declaredBlock, this.config['NETWORK']))
            canonRaw = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, canonId, 0, canonRaw);
        let canonical    = Buffer.from(canonRaw, 'utf8');
        let validSigs    = 0;
        let verifiedSigs = [];
        if(!error){
            // Resolve the attestation-eligible set ONCE (hasCapability is ~5 sequential
            // queries per signer), from the SAME derivation the responsible-set filter
            // below uses. The two MUST agree on eligibility or a responsible signer is
            // discarded here, before it is ever counted.
            //
            // At/above STAKE_WEIGHTED_QUORUM _computeResponsibleSet selects
            // getStakeWeightsByCapability, whose _stakeWeightsSql qualifies a staking
            // SOURCE on its aggregate and then emits ALL of that source's effective keys,
            // while getValidatorsByCapability / hasCapability qualify each PUBKEY on its
            // own aggregate (_effectiveCapabilitySetSql GROUP BY ip.pubkey HAVING, whose
            // only widening branch is a `delegations` row). A source clearing MIN_STAKE
            // only in aggregate across sub-threshold stake keys is therefore IN the
            // weighted responsible set and OUT of the pubkey-aggregate set, so its valid
            // signatures were dropped here and validSigs could never reach redundancy:
            // the responsible set is exactly REDUNDANCY keys, so losing even one made the
            // request permanently unfulfillable while every retry burned a real fee and
            // expiry charged missed_count to the whole set, honest signers included.
            //
            // Selecting the weighted query here widens eligibility only UP TO the weighted
            // set, and the responsible filter below is derived from that same query at
            // this same block, so it still clips acceptance to the deterministic
            // top-REDUNDANCY selection: no coalition that was not already responsible can
            // land a response. Gated exactly as _computeResponsibleSet is, and for its
            // reasons: BTC ONLY, because the SWQ anchor is a BTC height and evaluating it
            // against an LTC/DOGE local height resolves TRUE out of band; and on the
            // DECLARED height, because moving a flag-day boundary by the reorg buffer is
            // its own fork. `snapshotBlock` is ALREADY the buried resolve height (see the
            // note above), so it must NOT be buried a second time here.
            let weighted    = (this.config['COIN'] === 'BTC')
                           && swq.isStakeWeightedQuorumActive(declaredBlock, this.config['NETWORK']);
            let capableRows = weighted
                            ? await this.indexerDb.getStakeWeightsByCapability('attestation', snapshotBlock)
                            : await this.indexerDb.getValidatorsByCapability('attestation', snapshotBlock);
            // A truncated read has silently-dropped rows. Below the gate, fall back
            // per-signer to hasCapability rather than drop a capable co-signer: that probe
            // is the same pubkey aggregate the unweighted set is built from, so the two
            // still agree. On the weighted branch there is NO per-signer equivalent -
            // hasCapability sums WHERE s.signing_pubkey_id = ?, the pubkey aggregate
            // again, so falling back to it would reinstate this exact bug on precisely the
            // truncated read where the federation is largest. Take the truncated rows as
            // they stand instead: _computeResponsibleSet resolves the responsible set from
            // the SAME truncated read at the same block, so eligibility still covers it and
            // the responsible filter stays the binding gate.
            let capableSet  = (!weighted && capableRows && capableRows.truncated === true)
                            ? null
                            : new Set((capableRows || []).map(v => String(v.pubkey).toLowerCase()));
            let seenPubkey = new Set();
            for(let s of sigs){
                if(seenPubkey.has(s.pubkey)) continue;
                seenPubkey.add(s.pubkey);
                if(capableSet
                    ? !capableSet.has(s.pubkey)
                    : !await this.indexerDb.hasCapability(s.pubkey, 'attestation', snapshotBlock))
                    continue;
                if(!ed25519.verify(canonical, s.sig, s.pubkey))
                    continue;
                verifiedSigs.push(s);
            }

            // Restrict the verified signers to the request's deterministic
            // responsible set (the top-REDUNDANCY validators ranked by
            // SHA256(request_id || pubkey), the same set _parseExpire charges
            // missed_count to. Holding the attestation capability and producing a
            // valid ed25519 signature is necessary but NOT sufficient: without
            // this gate any quorum of capable validators could assemble a valid
            // v1, so two different capable coalitions could each land a response
            // (first-lands-wins, non-deterministic) and fulfilled_count (credited
            // to whoever signed) would diverge from missed_count (charged to the
            // hash-selected set on expiry). Filtering here makes fulfillment
            // deterministic and keeps the two stat columns symmetric. (request is
            // guaranteed non-null inside this !error block; a null lookup sets
            // 'no matching request' above and skips the loop.)
            // DECLARED, not buried: _computeResponsibleSet takes the declared height and
            // buries it internally, so every site that computes this request's
            // responsible set (admission, the persisted RESPONSIBLE_SET_JSON, the expiry
            // missed_count charge, the fulfilled fee split, and here) resolves ONE set.
            let responsible = new Set(await this._computeResponsibleSet(
                requestId, request.redundancy, declaredBlock, request.provider_id
            ));
            verifiedSigs = verifiedSigs.filter(s => responsible.has(s.pubkey));
            validSigs    = verifiedSigs.length;

            // Quorum: only REDUNDANCY validators are responsible for fetching (spec §8.2)
            let redundancy = request ? Number(request.redundancy) : 0;
            if(validSigs < redundancy)
                error = 'invalid: insufficient valid signatures (' + validSigs + '/' + redundancy + ')';
        }

        // Stash for DB write
        data['REQUEST_ID']       = requestId;
        data['PROVIDER_ID']      = providerId;
        data['RESPONSE_PAYLOAD'] = responsePayload;
        data['RESPONSE_STATUS']  = responseStatus;
        data['META']             = meta;
        data['RESPONSE_HASH']    = responseHash;
        data['VALID_SIGS']       = validSigs;

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        // Inline the verified federation signatures as a JSON array on the response
        // row (consolidated `attests` table, no separate signatures table). Only
        // persisted for a valid response, mirroring the prior per-row behavior.
        data['VALIDATOR_SIGNATURES'] = (status === 'valid' && verifiedSigs.length)
            ? JSON.stringify(verifiedSigs.map(s => ({ pubkey: s.pubkey, sig: s.sig })))
            : null;

        console.log("\t ATTEST v1 : id=" + String(requestId).substring(0,16) + '...' +
                    ' : status=' + responseStatus +
                    ' : sigs=' + validSigs + '/' + (request ? request.redundancy : '?') +
                    ' : ' + data['STATUS']);

        // Persist response row (with verified sigs inlined as JSON)
        await this.indexerDb.createAttestationResponse(data);

        if(status === 'valid'){
            // Bump fulfilled_count for each signing validator (only on STATUS=='ok')
            if(String(responseStatus) === 'ok'){
                for(let s of verifiedSigs){
                    await this.indexerDb.incrementAttestationValidatorStat(
                        s.pubkey, String(providerId), 'fulfilled_count', data['BLOCK_INDEX']
                    );
                }
            }

            // Retryable response statuses leave the request OPEN. no_quorum means
            // the responsible set could not agree this round; timeout / provider_error
            // mean a fetch failed transiently. In all three cases another round may
            // still succeed before the deadline, so the request stays `pending`; the
            // deadline-expiry handler flips it to `expired` if no quorum is ever
            // reached. Only `ok` (fulfilled) or a genuinely terminal failure closes the
            // request and fires the callback. (allowedStatuses, see above, is
            // ['ok','timeout','no_quorum','provider_error','expired']; an explicit
            // `expired` response is terminal and maps to `errored`.)
            const RETRYABLE_STATUSES = new Set(['no_quorum', 'timeout', 'provider_error']);
            if(RETRYABLE_STATUSES.has(String(responseStatus))){
                console.log("\t ATTEST v1 : id=" + String(requestId).substring(0,16) + '...' +
                            ' : retryable status=' + responseStatus + ', request left pending for retry');
            } else {
                // Flip request status to its terminal value (resolved_block anchors
                // the flip for the reorg-rollback reset)
                let newRequestStatus = (responseStatus === 'ok') ? 'fulfilled' : 'errored';
                await this.indexerDb.updateAttestationRequestStatus(data['REQUEST_ID'], newRequestStatus, data['BLOCK_INDEX']);

                // Fee disposition (E1). Release/refund rows are written at THIS
                // v1 action_index, so a reorg of the v1 removes them generically
                // and the v0 escrow (earlier action_index) survives intact.
                await this._settleRequestFee(request, data, newRequestStatus);

                // A relay-materialized request (v3) carries the ORIGIN chain it
                // came from. Its contract lives there, not here, so BTC must not try to
                // execute a callback against a contract_index that means nothing locally.
                // The response relays back as a v4 instead and the origin chain fires the
                // callback. Self-gating: only a v3, which is itself flag-day gated, can
                // produce a row whose origin_chain differs from this coin, so no separate
                // activation check is needed and pre-activation replay is untouched.
                if(this._isForeignOrigin(request)){
                    console.log("\t ATTEST v1 : id=" + String(requestId).substring(0,16) + '...' +
                                ' : origin=' + request.origin_chain + ', callback deferred to the relay leg');
                    await this.mapper.createMappings(data);
                    return;
                }

                // Inject the callback EXECUTE. Wrapped in a savepoint so a failing callback
                // does NOT roll back the response row.
                try {
                    let callbackActionIndex = await this._injectCallbackExecute(request, data);
                    if(callbackActionIndex)
                        await this.indexerDb.setAttestationResponseCallbackIndex(data['ACTION_INDEX'], callbackActionIndex);
                } catch(e){
                    // Infra faults (VM host down, DB driver errno) must halt the block
                    // rather than commit a locally-dropped callback that forks
                    // contract_hash against healthy peers (see faultGuard.js).
                    rethrowIfInfraFault(e);
                    console.warn('Attestation callback injection failed:', e);
                }
            }
        }

        await this.mapper.createMappings(data);
    }

    // ATTEST v2: Expire (system-synthesized)
    async _parseExpire(params, data, error){

        // System-synthesized only. The decoder accepts ATTEST in VALID_ACTION_NAMES but the
        // user-broadcast path can't legitimately produce v2; guard against accidental
        // synthesis from a user transaction.
        if(!data['IS_SYNTHETIC']){
            console.warn('\t ATTEST v2 : rejected (user-broadcast not allowed for synthetic expire)');
            data['STATUS'] = 'invalid: ATTEST v2 must be system-synthesized';
            return;
        }

        // Look up the request to expire. data['REQUEST_ID'] is set by
        // util.processAttestationExpirations from getExpiredAttestationRequests.
        let requestId = String(data['REQUEST_ID'] || '').toLowerCase();
        let request   = await this.indexerDb.getAttestationRequestById(requestId);

        // Bail if the request no longer exists or has already been resolved (race-protected).
        if(!request || request.request_status !== 'pending')
            return;

        // Synthesized actions arrive without an ACTION_INDEX; allocate one now
        // (mirrors order_expire.js). Without this, mapper.createMappings and the
        // injected callback's EMITTER reference both NULL out.
        data['ACTION_INDEX'] = await this.indexerDb.createActionIndex({
            ACTION:      'ATTEST',
            BLOCK_INDEX: data['BLOCK_INDEX'],
            FORMAT:      2
        }, true);

        data['STATUS'] = 'valid';

        console.log("\t ATTEST v2 : id=" + requestId.substring(0,16) + '...' +
                    ' : deadline=' + request.deadline_block +
                    ' : block=' + data['BLOCK_INDEX']);

        // Flip request status to 'expired' (resolved_block anchors the flip for the
        // reorg-rollback reset; without it a reorged expiry stayed terminal and
        // replay skipped re-synthesizing the v2 row)
        await this.indexerDb.updateAttestationRequestStatus(requestId, 'expired', data['BLOCK_INDEX']);

        // Refund the request fee (E1); never reached the responsible set's quorum.
        await this._settleRequestFee(request, data, 'expired');

        // Mark missed_count on each responsible validator (deterministic by SHA256(request_id || pubkey))
        try {
            let responsible = await this._computeResponsibleSet(
                requestId, request.redundancy, Number(request.block_index), request.provider_id
            );
            for(let pk of responsible){
                await this.indexerDb.incrementAttestationValidatorStat(
                    pk, String(request.provider_id), 'missed_count', data['BLOCK_INDEX']
                );
            }
        } catch(e){
            // This catch only absorbs older-schema gaps (missing table/column);
            // a driver-level fault (deadlock, lock-wait timeout) must halt the
            // block or this validator alone drops the stat rows (faultGuard.js).
            rethrowIfInfraFault(e);
            console.warn('Attestation expire: missed_count update failed:', e);
        }

        // Synthesize the callback EXECUTE so the contract can clean up (status='expired').
        // Skipped for a relay-materialized row on the home chain, whose contract
        // lives on the origin chain (see the same guard on the v1 path). The origin
        // chain's own copy of the request expires on its own deadline and fires the
        // contract's expired callback there.
        try {
            if(!this._isForeignOrigin(request))
                await this._injectExpiredCallback(request, data);
        } catch(e){
            // Same infra-fault gate as the response-path callback above (faultGuard.js).
            rethrowIfInfraFault(e);
            console.warn('Attestation expiry callback failed:', e);
        }

        await this.mapper.createMappings(data);
    }

    // Compute the responsible validator set for a given request (same deterministic rule
    // the hub uses (xchain-hub AttestationRound): sort capability validators by
    // SHA256(request_id || pubkey), take top REDUNDANCY.
    // STAKE_WEIGHTED_QUORUM: at/above activation, dedupe the selection by staking
    // source (one slot per source, keep each source's lowest-hash key) using the
    // source-keyed set; below activation, the legacy per-key selection. The
    // within-subset quorum stays count-based. CONSENSUS-CRITICAL: must match the
    // hub's AttestationRound._computeResponsibleSet byte-for-byte or validation forks.
    //
    // PROVIDER STAKE FLOOR: on the SAME weighted path, and only there, drop
    // staking sources whose aggregate weight is below the request provider's
    // block-anchored min_stake_xchain before selecting. `providerId` is therefore
    // REQUIRED at/above STAKE_WEIGHTED_QUORUM; omitting it fails closed to an empty
    // set. See _providerFloorFilter for why the floor rides the SWQ gate rather than
    // a new flag day, and providerMinStakeHistory.js for where the value comes from.
    async _computeResponsibleSet(requestId, redundancy, blockIndex, providerId){
        // The SWQ gate is BTC-ANCHORED, so only evaluate it where `blockIndex`
        // actually is a BTC height.
        //
        // isStakeWeightedQuorumActive() compares its argument against 961000, a BTC
        // height (~2026-08-04). `blockIndex` here is the ATTEST action's LOCAL height on
        // whatever chain this indexer runs, and ATTEST is registered on all three. LTC
        // and DOGE sit at ~3.16M and ~6.3M local, so `blockIndex >= 961000` is ALREADY
        // true there: a non-BTC indexer resolved `weighted` TRUE out of band, long
        // before the anchor, while the hub resolved it FALSE from a real BTC height
        // (xchain-hub AttestationRound polls the BTC indexer, so its block_index is
        // genuinely BTC). This function's own header requires byte-for-byte agreement
        // with that hub routine "or validation forks", and off BTC the two disagreed.
        //
        // Today the disagreement is LATENT, not exploitable: capability staking is
        // BTC-only and LTC/DOGE declare no STAKING.CAPABILITIES at all, so both the
        // weighted and unweighted lookups fall through to `if(!capConfig) return []`
        // and the responsible set is empty either way. It becomes a live fork the
        // moment `attestation` is configured off BTC, or the off-BTC redirect in
        // getStakeWeightsByCapability / getValidatorsByCapability (today scoped to
        // cross_chain and oracle_publish) is widened to cover it.
        //
        // So the fix is the plane, not the symptom: a non-BTC indexer has no
        // responsible set to compute and returns empty EXPLICITLY, without consulting
        // a gate it cannot evaluate correctly. Behaviour is unchanged at HEAD, which is
        // what makes it safe to ship ungated; the rebase replays it identically.
        if(this.config['COIN'] !== 'BTC')
            return [];
        // On BTC, `blockIndex` IS a BTC height, so the gate is on its intended plane
        // and flips at the anchor in lockstep with the hub.
        //
        // `blockIndex` is the DECLARED height (the request's block). Two different things
        // come off it, and the difference matters (see _parseResponse):
        //   - the STAKE_WEIGHTED_QUORUM flag-day is evaluated on the declared height,
        //     verbatim, because moving a cutover block by the reorg buffer is its own fork;
        //   - the set is RESOLVED at the declared height BURIED by CANONICAL_REORG_BUFFER,
        //     which is where the hub's CapabilitySnapshot resolved it (AttestationRound
        //     hands it the raw request.block_index and it subtracts the buffer). Resolving
        //     at the raw height selects a different responsible set than the hub whenever a
        //     validator's stake activates or deactivates inside (declared - 6, declared],
        //     which is exactly the byte-for-byte agreement this routine's header demands.
        // Burying HERE rather than at the call sites is deliberate: five paths compute this
        // request's responsible set (v0 admission, the persisted RESPONSIBLE_SET_JSON, the
        // v1 verify filter, the v2 expiry missed_count charge, the fulfilled fee split) and
        // they must resolve ONE set or the stat columns and the fee split desynchronize.
        // Flag-day gated, so below the gate this is the declared height unchanged.
        let weighted = swq.isStakeWeightedQuorumActive(blockIndex, this.config['NETWORK']);
        let resolveBlock = srb.buriedSnapshotBlock(blockIndex, this.config['NETWORK']);
        let validators = weighted
            ? await this.indexerDb.getStakeWeightsByCapability('attestation', resolveBlock)
            : await this.indexerDb.getValidatorsByCapability('attestation', resolveBlock);
        if(!validators || validators.length === 0) return [];
        // Provider floor, weighted path only. Applied BEFORE the hash ranking so the
        // slot the filter frees is filled by the next qualifying validator, exactly as
        // the hub does; every key of a source carries the source's aggregate weight, so
        // this removes whole sources and the source-dedupe below is unaffected by it.
        if(weighted){
            validators = this._providerFloorFilter(validators, providerId, blockIndex);
            if(validators.length === 0) return [];
        }
        let withHash = validators.map(v => {
            let pk = String(v.pubkey).toLowerCase();
            let h  = crypto.createHash('sha256').update(String(requestId), 'utf8').update(pk, 'utf8').digest('hex');
            return { pubkey: pk, source: (v.source != null ? String(v.source) : null), hash: h };
        });
        withHash.sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0));
        if(weighted){
            let seen = new Set();
            withHash = withHash.filter(v => {
                if(v.source === null) return true;
                if(seen.has(v.source)) return false;
                seen.add(v.source);
                return true;
            });
        }
        return withHash.slice(0, Math.max(1, Number(redundancy) || 1)).map(v => v.pubkey);
    }

    // Drop weighted-snapshot rows whose staking source does not clear the provider's
    // block-anchored min_stake_xchain floor at `blockIndex`. Returns [] when the floor
    // cannot be resolved (unknown/absent provider id, or an ATTESTATION.PROVIDERS
    // overlay entry with no floor), which fails the whole request closed.
    //
    // WHY THE SWQ GATE CARRIES THIS. The floor needs per-validator stake, and only the
    // weighted snapshot ({pubkey, source, weight}) carries the SOURCE-AGGREGATE amount
    // the floor is defined against; the unweighted rows are per-key and would price a
    // delegating source's stake once per key. Riding STAKE_WEIGHTED_QUORUM (mainnet
    // 961000, testnet/regtest 0) means the enforcement flips on an already-armed,
    // fleet-coordinated anchor, so no new flag-day height is minted and the hub, this
    // indexer, rollback's recompute and AttestationPublisher all start filtering on the
    // same block. Below the gate the capability threshold remains the only bar, which
    // is the pre-flag behaviour, so replay of historical blocks is bit-identical.
    //
    // The floor resolves at the DECLARED block (the raw `blockIndex`), not the buried
    // one: a governance activation height is a cutover, and burying a cutover is its own
    // fork, the same reasoning the SWQ gate itself is evaluated on the declared height.
    _providerFloorFilter(validators, providerId, blockIndex){
        let pid = (providerId === null || providerId === undefined) ? '' : String(providerId);
        let floor = pid ? this.providerRegistry.getMinStake(pid, blockIndex, this.config['NETWORK']) : null;
        if(floor === null){
            // Loud, because on a healthy federation this never happens: v0/v3 admission
            // already rejects an unknown PROVIDER_ID, so reaching here means either a
            // caller forgot the provider id or an operator overlay stripped the floor.
            console.warn('Attestation responsible set: no provider stake floor for "' + pid +
                         '" at block ' + blockIndex + '; failing closed (empty responsible set)');
            return [];
        }
        return validators.filter(v => pmsh.meetsProviderFloor(v && v.weight, floor));
    }

    // Cross-chain relay (spec §12, framework Phase 5)

    // True when `request` is one leg of a relay whose contract lives on ANOTHER
    // chain, i.e. the BTC row a v3 materialized. The callback paths consult this
    // because executing a callback against a foreign contract_index is meaningless
    // locally. A native request has origin_chain NULL; an origin-side relay row has
    // origin_chain equal to this coin, so both answer false.
    _isForeignOrigin(request){
        let origin = request && request.origin_chain;
        return Boolean(origin) && String(origin) !== String(this.config['COIN']);
    }

    _sha256(s){
        return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
    }

    // Canonical signing string for the relay REQUEST leg (v3). MUST byte-match the
    // hub's relay driver. Same construction rules as the XCALL dispatch canonical
    // (xexec.js::_canonical): pipe-joined fixed field order, the free-form payload
    // folded in as a hash rather than inline, and the EQUIV uniform header wrapped
    // around it at/above the flag-day. ROUND_ID folds the phase in so the request
    // and response legs of one request_id can never collide in the equivocation
    // detector's key space.
    _relayRequestCanonical(f){
        let raw = [
            'ATTEST', 'RELAY_REQUEST', String(f.requestId), String(f.snapshotBlock), String(f.network),
            String(f.originChain), String(f.originActionIndex), String(f.providerId),
            this._sha256(f.requestPayload == null ? '' : f.requestPayload),
            String(f.redundancy), String(f.deadlineBlocks)
        ].join('|');
        if(eq.isEquivHeaderActive(f.snapshotBlock, f.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST,
                this._sha256('ATTESTRELAY|request|' + String(f.requestId)), 0, raw);
        return raw;
    }

    // Canonical signing string for the relay RESPONSE leg (v4). See the request
    // canonical above; the response body is folded in as its sha256 so the signed
    // bytes stay bounded no matter how large the attested payload is, exactly as
    // the v1 canonical does.
    _relayResponseCanonical(f){
        let raw = [
            'ATTEST', 'RELAY_RESPONSE', String(f.requestId), String(f.snapshotBlock), String(f.network),
            String(f.originChain), String(f.homeResponseActionIndex), String(f.providerId),
            String(f.responseHash), String(f.status), String(f.meta == null ? '' : f.meta)
        ].join('|');
        if(eq.isEquivHeaderActive(f.snapshotBlock, f.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST,
                this._sha256('ATTESTRELAY|response|' + String(f.requestId)), 0, raw);
        return raw;
    }

    // Parse the trailing SIG_COUNT|PUBKEY|SIG|... tail both relay legs share.
    // Returns null on any structural fault so the caller can reject the action
    // rather than silently proceed with a short signature list.
    _parseRelaySigs(params, offset){
        let count = parseInt(params[offset]);
        if(!Number.isFinite(count) || count < 1) return null;
        let sigs = [];
        for(let i = 0; i < count; i++){
            let pubkey = params[offset + 1 + 2 * i];
            let sig    = params[offset + 1 + 2 * i + 1];
            if(!pubkey || !sig) return null;
            if(!/^[0-9a-fA-F]{64}$/.test(pubkey))  return null;
            if(!/^[0-9a-fA-F]{128}$/.test(sig))    return null;
            sigs.push({ pubkey: String(pubkey).toLowerCase(), sig: String(sig).toLowerCase() });
        }
        return sigs;
    }

    // Verify the `cross_chain` federation quorum over a relay canonical, against the
    // capability snapshot pinned at the BTC-anchored `snapshotBlock`. Deliberately
    // byte-for-byte the same rule xexec.js applies to an XCALL dispatch, because both
    // are the same trust decision on the same rail: stake-weighted (source-deduped)
    // at/above STAKE_WEIGHTED_QUORUM, else the legacy 2f+1 signer count. Duplicate
    // pubkeys are marked seen only AFTER their signature verifies, so a
    // garbage-then-valid pair for one qualified validator cannot suppress the real
    // signature and under-count a quorate relay.
    async _verifyRelayQuorum(canonical, sigs, snapshotBlock, network){
        // Same declared-vs-resolved split as the v1 path above. The wire
        // carries the RAW snapshot_block, but AttestationRelay resolved its cross_chain
        // signer set through CapabilitySnapshot, which buries by CANONICAL_REORG_BUFFER,
        // so re-resolving at the raw height admits or drops any validator whose stake
        // moved inside the buried window. The weighted-quorum flag-day still keys on the
        // DECLARED height: shifting a cutover block by the buffer is its own fork.
        let resolveBlock = srb.buriedSnapshotBlock(snapshotBlock, network);
        let weighted   = swq.isStakeWeightedQuorumActive(snapshotBlock, network);
        let validators = weighted
            ? await this.indexerDb.getStakeWeightsByCapability('cross_chain', resolveBlock)
            : await this.indexerDb.getValidatorsByCapability('cross_chain', resolveBlock);
        let N = (validators && validators.length) ? validators.length : 0;
        if(N === 0)
            return { ok: false, detail: 'cross_chain snapshot empty at block ' + snapshotBlock };

        let snapPubkeys  = new Set(validators.map(v => String(v.pubkey).toLowerCase()));
        let validSigners = [], seen = new Set();
        for(let s of sigs){
            if(seen.has(s.pubkey)) continue;
            if(!snapPubkeys.has(s.pubkey)) continue;
            if(!ed25519.verify(canonical, s.sig, s.pubkey)) continue;
            seen.add(s.pubkey);
            validSigners.push(s.pubkey);
        }
        let met = weighted
            ? swq.meetsStakeThreshold(validators, validSigners)
            : (validSigners.length >= ((N <= 1) ? 1 : Math.max(2 * Math.floor((N - 1) / 3) + 1, Math.ceil((N + 1) / 2))));
        if(!met){
            return { ok: false, detail: weighted
                ? 'insufficient signer stake (' + validSigners.length + ' valid signers of ' + N + ' snapshot keys)'
                : 'insufficient valid signatures (' + validSigners.length + '/' + N + ')' };
        }
        return { ok: true, validSigners: validSigners };
    }

    // ATTEST v3: relay request (federation-broadcast on the home chain).
    //
    // Materializes an LTC/DOGE-origin request onto BTC. The row it writes is an
    // ordinary request row (version 0 in `attests`, the lifecycle table keyed on
    // request_id) carrying origin_chain/origin_action_index, so every existing
    // consumer works on it unchanged: the hub's pending poll finds it, the
    // responsible set resolves at THIS action's BTC block_index, the v1 response
    // path fulfills it, and the deadline sweep expires it. Only the callback is
    // suppressed (the contract is not on this chain); the response relays back
    // as a v4 instead.
    async _parseRelayRequest(params, data, error){

        // Home-chain-only leg. Written as a hard return rather than a stored
        // 'invalid' row so a v3 that strays onto an origin chain is treated exactly
        // as an unknown VERSION is: nothing persisted, nothing hashed.
        if(String(this.config['COIN']) !== HOME_CHAIN){
            console.warn("\t ATTEST v3 : rejected (relay requests materialize on " + HOME_CHAIN + " only)");
            return;
        }

        let snapshotBlock = parseInt(params[8]);

        // Flag-day gate, and it takes BOTH planes because the two answer different
        // questions and only one of them is shared with the rest of the federation.
        //
        // The landing block_index is what makes the leg inert before the flag day:
        // on the home chain it IS a BTC height and cannot be forged, so a v3 carrying
        // an invented future SNAPSHOT_BLOCK still persists nothing below activation,
        // byte-identical to how a node without relay support treats VERSION 3.
        //
        // The carried SNAPSHOT_BLOCK is what keeps this node on the same activation
        // predicate as everyone else. It is the ONLY plane the hub can gate on, since
        // the hub decides whether to co-sign and broadcast BEFORE the action has a
        // landing height at all (xchain-hub AttestationRelay._validateRowEnvelope and
        // the request-round gate), and it is the plane the v4 leg, the
        // isAttestRelayActive contract, and the SNAPSHOT_BLOCK field spec all name.
        // Without it the window landing >= activation > snapshot is accepted here and
        // refused by the hub, and the signer set it resolves quorum against is the
        // pre-activation one.
        //
        // A malformed or negative SNAPSHOT_BLOCK is deliberately NOT hard-returned
        // here: it keeps falling through to the stored 'invalid: SNAPSHOT_BLOCK'
        // verdict below, so this gate changes acceptance for exactly the divergent
        // case and is a strict no-op on any network whose threshold is 0.
        if(!attestRelay.isAttestRelayActive(data['BLOCK_INDEX'], this.config['NETWORK']))
            return;
        if(snapshotBlock >= 0 && !attestRelay.isAttestRelayActive(snapshotBlock, this.config['NETWORK']))
            return;

        let requestId      = String(params[1] || '').toLowerCase();
        let originChain    = String(params[2] || '');
        let originAction   = parseInt(params[3]);
        let providerId     = String(params[4] || '');
        let requestPayload = (params[5] == null) ? '' : String(params[5]);
        let redundancy     = parseInt(params[6]);
        let deadlineBlocks = parseInt(params[7]);

        if(!error && !/^[0-9a-f]{64}$/.test(requestId))
            error = 'invalid: REQUEST_ID (format)';
        if(!error && ALLOWED_ORIGIN_CHAINS.indexOf(originChain) === -1)
            error = 'invalid: ORIGIN_CHAIN (unknown)';
        if(!error && (!Number.isInteger(originAction) || originAction <= 0))
            error = 'invalid: ORIGIN_ACTION_INDEX (must be a positive integer)';
        if(!error && !this.providerRegistry.isKnown(providerId))
            error = 'invalid: PROVIDER_ID (unknown)';
        if(!error && !this.providerRegistry.isRedundancyAllowed(providerId, redundancy))
            error = 'invalid: REDUNDANCY (not allowed for provider)';
        if(!error && !this.providerRegistry.isPayloadSizeAllowed(providerId, Buffer.byteLength(requestPayload, 'utf8')))
            error = 'invalid: REQUEST_PAYLOAD (exceeds provider max)';

        let deadlineBlock = parseInt(data['BLOCK_INDEX']) + (Number.isFinite(deadlineBlocks) ? deadlineBlocks : 0);
        if(!error && !this.providerRegistry.isDeadlineAllowed(providerId, parseInt(data['BLOCK_INDEX']), deadlineBlock))
            error = 'invalid: DEADLINE (outside provider window)';

        // The snapshot the federation signed against must already exist at this
        // action's height. Without the upper bound a broadcaster could name a future
        // snapshot and have the quorum resolved against whatever the mirror holds
        // latest, which both defeats the flag-day and un-pins the signer set from the
        // block it was supposed to be frozen at.
        if(!error && (!Number.isFinite(snapshotBlock) || snapshotBlock < 0 || snapshotBlock > parseInt(data['BLOCK_INDEX'])))
            error = 'invalid: SNAPSHOT_BLOCK (must be a past or current block on this chain)';

        let sigs = error ? [] : this._parseRelaySigs(params, 9);
        if(!error && sigs === null)
            error = 'invalid: SIG_COUNT (malformed signature list)';

        // One request_id materializes exactly once. A duplicate v3 is rejected here
        // rather than deduped in the DB layer so the outcome is an explicit, stored
        // verdict every node reaches identically.
        if(!error && await this.indexerDb.getAttestationRequestById(requestId))
            error = 'invalid: REQUEST_ID (already present on this chain)';

        // ...and one RELAY IDENTITY materializes exactly once, which the check above does
        // NOT imply. request_id is SHA256 over the origin TX_HASH (attests.sql), so an
        // origin reorg deeper than the hub's confirmation depth that re-emits the same
        // origin action_index from a different transaction produces a DIFFERENT request_id,
        // clears the check above, and materializes a second BTC request that nothing on BTC
        // can retract. Rejecting the second is the conservative side of that
        // fork: the stranded origin request expires on its own deadline and refunds its
        // escrow, whereas a double materialization spends real BTC fees irreversibly.
        // Stored as an 'invalid' verdict rather than left to a DB constraint for the same
        // reason the request_id check is: a UNIQUE violation would THROW mid-block inside a
        // consensus indexer instead of producing the identical stored outcome on every node.
        if(!error && await this.indexerDb.getRelayRequestByOrigin(originChain, originAction))
            error = 'invalid: ORIGIN_ACTION_INDEX (relay identity already materialized on this chain)';

        if(!error){
            let canonical = this._relayRequestCanonical({
                requestId, snapshotBlock, network: this.config['NETWORK'],
                originChain, originActionIndex: originAction, providerId,
                requestPayload, redundancy, deadlineBlocks
            });
            let quorum = await this._verifyRelayQuorum(canonical, sigs, snapshotBlock, this.config['NETWORK']);
            if(!quorum.ok)
                error = 'invalid: cross_chain quorum (' + quorum.detail + ')';
        }

        data['REQUEST_ID']          = requestId;
        data['PROVIDER_ID']         = providerId;
        data['REQUEST_PAYLOAD']     = requestPayload;
        // The callback lives on the origin chain and never runs here, so these stay
        // off the home-chain wire and out of the home-chain row entirely.
        data['CALLBACK_METHOD']     = null;
        data['CALLBACK_PARAMS']     = null;
        data['REDUNDANCY']          = redundancy;
        data['DEADLINE_BLOCK']      = deadlineBlock;
        data['GAS_ESCROW']          = '0';
        // Feeless on the home chain: the requester's fee was escrowed on the origin
        // chain at its v0 and settles there. A fee_payer here would name an address
        // that never paid anything on this chain.
        data['FEE_PAYER']           = null;
        data['FEE_TICK']            = null;
        data['FEE_AMOUNT']          = null;
        data['CONTRACT_INDEX']      = null;
        data['ORIGIN_CHAIN']        = originChain;
        data['ORIGIN_ACTION_INDEX'] = originAction;

        data['STATUS']         = (error) ? error : 'valid';
        data['REQUEST_STATUS'] = (error) ? 'rejected' : 'pending';

        console.log("\t ATTEST v3 : id=" + requestId.substring(0,16) + '...' +
                    ' : origin=' + originChain + ':' + originAction +
                    ' : provider=' + providerId +
                    ' : redundancy=' + redundancy +
                    ' : snapshot=' + snapshotBlock +
                    ' : ' + data['STATUS']);

        // Pin the responsible set as-of THIS block, the same ATT-RECOMP-1 rule a
        // native v0 follows. This is the anchor the whole model exists to provide:
        // block_index here is a genuine BTC height, so the set (and the block-echo
        // determinism check that reads it back) resolves exactly as it would for a
        // natively emitted request.
        if(data['REQUEST_STATUS'] === 'pending'){
            let responsibleSet = await this._computeResponsibleSet(requestId, redundancy, data['BLOCK_INDEX'], providerId);
            data['RESPONSIBLE_SET_JSON'] = JSON.stringify(responsibleSet);
        }

        await this.indexerDb.createAttestationRequest(data);
        await this.mapper.createMappings(data);
    }

    // ATTEST v4: relay response (federation-broadcast on the origin chain).
    //
    // Carries the home chain's fulfilled v1 back to the chain the request was
    // emitted on. The origin indexer verifies the SAME cross_chain quorum rail the
    // XCALL result leg uses, against the BTC-anchored snapshot, then closes its own
    // pending request and fires the contract callback.
    async _parseRelayResponse(params, data, error){

        // Never valid on the home chain: a home-chain request is fulfilled by a v1
        // in place and has nothing to relay to itself.
        if(String(this.config['COIN']) === HOME_CHAIN){
            console.warn("\t ATTEST v4 : rejected (relay responses land on origin chains only)");
            return;
        }

        let requestId       = String(params[1] || '').toLowerCase();
        let homeResponseIdx = parseInt(params[2]);
        let payloadB64      = String(params[3] || '');
        let responseStatus  = String(params[4] || '');
        let meta            = (params[5] == null) ? '' : String(params[5]);
        let snapshotBlock   = parseInt(params[6]);

        // Flag-day gate. The origin chain has no BTC height of its own, so the gate is
        // evaluated on the BTC-anchored SNAPSHOT_BLOCK the canonical carries, NOT on
        // where this action landed: a BTC-derived threshold compared against an LTC or
        // DOGE local height is already satisfied there and would ship the leg live
        // instead of inert (the ATTEST_ADMISSION plane trap). A broadcaster cannot use
        // that to jump the gate: the same value pins the signer set, so a forged
        // SNAPSHOT_BLOCK has to be signed by a quorum of the real cross_chain
        // federation, and the matching origin request only exists at all once
        // ATTEST_RELAY_ORIGIN has admitted it.
        if(!Number.isFinite(snapshotBlock) ||
           !attestRelay.isAttestRelayActive(snapshotBlock, this.config['NETWORK']))
            return;

        if(!error && !/^[0-9a-f]{64}$/.test(requestId))
            error = 'invalid: REQUEST_ID (format)';
        if(!error && (!Number.isInteger(homeResponseIdx) || homeResponseIdx <= 0))
            error = 'invalid: HOME_RESPONSE_ACTION_INDEX (must be a positive integer)';

        // Only the two TERMINAL outcomes relay. The retryable statuses
        // (no_quorum / timeout / provider_error) leave the home-chain request pending
        // for another round, so relaying one would close an origin request the home
        // chain still intends to fulfill.
        let allowedStatuses = ['ok', 'expired'];
        if(!error && allowedStatuses.indexOf(responseStatus) === -1)
            error = 'invalid: STATUS (not a terminal relay status)';

        let responseBodyBytes;
        try { responseBodyBytes = Buffer.from(payloadB64, 'base64'); }
        catch(_){ responseBodyBytes = Buffer.alloc(0); }
        let responsePayload = responseBodyBytes.toString('utf8');
        let responseHash    = crypto.createHash('sha256').update(responseBodyBytes).digest('hex');

        let sigs = error ? [] : this._parseRelaySigs(params, 7);
        if(!error && sigs === null)
            error = 'invalid: SIG_COUNT (malformed signature list)';

        // The local request must be one this chain admitted for relay and has not
        // already closed. A native (non-relay) request is NOT relay-closable: it never
        // left this chain, so a v4 naming it is either a mistake or an attempt to close
        // a request the federation was never asked to service.
        let request = null;
        if(!error){
            request = await this.indexerDb.getAttestationRequestById(requestId);
            if(!request)
                error = 'invalid: REQUEST_ID (no matching request)';
            else if(String(request.origin_chain || '') !== String(this.config['COIN']))
                error = 'invalid: REQUEST is not relay-eligible on this chain';
            else if(request.request_status !== 'pending')
                error = 'invalid: REQUEST already ' + request.request_status;
        }

        if(!error){
            let canonical = this._relayResponseCanonical({
                requestId, snapshotBlock, network: this.config['NETWORK'],
                originChain: String(this.config['COIN']),
                homeResponseActionIndex: homeResponseIdx,
                providerId: String(request.provider_id), responseHash,
                status: responseStatus, meta
            });
            let quorum = await this._verifyRelayQuorum(canonical, sigs, snapshotBlock, this.config['NETWORK']);
            if(!quorum.ok)
                error = 'invalid: cross_chain quorum (' + quorum.detail + ')';
        }

        data['REQUEST_ID']       = requestId;
        // attests.provider_id is NOT NULL, and a v4 does not carry the provider on the
        // wire (the request row owns it). A rejected v4 with no matching request has no
        // provider to name, so it stores the empty string rather than failing the INSERT
        // and losing the audit row.
        data['PROVIDER_ID']      = request ? String(request.provider_id) : '';
        data['RESPONSE_PAYLOAD'] = responsePayload;
        data['RESPONSE_STATUS']  = responseStatus;
        data['META']             = meta;
        data['RESPONSE_HASH']    = responseHash;
        data['VALID_SIGS']       = 0;
        data['STATUS']           = (error) ? error : 'valid';
        // The signatures on this row are cross_chain relay signatures, not the
        // attestation quorum that produced the body. That quorum is recorded on the
        // home chain's v1 row, which homeResponseIdx names; inlining them here would
        // invite a reader to mistake one for the other.
        data['VALIDATOR_SIGNATURES'] = null;

        console.log("\t ATTEST v4 : id=" + requestId.substring(0,16) + '...' +
                    ' : home_response=' + homeResponseIdx +
                    ' : status=' + responseStatus +
                    ' : snapshot=' + snapshotBlock +
                    ' : ' + data['STATUS']);

        await this.indexerDb.createAttestationResponse(data);

        if(data['STATUS'] === 'valid'){
            let newRequestStatus = (responseStatus === 'ok') ? 'fulfilled' : 'errored';
            await this.indexerDb.updateAttestationRequestStatus(requestId, newRequestStatus, data['BLOCK_INDEX']);

            // Settle the fee the origin v0 escrowed, on the same terms a local
            // fulfillment would. The responsible set it splits to is the ORIGIN row's,
            // which is empty off BTC, so the fee lands in the REWARD pool and no
            // per-validator reward row is written; paying the BTC-staked validators
            // out of an origin-chain pool is future economics work, not something
            // this relay leg needs to solve.
            await this._settleRequestFee(request, data, newRequestStatus);

            // Fire the contract callback here, on the chain the contract lives on.
            // Same savepoint discipline as the v1 path: a failing callback must not
            // roll back the response row.
            try {
                let callbackActionIndex = await this._injectRelayCallback(request, data);
                if(callbackActionIndex)
                    await this.indexerDb.setAttestationResponseCallbackIndex(data['ACTION_INDEX'], callbackActionIndex);
            } catch(e){
                rethrowIfInfraFault(e);
                console.warn('Attestation relay callback injection failed:', e);
            }
        }

        await this.mapper.createMappings(data);
    }

    // Inject the contract callback for a relayed response. The 'ok' path is the v1
    // callback verbatim; a relayed 'expired' delivers the same empty-payload shape
    // the local expiry path does, so a contract cannot tell whether its attestation
    // was serviced locally or across chains, which is the property that makes the
    // relay transparent to contract authors.
    async _injectRelayCallback(request, responseData){
        if(String(responseData['RESPONSE_STATUS']) === 'ok')
            return await this._injectCallbackExecute(request, responseData);
        return await this._injectExpiredCallback(request, responseData);
    }

    // Settle the request fee escrowed at v0 (E1 paid attestations). Runs at the
    // terminal flip and writes ledger rows at the SETTLING action's action_index
    // (the v1 response or the synthesized v2 expire), so a reorg of the settle
    // action removes them generically while the v0 escrow row survives.
    //   'fulfilled'          → escrow → REWARD pool + equal validator_rewards
    //                          split across the responsible set (floor to GAS
    //                          decimals; remainder dust stays in the pool;
    //                          COLLECT only ever pays what validator_rewards
    //                          reference, so the pool stays solvent). At/above
    //                          ATTEST_BROADCAST_FEE the spec §11 leader
    //                          broadcast-fee reimbursement is carved out FIRST
    //                          and the split runs on what is left; the pool
    //                          credit stays the FULL escrow either way, so the
    //                          solvency argument is unchanged (carve-out +
    //                          N*share <= escrow by construction, both floored
    //                          onto the same decimal grid).
    //   'errored'/'expired'  → escrow → refund to FEE_PAYER.
    // Feeless requests (fee_amount NULL/0) are a no-op.
    async _settleRequestFee(request, data, terminalStatus){
        let feeAmount = String((request && request.fee_amount) || '0');
        if(!this.util.bcgt(feeAmount, '0')) return;

        let gas      = this.config['GAS'];
        let feePayer = String(request.fee_payer || '');
        if(!feePayer){
            console.warn('Attestation fee settle: missing fee_payer for request ' + String(request.request_id).substring(0,16) + '..., fee left in escrow');
            return;
        }

        // Release the escrow held against FEE_PAYER (negative escrow row, the
        // order_expire idiom) and route the funds per the terminal status.
        let escrows = [[gas, this.util.bcmul(feeAmount, '-1', 8), feePayer]];
        let credits = [];
        this.util.addAddressTicker(feePayer, gas);

        if(terminalStatus === 'fulfilled'){
            let rewardPool = this.config['ADDRESS']['REWARD'];
            this.util.addAddressTicker(rewardPool, gas);
            credits.push([gas, feeAmount, rewardPool]);

            let responsible = await this._computeResponsibleSet(
                String(request.request_id), request.redundancy, Number(request.block_index), request.provider_id
            );
            let broadcastFee = '0';
            if(responsible.length > 0){
                // Equal split, floored to GAS decimals (feeCap = min(8, gasDecimals)),
                // matching the precision cap applied at parse time (line 146). Deterministic
                // across validators (bcmulfloor exists for exactly this concern).
                let gasDecimals = await this.indexerDb.getTokenDecimalPrecision(
                    await this.indexerDb.getTickerId(gas)
                );
                let feeCap = Math.min(8, gasDecimals);

                // §11 leader broadcast-fee reimbursement, flag-day gated. Carved out of the
                // escrow BEFORE the split, because it reimburses a cost the broadcaster
                // already paid a miner rather than rewarding the work the split pays for.
                // Below the gate it is '0' and the split sees the whole fee, byte-identically
                // to the pre-flag-day ledger. See attest_broadcast_fee_activation.js.
                broadcastFee = await this._broadcastFeeReimbursement(request, data, responsible, feeAmount, feeCap);
                // Below the gate (and on any request that reimburses nothing) the escrow is
                // handed to the split UNTOUCHED rather than round-tripped through bcsub: a
                // parse-valid FEE_AMOUNT already sits on the feeCap grid, but bcsub renders at
                // fixed precision and therefore ROUNDS, so keeping the legacy path arithmetic-
                // free is what makes "byte-identical below the flag-day" true by construction
                // instead of by argument. Above the gate both operands are on that same grid,
                // so the subtraction is exact and the pool stays solvent.
                let splitPool = feeAmount;

                if(this.util.bcgt(broadcastFee, '0')){
                    splitPool = this.util.bcsub(feeAmount, broadcastFee, feeCap);
                    // The broadcaster is a responsible-set member, so it collects this row
                    // ON TOP of its equal share below ("additionally receives", spec §11).
                    // A distinct reward_type keeps the two rows apart under the
                    // (source, pubkey, type, round_reference) unique key.
                    await this.indexerDb.createValidatorReward(
                        responsible[0], Number(request.action_index), 'attest_bcast', broadcastFee, data['BLOCK_INDEX'], true
                    );
                }

                let perValidator = this.util.bcmulfloor(
                    this.util.bcdiv(splitPool, String(responsible.length), 18), '1', feeCap
                );
                if(this.util.bcgt(perValidator, '0')){
                    for(let pk of responsible){
                        // round_reference is BIGINT; key idempotency on the
                        // REQUEST's action_index (unique per request), not the
                        // 64-hex request_id.
                        await this.indexerDb.createValidatorReward(
                            pk, Number(request.action_index), 'attest_fee', perValidator, data['BLOCK_INDEX'], true
                        );
                    }
                }
            }
            console.log("\t ATTEST fee : " + feeAmount + ' ' + gas + ' → REWARD pool, split ' +
                        responsible.length + ' way(s)' +
                        (this.util.bcgt(broadcastFee, '0') ? ', broadcast reimbursement ' + broadcastFee : '') +
                        ' [request ' + String(request.request_id).substring(0,16) + '...]');
        } else {
            // errored / expired: service not rendered, refund the payer
            credits.push([gas, feeAmount, feePayer]);
            console.log("\t ATTEST fee : " + feeAmount + ' ' + gas + ' refunded to FEE_PAYER (' + terminalStatus + ')' +
                        ' [request ' + String(request.request_id).substring(0,16) + '...]');
        }

        await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, [], escrows);
        let tickers   = this.util.getTickersList(),
            addresses = Object.keys(this.util.getAddressesList());
        await this.indexerDb.updateBalances(addresses);
        await this.indexerDb.updateTokens(tickers);
    }

    // The XCHAIN-denominated broadcast-fee reimbursement owed to the leader for this
    // fulfilled settle (spec §11), or '0' when the flag-day has not armed, no price is
    // available, or the escrow cannot cover a positive amount. Never throws and never
    // fails a settle: every unusable input resolves to '0' and the legacy full-escrow
    // split runs unchanged.
    //
    // The three pinned decisions this implements (denomination, broadcaster identity,
    // amount bound) and why each is shaped the way it is live in
    // attest_broadcast_fee_activation.js; only the mechanics are here.
    //
    //   `data`        the SETTLING action (v1 response or v4 relay response). Its
    //                 BLOCK_INDEX/BLOCK_TIME anchor both the flag-day test and the
    //                 oracle read, so the conversion is pinned to a block every node
    //                 replays identically rather than to wall-clock time.
    //   `responsible` the request's responsible set, already hash-sorted, so element 0
    //                 IS the lowest-hash member. Callers pass the SAME set the split
    //                 uses; re-deriving it here could not diverge but would double the
    //                 stake query on every fulfilled settle.
    //   `feeCap`      GAS decimals cap, min(8, gasDecimals). The reimbursement is
    //                 floored onto the same decimal grid the split uses, so
    //                 reimbursement + N*share can never exceed the escrow by a ULP.
    async _broadcastFeeReimbursement(request, data, responsible, feeAmount, feeCap){
        if(!responsible || responsible.length === 0) return '0';
        if(!attestBcastFee.isAttestBroadcastFeeActive(data['BLOCK_INDEX'], this.config['NETWORK']))
            return '0';

        let providerId  = String(request.provider_id || '');
        let capNative   = attestBcastFee.broadcastFeeCapNative(
            providerId, this.providerRegistry.getProvider(providerId));
        if(!this.util.bcgt(capNative, '0')) return '0';

        // Same block-gated, staleness-guarded oracle read the native-coin fee check runs
        // (utility.validateNativeCoinFee), anchored on the settle block's own height and
        // time. A missing or stale feed reimburses ZERO rather than wedging the settle:
        // see the ORACLE LIVENESS note in attest_broadcast_fee_activation.js.
        let maxPriceAgeSeconds = parseInt(this.config['ORACLE_MAX_PRICE_AGE_SECONDS']) || 1800;
        let prices;
        try {
            prices = await this.util.getFeeOraclePrices(
                this.indexerDb, this.config['COIN'], data['BLOCK_INDEX'], data['BLOCK_TIME'], maxPriceAgeSeconds);
        } catch(e){
            // An infra fault must still fail the block loudly; anything else is a
            // no-reimbursement, not a settle failure.
            rethrowIfInfraFault(e);
            console.warn('Attestation broadcast-fee reimbursement: oracle read failed, reimbursing 0:', e.message);
            return '0';
        }
        if(!prices || prices.error){
            console.warn('Attestation broadcast-fee reimbursement: ' +
                         ((prices && prices.error) || 'no prices') + '; reimbursing 0 [request ' +
                         String(request.request_id).substring(0,16) + '...]');
            return '0';
        }

        // native → XCHAIN at the settle block: cap * (COIN/USD) / (XCHAIN/USD), floored
        // onto the GAS decimal grid in one bignumber operation (bcmuldivfloor) so no
        // intermediate rounding can differ between nodes.
        let reimbursement = this.util.bcmuldivfloor(
            capNative, prices.coinUsdPrice, prices.xchainUsdPrice, feeCap);
        if(!this.util.bcgt(reimbursement, '0')) return '0';

        // Escrow is the hard ceiling. An author whose escrow is thinner than the
        // allowance reimburses what there is and the split gets nothing, which is the
        // §11 ordering: the broadcaster's out-of-pocket cost is settled before the
        // reward it is not owed.
        if(this.util.bcgt(reimbursement, feeAmount))
            reimbursement = this.util.bcmulfloor(feeAmount, '1', feeCap);
        return String(reimbursement);
    }

    // Synthesize an EXECUTE that runs the contract's callback method (v1 response path).
    async _injectCallbackExecute(request, responseData){
        if(!this.actions.actionExecute) return null;

        let callbackParams = [];
        if(request.callback_params_json){
            try {
                let parsed = JSON.parse(request.callback_params_json);
                if(Array.isArray(parsed)) callbackParams = parsed;
            } catch(e){
                console.warn('_injectCallbackExecute: malformed callback_params_json for request ' +
                             String(request.request_id).substring(0,16) + '..., using empty params:', e.message);
                callbackParams = [];
            }
        }

        // Callback signature: [request_id, provider_id, status, response_payload, ...originalCallbackParams]
        let callbackArgs = [
            request.request_id,
            request.provider_id,
            responseData['RESPONSE_STATUS'],
            responseData['RESPONSE_PAYLOAD'] || '',
            ...callbackParams.map(String)
        ];

        // Positional EXECUTE format: VERSION|CONTRACT_ACTION_INDEX|METHOD|PARAMS...
        let actionParams = [
            0,
            request.contract_index,
            request.callback_method,
            ...callbackArgs
        ];

        let chain = this.config['CHAIN'];
        let emissionActionIndex = await this.indexerDb.createActionIndex({
            ACTION:      'EXECUTE',
            BLOCK_INDEX: responseData['BLOCK_INDEX'],
            TX_INDEX:    responseData['TX_INDEX'],
            TX_VOUT:     responseData['TX_VOUT'],
            FORMAT:      0,
            SOURCE:      'C:' + chain + ':' + request.contract_index
        }, true);

        // SOURCE = contract address so xchain.getSourceAddress() === xchain.getContractAddress() (spec §4.3).
        // The v1 response rode a real broadcast tx, so its TX_HASH is passed through;
        // post-SYNTH_EXEC_TX_HASH the builder throws rather than let a hashless
        // context reach the VM.
        let synthActive = await this.actions.protocolChanges.isEnabled(SYNTH_EXEC_TX_HASH, responseData['BLOCK_INDEX']);
        let emissionData = buildInjectedExecContext({
            chain:         chain,
            network:       this.config['NETWORK'],
            contractIndex: request.contract_index,
            actionIndex:   emissionActionIndex,
            blockIndex:    responseData['BLOCK_INDEX'],
            blockTime:     responseData['BLOCK_TIME'],
            emitter:       responseData['ACTION_INDEX'],
            txHash:        responseData['TX_HASH'],
            includeTxHash: synthActive || Boolean(responseData['TX_HASH']),
            extra: {
                TX_INDEX: responseData['TX_INDEX'],
                TX_VOUT:  responseData['TX_VOUT']
            }
        });

        // Unique per injected callback: a fixed name would be destroyed and re-created
        // by MariaDB on re-use, corrupting rollback when EXECUTE nests its own savepoints
        // or multiple attestation callbacks fire in one block transaction.
        let savepoint = await this.indexerDb.createSavepoint('attestation_callback_' + parseInt(emissionActionIndex));
        try {
            await this.actions.actionExecute.parse(actionParams, emissionData, null);
            if(emissionData['STATUS'] && emissionData['STATUS'] !== 'valid'){
                console.warn('Attestation callback execute returned non-valid status: ' + emissionData['STATUS']);
            }
            await this.indexerDb.releaseSavepoint(savepoint);
            return emissionActionIndex;
        } catch(e){
            await this.indexerDb.rollbackToSavepoint(savepoint);
            throw e;
        }
    }

    // Synthesize an EXECUTE that invokes the callback method with status='expired' and empty response payload.
    async _injectExpiredCallback(request, expireData){
        if(!this.actions.actionExecute) return null;

        let callbackParams = [];
        if(request.callback_params_json){
            try {
                let parsed = JSON.parse(request.callback_params_json);
                if(Array.isArray(parsed)) callbackParams = parsed;
            } catch(_) {
                callbackParams = [];
            }
        }

        let callbackArgs = [
            request.request_id,
            request.provider_id,
            'expired',
            '',
            ...callbackParams.map(String)
        ];

        let actionParams = [
            0,
            request.contract_index,
            request.callback_method,
            ...callbackArgs
        ];

        let chain = this.config['CHAIN'];
        let emissionActionIndex = await this.indexerDb.createActionIndex({
            ACTION:      'EXECUTE',
            BLOCK_INDEX: expireData['BLOCK_INDEX'],
            FORMAT:      0,
            SOURCE:      'C:' + chain + ':' + request.contract_index
        }, true);

        // The expiry callback has no real tx behind it (ATTEST v2 is
        // system-synthesized). Post-SYNTH_EXEC_TX_HASH the context gets a
        // deterministic synthetic TX_HASH (namespaced by request_id, unique per
        // request since expiry fires once), so anything the callback emits
        // (ATTEST/XCALL/emit.execute) derives resolvable ids instead of being
        // billed and hard-rejected. Below the flag-day the legacy hashless
        // context is reproduced byte-identically (consensus replay safety).
        let synthActive = await this.actions.protocolChanges.isEnabled(SYNTH_EXEC_TX_HASH, expireData['BLOCK_INDEX']);
        let emissionData = buildInjectedExecContext({
            chain:         chain,
            network:       this.config['NETWORK'],
            contractIndex: request.contract_index,
            actionIndex:   emissionActionIndex,
            blockIndex:    expireData['BLOCK_INDEX'],
            blockTime:     expireData['BLOCK_TIME'],
            emitter:       expireData['ACTION_INDEX'],
            synthTag:      SYNTH_TAGS.ATTEST_EXPIRE_CALLBACK,
            synthId:       request.request_id,
            includeTxHash: synthActive
        });

        // Unique per injected callback (see _injectCallbackExecute savepoint note).
        let savepoint = await this.indexerDb.createSavepoint('attestation_expire_callback_' + parseInt(emissionActionIndex));
        try {
            await this.actions.actionExecute.parse(actionParams, emissionData, null);
            if(emissionData['STATUS'] && emissionData['STATUS'] !== 'valid'){
                console.warn('Attestation expiry callback returned non-valid status: ' + emissionData['STATUS']);
            }
            await this.indexerDb.releaseSavepoint(savepoint);
            return emissionActionIndex;
        } catch(e){
            await this.indexerDb.rollbackToSavepoint(savepoint);
            throw e;
        }
    }
}

module.exports = Attest;
module.exports.REQUEST_ID_PREIMAGE_FIELDS = REQUEST_ID_PREIMAGE_FIELDS;
