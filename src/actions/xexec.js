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
 * XChain Platform Action - XEXEC (system-injected, mirror-driven)
 *
 * Executes THIS chain's side of a cross-chain contract call. The xchain-hub
 * federation confirmation-gated the XCALL request on the source chain, signed
 * the dispatch (2f+1 `cross_chain` validators), and delivered it through the
 * hub-DB mirror (cross_chain_calls, phase='dispatch'). This handler is
 * injected once per effective, unexecuted dispatch targeting this chain (see
 * utility.processCrossChainCalls), verifies the signatures locally, and runs
 * the target contract method as a fresh depth-0 execution under the
 * caller-funded gas ceiling.
 *
 * There is NO on-chain transaction for the injection. It is an internal
 * action (like CROSS_SETTLE), recorded in cross_chain_call_executions for
 * idempotency + rollback. The execution outcome (status + capped return
 * payload) is recorded there too; the federation relays it back to the source
 * chain as the result phase.
 *
 * Failure containment: the injected execution runs inside its own savepoint.
 * A failed run (revert / out_of_gas / missing contract / not crossCallable)
 * rolls its state back but the FAILURE ITSELF is the recorded, relayed result
 * (never a skip, or operators that saw different transient states would
 * diverge on whether the call happened).
 *
 * Trust: dispatch terms are only acted on after 2f+1 `cross_chain` signatures
 * verify against the mirrored capability snapshot at the dispatch's
 * snapshot_block. A bad mirror can delay but cannot forge a call.
 *
 * Spec: xchain-documentation/protocol/actions/XCALL.md
 *
 ********************************************************************/

const crypto  = require('crypto');
const ed25519 = require('../ed25519.js');
const swq     = require('../stake_weighted_quorum.js');
const eq      = require('../equivocation_header.js');
const { XCALL_MAX_HOPS } = require('./xcall.js');

// Return payloads are mirrored to every indexer AND ANCHOR-archived on DOGE,
// so they are hard-capped. Oversize yields status 'payload_too_large' with an
// empty payload (deterministic truncation rule). Canonical: protocol/constants.js.
const XCALL_MAX_RETURN_BYTES = 1024;

