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
 * XChain Platform Action - ATTEST
 *
 * External-data attestation lifecycle with three version-discriminated phases:
 *   v0 — Request (VM emission only; originated by xchain.attestation.request())
 *   v1 — Response (validator-broadcast PBFT bundle with signatures)
 *   v2 — Expire (system-synthesized; never user-broadcast)
 *
 * Spec: xchain-documentation/protocol/actions/ATTEST.md
 *
 * FORMATS:
 *   v0 - VERSION|REQUEST_ID|PROVIDER_ID|REQUEST_PAYLOAD|CALLBACK_METHOD|CALLBACK_PARAMS_JSON|REDUNDANCY|DEADLINE_BLOCKS
 *   v1 - VERSION|REQUEST_ID|PROVIDER_ID|RESPONSE_PAYLOAD|STATUS|META|SIG_COUNT|PUBKEY|SIG|...
 *   v2 - VERSION|REQUEST_ID         (synthesized only; REQUEST_ID is sufficient — handler looks up the row)
 *
 ********************************************************************/

const crypto  = require('crypto');
const ed25519 = require('../ed25519.js');
const ProviderRegistry = require('../attestation/providerRegistry.js');

class Attest {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        // Phase 1 stub. Phase 2 swaps for hub-backed governance registry.
        this.providerRegistry = new ProviderRegistry();

        // Per-version format strings
        this.formats = {};
        this.formats[0] = 'VERSION|REQUEST_ID|PROVIDER_ID|REQUEST_PAYLOAD|CALLBACK_METHOD|CALLBACK_PARAMS_JSON|REDUNDANCY|DEADLINE_BLOCKS';
        this.formats[1] = 'VERSION|REQUEST_ID|PROVIDER_ID|RESPONSE_PAYLOAD|STATUS|META|SIG_COUNT|PUBKEY|SIG|...';
        this.formats[2] = 'VERSION|REQUEST_ID';
    }

    // Dispatch on VERSION
    async parse(params, data, error){

        let format = data['FORMAT'];
        if(!error && (format === null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        if(format === 0) return await this._parseRequest(params, data, error);
        if(format === 1) return await this._parseResponse(params, data, error);
        if(format === 2) return await this._parseExpire(params, data, error);
    }

    // ATTEST v0 — Request (VM emission only)
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

        // Validate contract_index references a real contract
        if(!error && data['CONTRACT_INDEX'] != null){
            let contract = await this.indexerDb.getContract(data['CONTRACT_INDEX']);
            if(!contract)
                error = 'invalid: CONTRACT_INDEX (unknown)';
        } else if(!error){
            error = 'invalid: CONTRACT_INDEX (missing emitter)';
        }

        // Re-derive request_id and compare. Defends against a compromised VM by anchoring
        // the on-chain request_id to (tx_hash, contract_index, emitter_position) — once
        // execute.processEmission passes EMITTER_POSITION the verification kicks in.
        if(!error && data['EMITTER_POSITION'] !== undefined && data['TX_HASH']){
            let preimage = String(data['TX_HASH']) + ':' + String(data['CONTRACT_INDEX']) + ':' + String(data['EMITTER_POSITION']);
            let expected = crypto.createHash('sha256').update(preimage).digest('hex');
            if(expected !== String(data['REQUEST_ID']).toLowerCase())
                error = 'invalid: REQUEST_ID (does not match deterministic derivation)';
        }

        // Phase 1 placeholders (gas escrow lands in Phase 3 per spec §11)
        data['GAS_ESCROW']     = '0';
        data['REQUEST_STATUS'] = 'pending';
        data['FEE_PAYER']      = data['FEE_PAYER'] || data['SOURCE']; // execute.processEmission carries FEE_PAYER

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t ATTEST v0 : id=" + (data['REQUEST_ID'] ? String(data['REQUEST_ID']).substring(0,16) + '...' : '?') +
                    ' : provider=' + data['PROVIDER_ID'] +
                    ' : contract=' + data['CONTRACT_INDEX'] +
                    ' : redundancy=' + data['REDUNDANCY'] +
                    ' : ' + data['STATUS']);

        await this.indexerDb.createAttestationRequest(data);
        await this.mapper.createMappings(data);
    }

    // ATTEST v1 — Response (validator broadcast)
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

        // Build canonical signing message
        let responseHash = crypto.createHash('sha256').update(responseBodyBytes).digest('hex');
        let canonical    = Buffer.from(String(requestId) + String(providerId) + responseHash + String(responseStatus) + String(meta || ''), 'utf8');

        // Verify each signature against the responsible-set capability snapshot at the REQUEST's block
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
            // Quorum: only REDUNDANCY validators are responsible for fetching (spec §8.2)
            let redundancy = request ? Number(request.redundancy) : 0;
            if(validSigs < redundancy)
                error = 'invalid: insufficient valid signatures (' + validSigs + '/' + redundancy + ')';
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

        // Inline the verified federation signatures as a JSON array on the response
        // row (consolidated `attests` table — no separate signatures table). Only
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

            // Flip request status
            let newRequestStatus = (responseStatus === 'ok') ? 'fulfilled' : 'errored';
            await this.indexerDb.updateAttestationRequestStatus(data['REQUEST_ID'], newRequestStatus);

            // Inject the callback EXECUTE. Wrapped in a savepoint so a failing callback
            // does NOT roll back the response row.
            try {
                let callbackActionIndex = await this._injectCallbackExecute(request, data);
                if(callbackActionIndex)
                    await this.indexerDb.setAttestationResponseCallbackIndex(data['ACTION_INDEX'], callbackActionIndex);
            } catch(e){
                console.warn('Attestation callback injection failed:', e);
            }
        }

        await this.mapper.createMappings(data);
    }

    // ATTEST v2 — Expire (system-synthesized)
    async _parseExpire(params, data, error){

        // System-synthesized only. The decoder accepts ATTEST in VALID_ACTION_NAMES but the
        // user-broadcast path can't legitimately produce v2 — guard against accidental
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

        // Flip request status to 'expired'
        await this.indexerDb.updateAttestationRequestStatus(requestId, 'expired');

        // Mark missed_count on each responsible validator (deterministic by SHA256(request_id || pubkey))
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
            console.warn('Attestation expire: missed_count update failed:', e);
        }

        // Synthesize the callback EXECUTE so the contract can clean up (status='expired')
        try {
            await this._injectExpiredCallback(request, data);
        } catch(e){
            console.warn('Attestation expiry callback failed:', e);
        }

        await this.mapper.createMappings(data);
    }

    // Compute the responsible validator set for a given request — same deterministic rule
    // the hub uses (xchain-hub AttestationRound): sort capability validators by
    // SHA256(request_id || pubkey), take top REDUNDANCY.
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

    // Synthesize an EXECUTE that runs the contract's callback method (v1 response path).
    async _injectCallbackExecute(request, responseData){
        if(!this.actions.actionExecute) return null;

        let callbackParams = [];
        if(request.callback_params_json){
            try {
                let parsed = JSON.parse(request.callback_params_json);
                if(Array.isArray(parsed)) callbackParams = parsed;
            } catch(e){
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

        // SOURCE = contract address so xchain.getSourceAddress() === xchain.getContractAddress() (spec §4.3)
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

module.exports = Attest;
