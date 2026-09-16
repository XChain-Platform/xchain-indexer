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
 * The synthesized contract callbacks every terminal leg fires.
 *
 * Installed onto Attest.prototype by actions/attest/index.js, so call sites stay
 * this.<method>().
 *
 ********************************************************************/

'use strict';

const { buildInjectedExecContext, SYNTH_EXEC_TX_HASH, SYNTH_TAGS } = require('../../consensus/exec_context.js');
const { getLogger } = require('../../observability/index.js');

module.exports = {
    // Inject the contract callback for a relayed response. The 'ok' path is the v1
    // callback verbatim; a relayed 'expired' delivers the same empty-payload shape
    // the local expiry path does, so a contract cannot tell whether its attestation
    // was serviced locally or across chains, which is the property that makes the
    // relay transparent to contract authors.
    async injectRelayCallback(request, responseData){
        if(String(responseData['RESPONSE_STATUS']) === 'ok')
            return await this.injectCallbackExecute(request, responseData);
        return await this.injectExpiredCallback(request, responseData);
    },

    // Synthesize an EXECUTE that runs the contract's callback method (v1 response path).
    async injectCallbackExecute(request, responseData){
        if(!this.actions.actionExecute) return null;

        let callbackParams = this.callbackParamsOf(request);
        let actionParams   = this.callbackActionParams(request, responseData['RESPONSE_STATUS'],
                                                       responseData['RESPONSE_PAYLOAD'] || '', callbackParams);

        let chain = this.config['CHAIN'];
        let emissionActionIndex = await this.indexerDb.createActionIndex({
            ACTION:      'EXECUTE',
            BLOCK_INDEX: responseData['BLOCK_INDEX'],
            TX_INDEX:    responseData['TX_INDEX'],
            TX_VOUT:     responseData['TX_VOUT'],
            FORMAT:      0,
            SOURCE:      'C:' + chain + ':' + request.contract_index
        }, true);

        // SOURCE = contract address so xchain.getSourceAddress() === xchain.getContractAddress().
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

        // Unique per injected callback (the savepoint note lives on runCallbackSavepoint).
        return await this.runCallbackSavepoint('attestation_callback_', actionParams, emissionData,
                                              emissionActionIndex,
                                              'Attestation callback execute returned non-valid status: ');
    },

    // Synthesize an EXECUTE that invokes the callback method with status='expired' and empty response payload.
    async injectExpiredCallback(request, expireData){
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

        let actionParams = this.callbackActionParams(request, 'expired', '', callbackParams);

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

        // Unique per injected callback (the savepoint note lives on runCallbackSavepoint).
        return await this.runCallbackSavepoint('attestation_expire_callback_', actionParams, emissionData,
                                              emissionActionIndex,
                                              'Attestation expiry callback returned non-valid status: ');
    },

    // The callback params the request carries, or none when the stored JSON cannot be
    // read as an array.
    callbackParamsOf(request){
        let callbackParams = [];
        if(request.callback_params_json){
            try {
                let parsed = JSON.parse(request.callback_params_json);
                if(Array.isArray(parsed)) callbackParams = parsed;
            } catch(e){
                getLogger().warn('_injectCallbackExecute: malformed callback_params_json for request ' +
                             String(request.request_id).substring(0,16) + '..., using empty params:', e.message);
                callbackParams = [];
            }
        }

        return callbackParams;
    },

    // Positional EXECUTE format: VERSION|CONTRACT_ACTION_INDEX|METHOD|PARAMS...
    // Callback signature: [request_id, provider_id, status, response_payload, ...originalCallbackParams]
    callbackActionParams(request, status, responsePayload, callbackParams){
        let callbackArgs = [
            request.request_id,
            request.provider_id,
            status,
            responsePayload,
            ...callbackParams.map(String)
        ];

        return [
            0,
            request.contract_index,
            request.callback_method,
            ...callbackArgs
        ];
    },

    // Unique per injected callback: a fixed name would be destroyed and re-created
    // by MariaDB on re-use, corrupting rollback when EXECUTE nests its own savepoints
    // or multiple attestation callbacks fire in one block transaction.
    //
    // The savepoint is released on a clean run and rolled back on a throw, so a failing
    // callback never takes the response row with it.
    async runCallbackSavepoint(name, actionParams, emissionData, emissionActionIndex, warnText){
        let savepoint = await this.indexerDb.createSavepoint(name + parseInt(emissionActionIndex));
        try {
            await this.actions.actionExecute.parse(actionParams, emissionData, null);
            if(emissionData['STATUS'] && emissionData['STATUS'] !== 'valid'){
                getLogger().warn(warnText + emissionData['STATUS']);
            }
            await this.indexerDb.releaseSavepoint(savepoint);
            return emissionActionIndex;
        } catch(e){
            await this.indexerDb.rollbackToSavepoint(savepoint);
            throw e;
        }
    }
};
