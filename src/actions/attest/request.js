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
 * XChain Indexer - ATTEST handler part
 *
 * ATTEST v0: the request leg (admission, fee escrow, the pinned responsible set).
 *
 * Installed onto Attest.prototype by actions/attest/index.js, so call sites stay
 * this.<method>().
 *
 ********************************************************************/

'use strict';

const attestAdmission = require('../../attest_admission_activation.js');
const attestRequestCap = require('../../attest_request_cap_activation.js');
// The rules-aware capability filter: drops a validator whose last rolled ROLLCALL
// gate list does not cover the gates active at the request block. Inert on every
// network whose ROLLCALL_GATES_ACTIVATION is null, where it never queries.
const rgf     = require('./rollcall_gates_filter.js');
const { getLogger } = require('../../observability/index.js');
const { HOME_CHAIN } = require('./constants.js');

module.exports = {
    // ATTEST v0: Request (VM emission only)
    async parseRequest(params, data, error){

        // VM-emission-only: reject anything user-initiated.
        // execute.processEmission sets IS_EMISSION=true when synthesizing the action.
        if(!error && !data['IS_EMISSION'])
            error = 'invalid: ATTEST v0 must originate from VM emission';

        this.extractRequestParams(params, data);

        if(!error)
            data = this.util.setNumberFormats(data);

        error = this.requestFieldError(data, error);

        // The fee phases live in fees.js: the format and precision rules here, the
        // funding check below, and the escrow after the row is written.
        let fee = await this.requestFeeFormatError(data, error);
        error = fee.error;

        error = await this.requestAnchorError(data, error);

        // GAS_ESCROW is not yet deducted from the fee-payer's balance at request time;
        // the fee-funding check below validates the payer holds the amount, and
        // REQUEST_STATUS is assigned once `error` is final so structural failures
        // do not enter the 'pending' pool (see the assignment after the fee-funding check).
        data['GAS_ESCROW']     = '0';
        data['FEE_PAYER']      = data['FEE_PAYER'] || data['SOURCE']; // execute.processEmission carries FEE_PAYER

        error = await this.requestFeeFundingError(data, error, fee.feePresent);

        let relayOrigin = await this.isRelayOriginRequest(data, error);
        let admission   = await this.responsibleSetAdmission(data, error, relayOrigin);
        error = admission.error;

        error = await this.requestCapError(data, error);

        let status = this.stampRequestStatus(data, error, relayOrigin);

        getLogger().info("\t ATTEST v0 : id=" + (data['REQUEST_ID'] ? String(data['REQUEST_ID']).substring(0,16) + '...' : '?') +
                    ' : provider=' + data['PROVIDER_ID'] +
                    ' : contract=' + data['CONTRACT_INDEX'] +
                    ' : redundancy=' + data['REDUNDANCY'] +
                    ' : fee=' + (fee.feePresent ? data['FEE_AMOUNT'] + ' ' + data['FEE_TICK'] : 'none') +
                    ' : ' + data['STATUS']);

        await this.pinRequestResponsibleSet(data, admission.set);

        await this.indexerDb.createAttestationRequest(data);

        await this.escrowRequestFee(data, status, fee.feePresent);

        await this.mapper.createMappings(data);
    },

    // The v0 wire, field by field. Positional throughout, so the only thing that can
    // move here is the wire itself.
    extractRequestParams(params, data){
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
    },

    // The structural rules over those fields: id shape, provider, callback, redundancy,
    // payload size and deadline window. Returns the caller's own `error` untouched when
    // nothing new is wrong, so a verdict set earlier keeps its exact value.
    requestFieldError(data, error){
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

        return error;
    },

    // The contract this request is emitted by, and the deterministic request_id over it.
    // The re-derivation itself lives in index.js beside REQUEST_ID_PREIMAGE_FIELDS, which
    // is the one place the preimage is spelled.
    async requestAnchorError(data, error){
        // Validate contract_index references a real contract
        if(!error && data['CONTRACT_INDEX'] != null){
            let contract = await this.indexerDb.getContract(data['CONTRACT_INDEX']);
            if(!contract)
                error = 'invalid: CONTRACT_INDEX (unknown)';
        } else if(!error){
            error = 'invalid: CONTRACT_INDEX (missing emitter)';
        }

        if(!error){
            let derivation = this.requestIdDerivationError(data);
            if(derivation) error = derivation;
        }

        return error;
    },

    // Cross-chain relay: the origin-side half of the cross-chain relay.
    // On LTC/DOGE computeResponsibleSet returns [] by construction (attestation
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
    async isRelayOriginRequest(data, error){
        let relayOrigin = false;
        if(!error && this.config['COIN'] !== HOME_CHAIN)
            relayOrigin = await this.actions.protocolChanges.isEnabled('ATTEST_RELAY_ORIGIN', data['BLOCK_INDEX']);
        return relayOrigin;
    },

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
    //
    // Returns the verdict and the set it computed, which the caller reuses as the pinned
    // RESPONSIBLE_SET_JSON rather than paying for the stake query twice.
    async responsibleSetAdmission(data, error, relayOrigin){
        let admissionSet = null;
        // LOCAL-HEIGHT plane: BLOCK_INDEX is this request's height on
        // its own chain, which is what this gate is defined against. It is deliberately
        // NOT the BTC-anchored plane the stake_weighted_quorum / price_sig_tally gates
        // use; see attest_admission_activation.js for why the two differ and why the
        // difference must not be "corrected" without its own flag-day.
        if(!error && !relayOrigin && attestAdmission.isAttestAdmissionActive(data['BLOCK_INDEX'], this.config['NETWORK'])){
            // The rules-aware filter reports how many keys it removed
            // through this out-parameter; nothing else about the call moves.
            let gatesStats = {};
            admissionSet = await this.computeResponsibleSet(
                String(data['REQUEST_ID'] || '').toLowerCase(), data['REDUNDANCY'], data['BLOCK_INDEX'], data['PROVIDER_ID'],
                undefined, gatesStats);
            let neededSlots = Math.max(1, Number(data['REDUNDANCY']) || 1);
            if(admissionSet.length < neededSlots){
                // FAIL CLOSED with the reason that is actually true. A set that
                // was never large enough and a set the rules filter shrank need
                // different literals: the first is a staking problem the requester can
                // do nothing about, the second names a fleet that has not rolled a call
                // covering the gates active at this block, which is an operator action.
                // The rules-aware literal is tested FIRST so it wins whenever the
                // filter dropped anybody. Neither is a refund: a v0 exists only as a VM
                // emission and processEmission throws on a non-valid one, so the
                // emitting EXECUTE reverts with its sibling writes.
                error = (Number(gatesStats.dropped) > 0)
                    ? 'invalid: REDUNDANCY (rules-aware set ' + admissionSet.length + ' < ' + neededSlots + ' at request block)'
                    : 'invalid: REDUNDANCY (responsible set ' + admissionSet.length + ' < ' + neededSlots + ' at request block)';
                let line = rgf.formatGatesFilterStats(gatesStats);
                if(line) getLogger().info("\t ATTEST v0 : " + line);
            }
        }

        return { error, set: admissionSet };
    },

    // Per-block admission caps (flag-day gated). An admitted
    // request obliges REDUNDANCY validators to make a provider call, which for the
    // `llm` provider is a real invoice on each operator's own vendor account, while
    // the requester pays the same flat VM_ATTEST_REQUEST gas either way. Fees bound
    // that on a fee-bearing network; on testnet nothing is scarce, so the bound has
    // to be this rule. Refusal rather than deferral, because the action is already
    // in this block and there is no later block to carry it to - see the semantics
    // note in attest_request_cap_activation.js, which also records what the refusal
    // costs the author on a live chain: the emitting EXECUTE REVERTS (processEmission
    // throws on a non-'valid' emission), taking the under-cap siblings and the
    // execution's state writes with it, and no 'rejected' v0 row survives.
    //
    // Checked LAST among the admission rules, and only for an otherwise-valid
    // request, so a structurally invalid one never consumes a capped slot. Same
    // LOCAL-HEIGHT plane as the responsible-set gate directly above.
    async requestCapError(data, error){
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

        return error;
    },

    // The two lifecycle columns and the relay identity, assigned once `error` is final.
    // Returns the action status the fee escrow keys on.
    stampRequestStatus(data, error, relayOrigin){
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
        //
        // NO AUDIT ROW ACTUALLY SURVIVES, though, and this is a fail-safe rather than
        // the observable behaviour: a v0 exists only as a VM emission, and
        // execute.processEmission throws on any emission whose STATUS is not 'valid',
        // which rolls the emitting EXECUTE's savepoint back over this write. Measured
        // on BTC regtest 2026-09-02 and on the venue's whole history: not one
        // 'rejected' v0 row has ever existed. Keep the branch anyway - it is what makes
        // the write safe if a future emission path ever stops throwing.
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

        return status;
    },

    // The responsible set as-of this request's block, pinned onto the row.
    async pinRequestResponsibleSet(data, admissionSet){
        // Pin the responsible set AS-OF this request's block so the reorg
        // missed_count recompute (rollback.recomputeAttestationValidatorStats) reads the
        // historical set verbatim rather than re-deriving it against the CURRENT mutable
        // stakes.amount (a later SURVIVING slash reduces it, so a bare re-derive charges
        // missed_count to the wrong set). Only a 'pending' request can ever expire and reach
        // the recompute; a 'rejected' row is invisible to the expiry sweep, so skip the stake
        // query for it. Uses the SAME computeResponsibleSet the v1 verify + v2 expiry paths
        // use, evaluated at the request's own block_index (the set the recompute keys on).
        // (Reuses the admission-gate set when the gate already computed it.)
        if(data['REQUEST_STATUS'] === 'pending'){
            let responsibleSet = admissionSet !== null ? admissionSet : await this.computeResponsibleSet(
                String(data['REQUEST_ID'] || '').toLowerCase(), data['REDUNDANCY'], data['BLOCK_INDEX'], data['PROVIDER_ID']);
            data['RESPONSIBLE_SET_JSON'] = JSON.stringify(responsibleSet);
        }
    }
};
