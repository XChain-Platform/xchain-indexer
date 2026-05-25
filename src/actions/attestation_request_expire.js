/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain Platform Action - ATTESTATION_REQUEST_EXPIRE
 *
 * System-injected synthetic action. Fired by the per-block expiry pipeline
 * (util.processAttestationExpirations) when an ATTESTATION_REQUEST passes its
 * DEADLINE_BLOCK without a fulfilled ATTESTATION_RESPONSE.
 *
 * Flips the request's status to 'expired' and synthesizes a callback EXECUTE
 * with status='expired' so the contract can handle the timeout per spec §4.3.
 *
 * Spec: claude/reports/specs/2026-05-24_external-attestation-framework.md (§11)
 *
 ********************************************************************/

const crypto = require('crypto');

class AttestationRequestExpire {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;
    }

    // Compute the responsible validator set for a given request — same
    // deterministic rule the hub uses (xchain-hub AttestationRound):
    //   sort capability validators by SHA256(request_id || pubkey),
    //   take top REDUNDANCY.
    // Returns array of pubkey hex strings.
    async _computeResponsibleSet(requestId, redundancy, blockIndex){
        let validators = await this.indexerDb.getValidatorsByCapability('attestation', blockIndex);
        if(!validators || validators.length === 0) return [];
        let withHash = validators.map(v => {
            let pk = String(v.pubkey).toLowerCase();
            let h  = crypto.createHash('sha256').update(String(requestId), 'utf8').update(pk, 'utf8').digest('hex');
            return { pubkey: pk, hash: h };
        });
        withHash.sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0));
        return withHash.slice(0, Math.max(1, Number(redundancy) || 1)).map(v => v.pubkey);
    }

    async parse(params, data, error){

        // Look up the request to expire. data['REQUEST_ID'] is set by
        // util.processAttestationExpirations from getExpiredAttestationRequests.
        let requestId = String(data['REQUEST_ID'] || '').toLowerCase();
        let request   = await this.indexerDb.getAttestationRequestById(requestId);

        // Bail if the request no longer exists or has already been resolved (race-protected).
        if(!request || request.request_status !== 'pending')
            return;

        // Create the synthetic ATTESTATION_REQUEST_EXPIRE action row
        let action = {};
        action['ACTION']      = 'ATTESTATION_REQUEST_EXPIRE';
        action['BLOCK_INDEX'] = data['BLOCK_INDEX'];
        data['ACTION_INDEX']  = await this.indexerDb.createActionIndex(action);
        data['STATUS']        = 'valid';

        console.log("\t ATTESTATION_REQUEST_EXPIRE : id=" + requestId.substring(0,16) + '...' +
                    ' : deadline=' + request.deadline_block +
                    ' : block=' + data['BLOCK_INDEX']);

        // Flip request status to 'expired'. Note: same UPDATE pattern as
        // attestation_response.js — request_status field drift on rollback is a
        // known pre-existing issue affecting both expire and response paths.
        await this.indexerDb.updateAttestationRequestStatus(requestId, 'expired');

        // Mark missed_count on each validator who was responsible for this
        // request. Responsibility is computed deterministically at the
        // request's snapshot block — same rule used by xchain-hub's
        // AttestationRound so this matches the validators who should have
        // produced a response.
        try {
            let responsible = await this._computeResponsibleSet(
                requestId, request.redundancy, Number(request.block_index)
            );
            for(let pk of responsible){
                await this.indexerDb.incrementAttestationValidatorStat(
                    pk, String(request.provider_id), 'missed_count', data['BLOCK_INDEX']
                );
            }
        } catch(e){
            // Missed-count tracking is informational for Phase 4 slashing.
            // Don't fail the expire path if the capability lookup errors.
            console.warn('Attestation expire: missed_count update failed: ' + (e && e.message ? e.message : e));
        }

        // Synthesize the callback EXECUTE so the contract can clean up
        // pending state and react to the failure (spec §4.3 — status='expired').
        // Wrapped in a savepoint so a misbehaving callback can't roll back
        // the status flip.
        try {
            await this._injectExpiredCallback(request, data);
        } catch(e){
            console.warn('Attestation expiry callback failed: ' + (e && e.message ? e.message : e));
        }

        await this.mapper.createMappings(data);
    }

    // Synthesize an EXECUTE that invokes the contract's callback method with
    // status='expired' and an empty response payload. Mirrors
    // attestation_response._injectCallbackExecute (same args layout, same
    // SOURCE convention, same savepoint discipline).
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

        // Callback signature (spec §4.3):
        //   [request_id, provider_id, status, response_payload, ...originalCallbackParams]
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
            FORMAT:      0
        }, true);

        // SOURCE = contract address so xchain.getSourceAddress() ===
        // xchain.getContractAddress() inside the callback (spec §4.3).
        let emissionData = {
            ACTION_INDEX: emissionActionIndex,
            SOURCE:       'C:' + chain + ':' + request.contract_index,
            FEE_PAYER:    'C:' + chain + ':' + request.contract_index,
            BLOCK_INDEX:  expireData['BLOCK_INDEX'],
            BLOCK_TIME:   expireData['BLOCK_TIME'],
            FORMAT:       0,
            IS_EMISSION:  true,
            EMITTER:      expireData['ACTION_INDEX']
        };

        let savepoint = await this.indexerDb.createSavepoint('attestation_expire_callback');
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

module.exports = AttestationRequestExpire;
