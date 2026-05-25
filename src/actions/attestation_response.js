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
 * XChain Platform Action - ATTESTATION_RESPONSE
 *
 * Verifies validator signatures, stores the response, and injects the
 * developer-named callback method on the originating contract.
 *
 * Spec: claude/reports/specs/2026-05-24_external-attestation-framework.md
 *
 * FORMAT v0 (variable-length sig list):
 *   VERSION|REQUEST_ID|PROVIDER_ID|RESPONSE_PAYLOAD|STATUS|META|SIG_COUNT|PUBKEY1|SIG1|PUBKEY2|SIG2|...
 *
 ********************************************************************/

const crypto  = require('crypto');
const ed25519 = require('../ed25519.js');

class AttestationResponse {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.formats = {};
        this.formats[0] = 'VERSION|REQUEST_ID|PROVIDER_ID|RESPONSE_PAYLOAD|STATUS|META|SIG_COUNT|PUBKEY|SIG|...';
    }

    async parse(params, data, error){

        let format = data['FORMAT'];
        if(!error && (format === null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        // Extract fixed-position fields
        let requestId       = params[1];
        let providerId      = params[2];
        let responsePayload = params[3];
        let responseStatus  = params[4];
        let meta            = params[5];

        if(!error && (!requestId || !/^[0-9a-fA-F]{64}$/.test(String(requestId))))
            error = 'invalid: REQUEST_ID (format)';
        if(!error && this.util.isNull(providerId))
            error = 'invalid: PROVIDER_ID (required)';
        let allowedStatuses = ['ok', 'timeout', 'no_quorum', 'provider_error', 'expired'];
        if(!error && allowedStatuses.indexOf(String(responseStatus)) === -1)
            error = 'invalid: STATUS (unknown)';

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
            request = await this.indexerDb.getAttestationRequestById(String(requestId).toLowerCase());
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

        // Build canonical signing message:
        //   request_id || provider_id || sha256(response_payload) || status || meta
        let responseHash = crypto.createHash('sha256').update(String(responsePayload || ''), 'utf8').digest('hex');
        let canonical    = Buffer.from(String(requestId) + String(providerId) + responseHash + String(responseStatus) + String(meta || ''), 'utf8');

        // Verify each signature
        // - pubkey must have active `attestation` capability at the SNAPSHOT block
        //   (the request's block_index, per spec §5.2 / §8.2 — same block on every
        //   hub so the validator set is deterministic across the federation)
        // - Ed25519 signature must verify against the canonical message
        let snapshotBlock = request ? Number(request.block_index) : Number(data['BLOCK_INDEX']);
        let validSigs    = 0;
        let verifiedSigs = [];
        if(!error){
            let seenPubkey = new Set();
            for(let s of sigs){
                if(seenPubkey.has(s.pubkey)) continue;
                seenPubkey.add(s.pubkey);
                if(!await this.indexerDb.hasCapability(s.pubkey, 'attestation', snapshotBlock))
                    continue;
                if(!ed25519.verify(canonical, s.sig, s.pubkey))
                    continue;
                validSigs++;
                verifiedSigs.push(s);
            }
            // Quorum: validSigs must meet BOTH the request's REDUNDANCY parameter
            // and the PBFT quorum 2*floor((N-1)/3)+1 over the capability snapshot N.
            // For N=1 both collapse to 1, preserving single-validator behavior.
            let redundancy = request ? Number(request.redundancy) : 0;
            let pbftQuorum = 0;
            if(request){
                let snapshot = await this.indexerDb.getValidatorsByCapability('attestation', snapshotBlock);
                let N = snapshot.length;
                pbftQuorum = (N <= 1) ? N : (2 * Math.floor((N - 1) / 3) + 1);
            }
            let required = Math.max(redundancy, pbftQuorum);
            if(validSigs < required)
                error = 'invalid: insufficient valid signatures (' + validSigs + '/' + required +
                        ' — redundancy=' + redundancy + ' pbft=' + pbftQuorum + ')';
        }

        // Stash for DB write
        data['REQUEST_ID']       = String(requestId).toLowerCase();
        data['PROVIDER_ID']      = providerId;
        data['RESPONSE_PAYLOAD'] = responsePayload;
        data['RESPONSE_STATUS']  = responseStatus;
        data['META']             = meta;
        data['RESPONSE_HASH']    = responseHash;
        data['VALID_SIGS']       = validSigs;

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t ATTESTATION_RESPONSE : id=" + String(requestId).substring(0,16) + '...' +
                    ' : status=' + responseStatus +
                    ' : sigs=' + validSigs + '/' + (request ? request.redundancy : '?') +
                    ' : ' + data['STATUS']);

        // Persist response row
        await this.indexerDb.createAttestationResponse(data);

        if(status === 'valid'){
            // Persist verified signatures
            for(let s of verifiedSigs){
                await this.indexerDb.createAttestationValidatorSignature({
                    RESPONSE_ACTION_INDEX: data['ACTION_INDEX'],
                    VALIDATOR_PUBKEY:      s.pubkey,
                    SIGNATURE:             s.sig,
                    BLOCK_INDEX:           data['BLOCK_INDEX']
                });
            }

            // Flip request status
            let newRequestStatus = (responseStatus === 'ok') ? 'fulfilled' : 'errored';
            await this.indexerDb.updateAttestationRequestStatus(data['REQUEST_ID'], newRequestStatus);

            // Inject the callback EXECUTE. Wrapped in a savepoint so a failing callback
            // does NOT roll back the response row — per spec §4.3 the response is
            // recorded regardless, and the contract may consult getResponse() later.
            try {
                let callbackActionIndex = await this._injectCallbackExecute(request, data);
                if(callbackActionIndex)
                    await this.indexerDb.setAttestationResponseCallbackIndex(data['ACTION_INDEX'], callbackActionIndex);
            } catch(e){
                console.warn('Attestation callback injection failed: ' + (e && e.message ? e.message : e));
            }
        }

        await this.mapper.createMappings(data);
    }

    // Synthesize an EXECUTE action that runs the contract's callback method.
    // Mirrors execute.processEmission's positional-action invocation, but from
    // this handler instead of from VM emission.
    async _injectCallbackExecute(request, responseData){
        if(!this.actions.actionExecute) return null;

        // Parse callback params (stored as JSON string in attestation_requests.callback_params_json)
        let callbackParams = [];
        if(request.callback_params_json){
            try {
                let parsed = JSON.parse(request.callback_params_json);
                if(Array.isArray(parsed)) callbackParams = parsed;
            } catch(e){
                callbackParams = [];
            }
        }

        // The callback method receives, in order:
        //   [request_id, provider_id, status, response_payload, ...originalCallbackParams]
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
            FORMAT:      0
        }, true);

        // SOURCE = contract address so xchain.getSourceAddress() === xchain.getContractAddress() in the callback (spec §4.3).
        let emissionData = {
            ACTION_INDEX:  emissionActionIndex,
            SOURCE:        'C:' + chain + ':' + request.contract_index,
            FEE_PAYER:     'C:' + chain + ':' + request.contract_index,
            BLOCK_INDEX:   responseData['BLOCK_INDEX'],
            BLOCK_TIME:    responseData['BLOCK_TIME'],
            TX_INDEX:      responseData['TX_INDEX'],
            TX_HASH:       responseData['TX_HASH'],
            TX_VOUT:       responseData['TX_VOUT'],
            FORMAT:        0,
            IS_EMISSION:   true,
            EMITTER:       responseData['ACTION_INDEX']
        };

        let savepoint = await this.indexerDb.createSavepoint('attestation_callback');
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
}

module.exports = AttestationResponse;