class Xexec {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;
    }

    // Canonical signing string for the dispatch phase. MUST byte-match the hub's
    // CrossChainCallEngine._canonicalMatch (dispatch branch) and the archive
    // verifier (StateAnchorPublisher._callCanonical).
    _canonical(c){
        let raw = [
            'XCALL', 'DISPATCH', c.call_id, String(c.snapshot_block), c.network || '',
            c.source_chain, String(c.source_action_index), String(c.source_contract_index),
            c.target_chain, String(c.target_contract_index),
            c.method, this._sha256(String(c.params_json == null ? '' : c.params_json)),
            String(c.gas_limit), String(c.cross_hops), String(c.effective_time)
        ].join('|');
        // EQUIV (WI-2 bump 2): TAG=XCALL, ROUND_ID = sha256('XCALLROUND|dispatch|'+call_id)
        // (phase folded in, so dispatch/result get distinct keys), VIEW = finalizing_view.
        if(eq.isEquivHeaderActive(c.snapshot_block, c.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.XCALL,
                crypto.createHash('sha256').update('XCALLROUND|dispatch|' + c.call_id, 'utf8').digest('hex'),
                (c.finalizing_view != null ? c.finalizing_view : 0), raw);
        return raw;
    }

    _sha256(s){
        return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
    }

    async parse(params, data, error){
        let c = data['CALL'];
        if(!c) return;

        let coin = this.config['COIN'];

        // Network + target scope (belt-and-suspenders; the query pre-filters)
        if(String(c.network || '') !== String(this.config['NETWORK'] || '')){
            console.warn("\t XEXEC : call=" + String(c.call_id).substring(0,16) + '... : network mismatch (' + c.network + ' != ' + this.config['NETWORK'] + ') - skipping');
            return;
        }
        if(String(c.target_chain) !== String(coin)) return;                 // not our call

        // Defense-in-depth: re-assert the hop ceiling at injection. The cap is
        // enforced at VM emit (gateway-emit.js) and source parse (xcall.js), but
        // re-checking here ensures a forged or corrupted mirror row cannot bypass it.
        // Under honest-majority this is never triggered; it guards the injection path.
        if(Number(c.cross_hops) > XCALL_MAX_HOPS){
            console.warn("\t XEXEC : call=" + String(c.call_id).substring(0,16) + '... : cross_hops (' + c.cross_hops + ') exceeds XCALL_MAX_HOPS (' + XCALL_MAX_HOPS + ') - skipping');
            return;
        }

        // Verify the cross_chain quorum over the dispatch canonical.
        // Stake-weighted (source-deduped 3·Σ>2·S) at/above STAKE_WEIGHTED_QUORUM
        // (BTC snapshot_block + network), else legacy 2f+1 signer count.
        let snapshotBlock = Number(c.snapshot_block);
        let weighted = swq.isStakeWeightedQuorumActive(snapshotBlock, c.network);
        let validators = weighted
            ? await this.indexerDb.getStakeWeightsByCapability('cross_chain', snapshotBlock)
            : await this.indexerDb.getValidatorsByCapability('cross_chain', snapshotBlock);
        let N = (validators && validators.length) ? validators.length : 0;
        if(N === 0){
            // Snapshot not mirrored yet. The block loop's call-sync + snapshot barriers
            // front-stop this (defer the whole block); this early-return is the
            // defensive guard for the residual race / single-host path. The dispatch
            // stays effective + unexecuted and retries on a later block. NOT an error.
            console.log("\t XEXEC : call=" + String(c.call_id).substring(0,16) + '... : capability snapshot not synced - deferring');
            return;
        }

        let sigs;
        try { sigs = JSON.parse(c.validator_signatures || '[]'); }
        catch(_) { sigs = []; }

        let canonical = this._canonical(c);
        let snapPubkeys = new Set(validators.map(v => String(v.pubkey).toLowerCase()));
        let validSigners = [], seen = new Set();
        for(let s of sigs){
            let pk  = String(s.pubkey || '').toLowerCase();
            let sig = String(s.sig || '').toLowerCase();
            if(seen.has(pk)) continue;
            seen.add(pk);
            if(!/^[0-9a-f]{64}$/.test(pk) || !/^[0-9a-f]{128}$/.test(sig)) continue;
            if(!snapPubkeys.has(pk)) continue;
            if(!ed25519.verify(canonical, sig, pk)) continue;
            validSigners.push(pk);
        }
        let quorumMet = weighted
            ? swq.meetsStakeThreshold(this.util, validators, validSigners)
            : (validSigners.length >= ((N <= 1) ? 1 : Math.max(2 * Math.floor((N - 1) / 3) + 1, Math.ceil((N + 1) / 2))));
        if(!quorumMet){
            console.warn("\t XEXEC : call=" + String(c.call_id).substring(0,16) + '... : insufficient ' + (weighted ? 'signer stake' : 'valid signatures (' + validSigners.length + '/' + N + ')') + ' - skipping');
            return;
        }

        // Mint the internal XEXEC action (rollback anchor for the whole call)
        let action = { ACTION: 'XEXEC', BLOCK_INDEX: data['BLOCK_INDEX'] };
        data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);
        data['STATUS'] = 'valid';

        // Run the target method as a fresh depth-0 execution
        let parsedParams = [];
        try {
            let p = JSON.parse(String(c.params_json || '[]'));
            if(Array.isArray(p)) parsedParams = p.map(String);
        } catch(_){ parsedParams = []; }

        // Positional EXECUTE format: VERSION|CONTRACT_ACTION_INDEX|METHOD|PARAMS...
        let actionParams = [0, Number(c.target_contract_index), String(c.method), ...parsedParams];

        let executeActionIndex = await this.indexerDb.createActionIndex({
            ACTION:      'EXECUTE',
            BLOCK_INDEX: data['BLOCK_INDEX'],
            FORMAT:      0,
            // The caller is the SOURCE chain's contract, addressed across chains.
            SOURCE:      'C:' + String(c.source_chain) + ':' + String(c.source_contract_index)
        }, true);

        // Synthetic, chain/network-namespaced TX_HASH: there is no real transaction
        // on this chain, but anything the execution emits (ATTEST request_ids, XCALL
        // call_ids) derives from TX_HASH. It must be unique and collision-free
        // against real tx hashes AND other injected calls. CROSS_HOPS threads the
        // hop budget; IS_CROSS_CALL makes the VM enforce the target's crossCallable
        // allowlist; VM_GAS_LIMIT applies the caller-funded ceiling.
        let executionData = {
            ACTION_INDEX: executeActionIndex,
            SOURCE:       'C:' + String(c.source_chain) + ':' + String(c.source_contract_index),
            FEE_PAYER:    'C:' + String(c.source_chain) + ':' + String(c.source_contract_index),
            BLOCK_INDEX:  data['BLOCK_INDEX'],
            BLOCK_TIME:   data['BLOCK_TIME'],
            TX_HASH:      this._sha256('XCALL:' + String(c.network) + ':' + String(coin) + ':' + String(c.call_id)),
            FORMAT:       0,
            IS_EMISSION:  true,
            EMITTER:      data['ACTION_INDEX'],
            CALL_DEPTH:   0,
            VM_GAS_LIMIT: Number(c.gas_limit),
            CROSS_HOPS:   Number(c.cross_hops) || 0,
            IS_CROSS_CALL: true
        };

        let resultStatus = 'error';
        let returnPayloadB64 = '';
        let gasUsed = 0;

        let savepoint = await this.indexerDb.createSavepoint('xexec_' + executeActionIndex);
        try {
            await this.actions.actionExecute.parse(actionParams, executionData, null);
            let status = String(executionData['STATUS'] || 'error');
            gasUsed = Number(executionData['VM_GAS_BILLED']) || 0;

            if(status === 'valid'){
                resultStatus = 'ok';
                let rv = executionData['VM_RETURN_VALUE'];
                if(rv != null){
                    let bytes = Buffer.from(String(rv), 'utf8');
                    if(bytes.length > XCALL_MAX_RETURN_BYTES){
                        // Deterministic truncation rule: oversize returns become a
                        // distinct failure status with an EMPTY payload (never a
                        // truncated one, since partial JSON would be a foot-gun). The
                        // state changes stand (the contract ran fine); only the
                        // return payload is suppressed.
                        resultStatus = 'payload_too_large';
                    } else {
                        returnPayloadB64 = bytes.toString('base64');
                    }
                }
                await this.indexerDb.releaseSavepoint(savepoint);
            } else {
                // The run failed: roll back any partial effects; the failure is the result.
                await this.indexerDb.rollbackToSavepoint(savepoint);
                resultStatus = this._mapFailureStatus(status, executionData['VM_ERROR_MESSAGE']);
            }
        } catch(e){
            await this.indexerDb.rollbackToSavepoint(savepoint);
            resultStatus = 'error';
            console.warn("\t XEXEC : call=" + String(c.call_id).substring(0,16) + '... : execution threw: ' + (e && e.message));
        }

        console.log("\t XEXEC : call=" + String(c.call_id).substring(0,16) + '...' +
                    ' : ' + c.source_chain + ':' + c.source_contract_index +
                    ' → ' + coin + ':' + c.target_contract_index + ' . ' + c.method +
                    ' : gas=' + gasUsed + '/' + c.gas_limit +
                    ' : ' + resultStatus);

        // Record the execution (idempotent on call_id; rollback-able with this block).
        // Written OUTSIDE the execution savepoint so a rolled-back failed run still
        // records its result: the failure must relay, and the call must not retry.
        await this.indexerDb.recordCrossChainCallExecution(
            data['ACTION_INDEX'], String(c.call_id).toLowerCase(), executeActionIndex,
            resultStatus, returnPayloadB64, gasUsed, data['BLOCK_INDEX']);

        await this.mapper.createMappings(data);
    }

    // Map an EXECUTE handler status to the relayed result status vocabulary.
    // MUST stay deterministic: every operator derives the identical mapping.
    _mapFailureStatus(status, errorMessage){
        // The crossCallable allowlist violation throws the fixed marker from the
        // contract wrapper (see xchain-vm CONTRACT_WRAPPER). Checked across ALL
        // failure families because a plain wrapper throw classifies as 'failed'.
        if(/XCALL_NOT_CALLABLE/.test(String(errorMessage || ''))) return 'not_callable';
        if(/^reverted\b/.test(status))                      return 'reverted';
        if(/^(out_of_gas|out_of_resource)\b/.test(status))  return 'out_of_gas';
        if(/^invalid: CONTRACT_ACTION_INDEX/.test(status))  return 'no_contract';
        return 'error';
    }
}

module.exports = Xexec;
module.exports.XCALL_MAX_RETURN_BYTES = XCALL_MAX_RETURN_BYTES;
