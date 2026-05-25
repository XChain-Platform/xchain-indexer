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
 * XChain Platform Action - ATTESTATION_REQUEST
 *
 * VM-emission-only. Originated by contracts via xchain.attestation.request().
 * Stores the request in attestation_requests; waits for an ATTESTATION_RESPONSE
 * carrying validator signatures.
 *
 * Spec: claude/reports/specs/2026-05-24_external-attestation-framework.md
 *
 * FORMAT v0 (positional, built by execute.processEmission):
 *   VERSION|REQUEST_ID|PROVIDER_ID|REQUEST_PAYLOAD|CALLBACK_METHOD|CALLBACK_PARAMS_JSON|REDUNDANCY|DEADLINE_BLOCKS
 *
 ********************************************************************/

const crypto = require('crypto');
const ProviderRegistry = require('../attestation/providerRegistry.js');

class AttestationRequest {

    constructor(action){
        this.actions   = action;
        this.config    = action.config;
        this.decoderDb = action.decoderDb;
        this.indexerDb = action.indexerDb;
        this.util      = action.util;
        this.mapper    = action.mapper;

        this.formats = {};
        this.formats[0] = 'VERSION|REQUEST_ID|PROVIDER_ID|REQUEST_PAYLOAD|CALLBACK_METHOD|CALLBACK_PARAMS_JSON|REDUNDANCY|DEADLINE_BLOCKS';

        // Phase 1 stub. Phase 2 swaps for hub-backed governance registry.
        this.providerRegistry = new ProviderRegistry();
    }

    async parse(params, data, error){

        let format = data['FORMAT'];
        if(!error && (format === null || this.formats[format] === undefined))
            error = 'invalid: VERSION (unknown)';

        // VM-emission-only: reject anything user-initiated.
        // execute.processEmission sets IS_EMISSION=true when synthesizing the action.
        if(!error && !data['IS_EMISSION'])
            error = 'invalid: ATTESTATION_REQUEST must originate from VM emission';

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

        /*****************************************************************
         * Field Validations
         ****************************************************************/

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
        if(!error && data['CONTRACT_INDEX']){
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

        /*****************************************************************
         * Phase 1 placeholder fields
         *   - GAS_ESCROW: real economic escrow lands in Phase 3 (spec §11).
         *     For now we store '0' so the callback dispatch in P1-5/P1-6
         *     can carry forward the column.
         *   - REQUEST_STATUS: lifecycle = pending → fulfilled / expired / errored.
         ****************************************************************/
        data['GAS_ESCROW']     = '0';
        data['REQUEST_STATUS'] = 'pending';
        data['FEE_PAYER']      = data['FEE_PAYER'] || data['SOURCE']; // execute.processEmission carries FEE_PAYER

        let status = (error) ? error : 'valid';
        data['STATUS'] = status;

        console.log("\t ATTESTATION_REQUEST : id=" + (data['REQUEST_ID'] ? String(data['REQUEST_ID']).substring(0,16) + '...' : '?') +
                    ' : provider=' + data['PROVIDER_ID'] +
                    ' : contract=' + data['CONTRACT_INDEX'] +
                    ' : redundancy=' + data['REDUNDANCY'] +
                    ' : ' + data['STATUS']);

        // Persist
        await this.indexerDb.createAttestationRequest(data);

        // Create action mappings
        await this.mapper.createMappings(data);
    }
}

module.exports = AttestationRequest;
