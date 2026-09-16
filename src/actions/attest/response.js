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
 * ATTEST v1: the on-chain response leg, and the mirror-era predicate all three era gates share.
 *
 * Installed onto Attest.prototype by actions/attest/index.js, so call sites stay
 * this.<method>().
 *
 ********************************************************************/

'use strict';

// The ONE response verifier: this chain path and the hub-mirror applier call the
// same module, so an artifact cannot be judged differently by delivery route.
const avr     = require('./attest_response_verify.js');
// The response-mirror flag day, keyed on the REQUEST's own block: a registry row
// read by literal key (W5). utility.js reads the same row for the applier pass's
// selection.
const gateRegistry = require('../../consensus/gate_registry');
const RESPONSE_MIRROR_KEY = 'attest_response_mirror_activation.ATTEST_RESPONSE_MIRROR_ACTIVATION';
const { rethrowIfInfraFault } = require('../../consensus/fault_guard.js');
const { getLogger } = require('../../observability/index.js');

module.exports = {
    // ATTEST v1: Response (validator broadcast)
    async parseResponse(params, data, error){

        let wire = this.readResponseWire(params, error);
        error    = wire.error;
        let { requestId, providerId, responsePayload, responseStatus, meta } = wire;

        let parsed = this.parseResponseSigs(params, error);
        error = parsed.error;

        let lookup  = await this.responseRequestError(requestId, providerId, data, error);
        let request = lookup.request;
        error       = lookup.error;

        let verdict      = await this.verifyChainResponse(wire, request, parsed.sigs, data, error);
        error            = verdict.error;
        let validSigs    = verdict.validSigs;
        let verifiedSigs = verdict.verifiedSigs;
        let responseHash = verdict.responseHash;

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

        getLogger().info("\t ATTEST v1 : id=" + String(requestId).substring(0,16) + '...' +
                    ' : status=' + responseStatus +
                    ' : sigs=' + validSigs + '/' + (request ? request.redundancy : '?') +
                    ' : ' + data['STATUS']);

        // Persist response row (with verified sigs inlined as JSON)
        await this.indexerDb.createAttestationResponse(data);

        if(status === 'valid')
            await this.closeChainResponse(request, data, requestId, providerId, responseStatus, verifiedSigs);

        await this.mapper.createMappings(data);
    },

    // The v1 wire: the fixed-position fields, their structural rules, and the id
    // normalization the rest of the path keys on. Returns the fields plus the verdict,
    // which is the caller's own `error` untouched when nothing new is wrong.
    readResponseWire(params, error){
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
        // (AttestationConsensus.buildCanonical) and the only live producer lowercases
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

        return { requestId, requestIdRaw, providerId, responsePayload, responseBodyBytes,
                 responseStatus, meta, error };
    },

    parseResponseSigs(params, error){
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

        return { sigs, error };
    },

    // The original request this response answers, and every reason a stored one cannot
    // be answered by this wire.
    async responseRequestError(requestId, providerId, data, error){
        // Look up the original request
        let request = null;
        if(!error){
            request = await this.indexerDb.getAttestationRequestById(requestId);
            if(!request){
                error = 'invalid: REQUEST_ID (no matching request)';
            } else if(this.isMirrorEraRequest(request)){
                // THE FLAG-DAY GATE. At or above the response-mirror height a response
                // reaches every indexer through the hub mirror, so an on-chain v1 for such
                // a request is refused: without this a stale hub still running the legacy
                // publisher would DOUBLE-DELIVER, the mirror applier and the chain handler
                // each firing the callback and each settling the escrow.
                //
                // First among the request-derived branches on purpose. Every branch below
                // also rejects, so an ordering that let one of them answer first could not
                // admit the action, but it WOULD record a different reason for the same
                // wire depending on the request's incidental state, and this string is
                // consensus: it is the stored verdict a replay re-derives.
                error = 'invalid: ATTEST v1 after mirror activation';
            } else if(request.request_status !== 'pending'){
                error = 'invalid: REQUEST already ' + request.request_status;
            } else if(request.provider_id !== String(providerId)){
                error = 'invalid: PROVIDER_ID does not match request';
            } else if(parseInt(data['BLOCK_INDEX']) > parseInt(request.deadline_block)){
                error = 'invalid: REQUEST expired (deadline_block=' + request.deadline_block + ')';
            }
        }

        return { request, error };
    },

    async verifyChainResponse(wire, request, sigs, data, error){
        let { requestId, requestIdRaw, providerId, responseStatus, meta, responseBodyBytes } = wire;
        // Verification proper lives in attest_response_verify.js: ONE implementation
        // that this chain path and the hub-mirror applier both call, so the two
        // delivery routes can never reach different verdicts on the same artifact
        // (on-chain or hub mirror). Everything consensus-relevant lives
        // there, comments included; what stays here is the wire parsing above and the
        // persistence below.
        //
        // Three things are passed rather than read from `data` inside the module, and
        // each is a deliberate seam for the mirror path:
        //   atBlock    the block the response is judged AT. It drives the widening
        //              ladder, which is evaluated at the RESPONSE's own height on
        //              purpose. On this path that is the v1 action's block.
        //   gateBlock  where ATTEST_CANONICAL_LOWERCASE_ID is evaluated. Today, and
        //              here, the v1 ACTION's block; the module must not re-key it.
        //   computeResponsibleSet  injected, because it is a method over this.config,
        //              this.providerRegistry and this.indexerDb, and every site that
        //              computes a request's responsible set has to use the one derivation.
        //
        // The snapshot height is deliberately NOT passed: the module buries the local
        // request row's own block itself, so no caller can name the height its
        // signatures are checked at.
        let verdict = await avr.verifyAttestationResponse({
            request,
            sigs,
            requestId,
            requestIdRaw,
            providerId,
            responseStatus,
            meta,
            responseBodyBytes,
            atBlock:         data['BLOCK_INDEX'],
            gateBlock:       data['BLOCK_INDEX'],
            error,
            coin:            this.config['COIN'],
            network:         this.config['NETWORK'],
            indexerDb:       this.indexerDb,
            protocolChanges: this.actions.protocolChanges,
            computeResponsibleSet: this.computeResponsibleSet.bind(this),
        });

        return verdict;
    },

    // The effects a valid response has on the request it answers. Reached only for a
    // `valid` action, so every branch here is the protocol's, not the wire's.
    async closeChainResponse(request, data, requestId, providerId, responseStatus, verifiedSigs){
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
            getLogger().info("\t ATTEST v1 : id=" + String(requestId).substring(0,16) + '...' +
                        ' : retryable status=' + responseStatus + ', request left pending for retry');
        } else {
            await this.finishChainResponse(request, data, requestId, responseStatus);
        }
    },

    // The terminal flip and everything that hangs off it: the fee settle, the relay
    // deferral, and the contract callback. The caller writes the mappings row.
    async finishChainResponse(request, data, requestId, responseStatus){
        // Flip request status to its terminal value (resolved_block anchors
        // the flip for the reorg-rollback reset)
        let newRequestStatus = (responseStatus === 'ok') ? 'fulfilled' : 'errored';
        await this.indexerDb.updateAttestationRequestStatus(data['REQUEST_ID'], newRequestStatus, data['BLOCK_INDEX']);

        // Fee disposition. Release/refund rows are written at THIS
        // v1 action_index, so a reorg of the v1 removes them generically
        // and the v0 escrow (earlier action_index) survives intact.
        await this.settleRequestFee(request, data, newRequestStatus);

        // A relay-materialized request (v3) carries the ORIGIN chain it
        // came from. Its contract lives there, not here, so BTC must not try to
        // execute a callback against a contract_index that means nothing locally.
        // The response relays back as a v4 instead and the origin chain fires the
        // callback. Self-gating: only a v3, which is itself flag-day gated, can
        // produce a row whose origin_chain differs from this coin, so no separate
        // activation check is needed and pre-activation replay is untouched.
        if(this.isForeignOrigin(request)){
            getLogger().info("\t ATTEST v1 : id=" + String(requestId).substring(0,16) + '...' +
                        ' : origin=' + request.origin_chain + ', callback deferred to the relay leg');
            return;
        }

        // Inject the callback EXECUTE. Wrapped in a savepoint so a failing callback
        // does NOT roll back the response row.
        try {
            let callbackActionIndex = await this.injectCallbackExecute(request, data);
            if(callbackActionIndex)
                await this.indexerDb.setAttestationResponseCallbackIndex(data['ACTION_INDEX'], callbackActionIndex);
        } catch(e){
            // Infra faults (VM host down, DB driver errno) must halt the block
            // rather than commit a locally-dropped callback that forks
            // contract_hash against healthy peers (see consensus/fault_guard.js).
            rethrowIfInfraFault(e);
            getLogger().warn('Attestation callback injection failed:', e);
        }
    },

    // Is this request's response served by the hub mirror rather than by an on-chain
    // ATTEST v1? Keyed on the REQUEST's own block, read from the LOCAL v0 row
    // and never from anything a hub states.
    //
    // NAMED SEAM, three callers by design: this file's mirror applier (its own gate),
    // the chain-handler gate that makes an on-chain v1 for such a request `invalid`,
    // and the broadcast-fee retirement above the height. All three must agree about
    // which era a request is in, and the only way to guarantee that is one predicate.
    // For a relayed request the local row IS the BTC v3 materialization, so
    // request.block_index is already the BTC block the flag day keys on.
    isMirrorEraRequest(request){
        if(!request) return false;
        return gateRegistry.activeAt(RESPONSE_MIRROR_KEY, this.config['NETWORK'], null, request.block_index, null);
    }
};
