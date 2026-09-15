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
const eq      = require('../../equivocation_header.js');
const ah      = require('../../mirror_admission_activation.js');
// Read from the vendored protocol constants, not re-exported through
// actions/xcall: an action that requires another action makes the two
// load-order dependent, and the hop ceiling is protocol data rather than
// xcall's to own.
const XCALL_MAX_HOPS = require('../../protocol/constants.js').XCALL_MAX_HOPS;

const { getLogger } = require('../../observability/index.js');
// The dispatch quorum check and the savepointed target run (./xexec/). Each is called
// with this handler as the receiver, so both read this.indexerDb / this.actions unchanged.
const dispatchQuorum = require('./dispatch_quorum.js');
const runTarget      = require('./run_target.js');
// Return payloads are mirrored to every indexer AND ANCHOR-archived on DOGE,
// so they are hard-capped. Oversize yields status 'payload_too_large' with an
// empty payload (deterministic truncation rule). Vendored single source of
// truth: ../protocol/constants.js (XCALL_MAX_RETURN_BYTES).
const XCALL_MAX_RETURN_BYTES = require('../../protocol/constants.js').XCALL_MAX_RETURN_BYTES;

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
    // CrossChainCallEngine.canonicalMatch (dispatch branch) and the archive
    // verifier (StateAnchorPublisher.callCanonical).
    canonical(c){
        let raw = [
            'XCALL', 'DISPATCH', c.call_id, String(c.snapshot_block), c.network || '',
            c.source_chain, String(c.source_action_index), String(c.source_contract_index),
            c.target_chain, String(c.target_contract_index),
            c.method, this.sha256(String(c.params_json == null ? '' : c.params_json)),
            String(c.gas_limit), String(c.cross_hops), String(c.effective_time)
        ].join('|');
        // The admission map the hub signed, rebuilt from the mirrored row's admit_block_*
        // columns and era-keyed on the ROW's snapshot_block. Both phases carry it on the hub
        // side, so both twins here do too: a dispatch that bound by height while its result
        // bound by effective_time is the split the admission design removes. Empty below the
        // producer activation (legacy bytes unchanged); a modern row with no columns REFUSES.
        raw += ah.admissionCanonicalField('CrossChainCall', c.network, c.snapshot_block, ah.columnsAdmitBlocks(c));
        // EQUIV header: TAG=XCALL, ROUND_ID = sha256('XCALLROUND|dispatch|'+call_id)
        // (phase folded in, so dispatch/result get distinct keys), VIEW = finalizing_view.
        if(eq.isEquivHeaderActive(c.snapshot_block, c.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.XCALL,
                crypto.createHash('sha256').update('XCALLROUND|dispatch|' + c.call_id, 'utf8').digest('hex'),
                (c.finalizing_view != null ? c.finalizing_view : 0), raw);
        return raw;
    }

    sha256(s){
        return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
    }

    // Network, target and hop scope: the three refusals that are decided from the
    // mirrored row alone, before any validator set is read. Returns false when the
    // dispatch is not this chain's to run.
    dispatchInScope(c, coin){
        // Network + target scope (belt-and-suspenders; the query pre-filters)
        if(String(c.network || '') !== String(this.config['NETWORK'] || '')){
            getLogger().warn("\t XEXEC : call=" + String(c.call_id).substring(0,16) + '... : network mismatch (' + c.network + ' != ' + this.config['NETWORK'] + ') - skipping');
            return false;
        }
        if(String(c.target_chain) !== String(coin)) return false;           // not our call

        // Defense-in-depth: re-assert the hop ceiling at injection. The cap is
        // enforced at VM emit (gateway-emit.js) and source parse (xcall.js), but
        // re-checking here ensures a forged or corrupted mirror row cannot bypass it.
        // Under honest-majority this is never triggered; it guards the injection path.
        if(Number(c.cross_hops) > XCALL_MAX_HOPS){
            getLogger().warn("\t XEXEC : call=" + String(c.call_id).substring(0,16) + '... : cross_hops (' + c.cross_hops + ') exceeds XCALL_MAX_HOPS (' + XCALL_MAX_HOPS + ') - skipping');
            return false;
        }
        return true;
    }

    // The EXECUTE context the injected call runs in.
    //
    // Synthetic, chain/network-namespaced TX_HASH: there is no real transaction
    // on this chain, but anything the execution emits (ATTEST request_ids, XCALL
    // call_ids) derives from TX_HASH. It must be unique and collision-free
    // against real tx hashes AND other injected calls. CROSS_HOPS threads the
    // hop budget; IS_CROSS_CALL makes the VM enforce the target's crossCallable
    // allowlist; VM_GAS_LIMIT applies the caller-funded ceiling.
    buildExecutionContext(c, data, coin, executeActionIndex){
        return {
            ACTION_INDEX: executeActionIndex,
            SOURCE:       'C:' + String(c.source_chain) + ':' + String(c.source_contract_index),
            FEE_PAYER:    'C:' + String(c.source_chain) + ':' + String(c.source_contract_index),
            BLOCK_INDEX:  data['BLOCK_INDEX'],
            BLOCK_TIME:   data['BLOCK_TIME'],
            TX_HASH:      this.sha256('XCALL:' + String(c.network) + ':' + String(coin) + ':' + String(c.call_id)),
            FORMAT:       0,
            IS_EMISSION:  true,
            EMITTER:      data['ACTION_INDEX'],
            CALL_DEPTH:   0,
            VM_GAS_LIMIT: Number(c.gas_limit),
            CROSS_HOPS:   Number(c.cross_hops) || 0,
            IS_CROSS_CALL: true,
            // Fresh top-level issuance budget for this injected call's emission subtree
            // (EMISSION_ISSUANCE_LIMITS), consumed in issue.js. The injected
            // execution is fee-less on THIS chain, so without a budget it is the cheapest
            // path in the system to free top-level names; it is a root execution, so it gets
            // its own budget rather than inheriting the delivering transaction's.
            ISSUANCE_LIMIT_LEDGER: { topLevel: 0 }
        };
    }

    async parse(params, data, error){
        let c = data['CALL'];
        if(!c) return;

        let coin = this.config['COIN'];

        if(!this.dispatchInScope(c, coin)) return;

        let q = await dispatchQuorum.verifyDispatchQuorum.call(this, c);
        if(!q.synced){
            // Snapshot not mirrored yet. The block loop's call-sync + snapshot barriers
            // front-stop this (defer the whole block); this early-return is the
            // defensive guard for the residual race / single-host path. The dispatch
            // stays effective + unexecuted and retries on a later block. NOT an error.
            getLogger().info("\t XEXEC : call=" + String(c.call_id).substring(0,16) + '... : capability snapshot not synced - deferring');
            return;
        }
        if(!q.quorumMet){
            await this.recordQuorumRefusal(c, data, q);
            return;
        }

        // Mint the internal XEXEC action (rollback anchor for the whole call)
        let action = { ACTION: 'XEXEC', BLOCK_INDEX: data['BLOCK_INDEX'] };
        data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);
        data['STATUS'] = 'valid';

        let actionParams = this.buildCallParams(c);

        let executeActionIndex = await this.indexerDb.createActionIndex({
            ACTION:      'EXECUTE',
            BLOCK_INDEX: data['BLOCK_INDEX'],
            FORMAT:      0,
            // The caller is the SOURCE chain's contract, addressed across chains.
            SOURCE:      'C:' + String(c.source_chain) + ':' + String(c.source_contract_index)
        }, true);

        let executionData = this.buildExecutionContext(c, data, coin, executeActionIndex);

        let run = await runTarget.runTargetExecution.call(this, c, actionParams, executionData, executeActionIndex);

        await this.recordExecutionResult(c, data, coin, executeActionIndex, run);

        await this.mapper.createMappings(data);
    }

    // Quorum starvation: the mirrored row's signature set does not
    // meet quorum against the pinned snapshot. NOT terminal: signature sets
    // are per-hub and hubs gossip more signatures over time, so the call
    // stays effective + unexecuted and retries every block. Record the
    // refusal (node-local diagnostics, upsert per attempt) so a starved
    // dispatch is visible to operators and to getcrosschaincallresult
    // instead of leaving only this console line.
    async recordQuorumRefusal(c, data, q){
        let detail = q.weighted
            ? 'insufficient signer stake (' + q.validSigners.length + ' valid signers of ' + q.N + ' snapshot keys)'
            : 'insufficient valid signatures (' + q.validSigners.length + '/' + q.N + ')';
        getLogger().warn("\t XEXEC : call=" + String(c.call_id).substring(0,16) + '... : ' + detail + ' - skipping');
        await this.indexerDb.recordCrossChainCallRejection(
            String(c.call_id).toLowerCase(), 'quorum_not_met', detail, data['BLOCK_INDEX']);
    }

    // Run the target method as a fresh depth-0 execution
    buildCallParams(c){
        let parsedParams = [];
        try {
            let p = JSON.parse(String(c.params_json || '[]'));
            if(Array.isArray(p)) parsedParams = p.map(String);
        } catch(_){ parsedParams = []; }

        // Positional EXECUTE format: VERSION|CONTRACT_ACTION_INDEX|METHOD|PARAMS...
        return [0, Number(c.target_contract_index), String(c.method), ...parsedParams];
    }

    // Record the execution (idempotent on call_id; rollback-able with this block).
    // Written OUTSIDE the execution savepoint so a rolled-back failed run still
    // records its result: the failure must relay, and the call must not retry.
    async recordExecutionResult(c, data, coin, executeActionIndex, run){
        let resultStatus = run.resultStatus, returnPayloadB64 = run.returnPayloadB64, gasUsed = run.gasUsed;

        getLogger().info("\t XEXEC : call=" + String(c.call_id).substring(0,16) + '...' +
                    ' : ' + c.source_chain + ':' + c.source_contract_index +
                    ' → ' + coin + ':' + c.target_contract_index + ' . ' + c.method +
                    ' : gas=' + gasUsed + '/' + c.gas_limit +
                    ' : ' + resultStatus);

        await this.indexerDb.recordCrossChainCallExecution(
            data['ACTION_INDEX'], String(c.call_id).toLowerCase(), executeActionIndex,
            resultStatus, returnPayloadB64, gasUsed, data['BLOCK_INDEX']);
    }

    // Map an EXECUTE handler status to the relayed result status vocabulary.
    // MUST stay deterministic: every operator derives the identical mapping.
    mapFailureStatus(status, errorMessage){
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

// The return-payload cap, readable off the class for anything sizing a payload against it.
// It hangs on the handler rather than on a second export object, so the module's one
// export stays the class; the value is the vendored protocol constant above.
Xexec.XCALL_MAX_RETURN_BYTES = XCALL_MAX_RETURN_BYTES;

module.exports = Xexec;
