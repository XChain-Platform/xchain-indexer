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
 * The hub-mirror applier: one finalized response applied with no transaction behind it.
 *
 * Installed onto Attest.prototype by actions/attest/index.js, so call sites stay
 * this.<method>().
 *
 ********************************************************************/

'use strict';

const crypto  = require('crypto');
const { columnsAdmitBlocks } = require('../../mirror_admission_activation.js');
// The ONE response verifier: this chain path and the hub-mirror applier call the
// same module, so an artifact cannot be judged differently by delivery route.
const avr     = require('./attest_response_verify.js');
const { rethrowIfInfraFault } = require('../../consensus/fault_guard.js');
const { synthesizeTxHash, SYNTH_TAGS } = require('../../consensus/exec_context.js');
const { getLogger } = require('../../observability/index.js');
const { ATTEST_RESPONSE_BODY_MAX_BYTES, MIRROR_TERMINAL_STATUSES } = require('./constants.js');

module.exports = {
    // THE MIRROR APPLIER. Applies one finalized
    // response that arrived through the hub mirror instead of on a validator-paid
    // transaction, at the block the binding rule picked
    // (utility.selectApplicableAttestationResponses, which is where the rule lives).
    //
    // The effects are the v1 chain handler's effects, MINUS A TRANSACTION: the response
    // row, the request's terminal flip, the fee settle and the contract callback are
    // written exactly as parseResponse writes them, hung off a system-synthesized
    // ATTEST v1 action with NULL TX_INDEX/TX_VOUT and a deterministic TX_HASH. That is
    // what keeps everything downstream (rollback by action_index, `stream:action`
    // replication, the VM snapshot, the state hash, the relay's response leg) working
    // on a row it cannot distinguish from a chain-delivered one.
    //
    // AN UNVERIFIABLE ROW IS INERT, NOT INVALID. The chain path records a rejected v1
    // as an audit row because a transaction was paid for and every node saw it; nothing
    // was paid for here and a bad row must leave no trace, so this returns having
    // written NOTHING, not even an action index, and above all never marks the request.
    // Every skip reason is a deterministic function of the row and of local state, so
    // every node skips the same row for the same reason; a skip is logged once, and the
    // row stays in the mirror for audit and for the on-chain batch.
    async applyMirroredResponse(data){
        let row       = data['MIRROR_RESPONSE'];
        let request   = data['MIRROR_REQUEST'];
        let requestId = String((row && row.request_id) || '').toLowerCase();
        let skip = (why) => {
            getLogger().info("\t ATTEST mirror : id=" + requestId.substring(0,16) + '...' +
                        ' : block=' + data['BLOCK_INDEX'] + ' : SKIPPED (' + why + ')');
        };

        let gate = this.mirrorRowSkipReason(row, request);
        if(gate) return skip(gate);

        let parsed = this.mirrorRowSigs(row);
        if(parsed.skip) return skip(parsed.skip);

        let body = this.mirrorRowBody(row);
        if(body.skip) return skip(body.skip);

        let verdict = await this.verifyMirroredResponse(row, request, requestId, parsed.sigs, body.bytes, data);
        if(verdict.error)
            return skip(verdict.error);

        await this.stampMirroredResponse(data, row, request, requestId, verdict);

        await this.settleMirroredResponse(data, row, request, requestId, verdict);

        await this.mapper.createMappings(data);
    },

    // Re-gates rather than trusting the pass that selected this row: the selection
    // and the apply are separated by a synthesized action, and a guard that only
    // exists in the selector is one refactor away from being the only guard.
    //
    // Returns the skip reason, or null when the row is still applicable.
    mirrorRowSkipReason(row, request){
        if(!request || String(request.request_status) !== 'pending')
            return 'local request not pending';
        if(!this.isMirrorEraRequest(request))
            return 'request is legacy-era, response must arrive on chain';
        if(String(request.provider_id) !== String(row.provider_id))
            return 'provider_id does not match the request';
        if(MIRROR_TERMINAL_STATUSES.indexOf(String(row.status)) === -1)
            return 'non-terminal status ' + row.status;
        return null;
    },

    // Signature list, format-checked and lower-cased exactly as the wire parser does
    // it, because the shared verifier's contract is that its caller has already done
    // so. Deliberately NOT deduped here: the verifier dedupes before verifying, and
    // one implementation of that rule is the point of the module.
    //
    // Returns { sigs } or the { skip } reason the row cannot carry a signature list.
    mirrorRowSigs(row){
        let declared = null;
        try { declared = JSON.parse(String(row.signatures == null ? '' : row.signatures)); }
        catch(_){ declared = null; }
        if(!Array.isArray(declared) || declared.length === 0)
            return { skip: 'signatures column is not a non-empty JSON array' };
        let sigs = [];
        for(let s of declared){
            let pubkey = String((s && s.pubkey) || '').toLowerCase();
            let sig    = String((s && s.sig) || '').toLowerCase();
            if(!/^[0-9a-f]{64}$/.test(pubkey) || !/^[0-9a-f]{128}$/.test(sig))
                return { skip: 'signature entry format' };
            sigs.push({ pubkey, sig });
        }
        return { sigs };
    },

    // The body as bytes. The mirror stores the DECODE of the attested bytes (as
    // `attests.response_payload` does), so re-encoding is the only bytes available
    // here; a body that is not UTF-8 round-trippable cannot reproduce the hash the
    // canonical signs, and the echo check below is what makes that a clean skip
    // instead of an opaque signature failure.
    //
    // Returns { bytes } or the { skip } reason the stored body cannot be the signed one.
    mirrorRowBody(row){
        let responseBodyBytes = Buffer.from(String(row.response_payload == null ? '' : row.response_payload), 'utf8');
        if(responseBodyBytes.length > ATTEST_RESPONSE_BODY_MAX_BYTES)
            return { skip: 'body ' + responseBodyBytes.length + ' bytes over the ' + ATTEST_RESPONSE_BODY_MAX_BYTES + '-byte cap' };
        let echoHash = crypto.createHash('sha256').update(responseBodyBytes).digest('hex');
        if(echoHash !== String(row.response_hash || '').toLowerCase())
            return { skip: 'response_hash does not match the stored body' };
        return { bytes: responseBodyBytes };
    },

    async verifyMirroredResponse(row, request, requestId, sigs, responseBodyBytes, data){
        // ONE verifier for both delivery routes. Nothing about the height the
        // signatures are checked at is reachable from here: the module buries the LOCAL
        // request row's own block itself. `atBlock`/`gateBlock` are the APPLYING block,
        // which is this synthesized action's own block, so the widening ladder and the
        // lower-case-id gate are evaluated exactly where the chain path evaluates them
        // as well. requestIdRaw equals requestId because a mirror row's id is lower-case
        // hex by construction: there is no wire case to preserve.
        //
        // effectiveTime is the mirror row's SIGNED effective_time, and it is passed because
        // the mirror-era canonical appends that field: the validators signed the body plus
        // the time the response became effective, so a verifier that omitted it would build
        // the legacy canonical and refuse every honest hub-signed row. The shared module
        // threads whatever the caller passes into the canonical it verifies against, so the
        // chain path and this one differ only in where the field comes from.
        let verdict = await avr.verifyAttestationResponse({
            request,
            sigs,
            requestId,
            requestIdRaw:    requestId,
            providerId:      row.provider_id,
            responseStatus:  row.status,
            meta:            row.meta,
            responseBodyBytes,
            effectiveTime:   Number(row.effective_time),
            // The row's stored admission map (BTC-only on this rail), rebuilt from the
            // mirrored column so the verifier reproduces the bytes the hub signed;
            // null is the legacy row, and an admission-era row with none is refused.
            admitBlocks:     columnsAdmitBlocks(row),
            atBlock:         data['BLOCK_INDEX'],
            gateBlock:       data['BLOCK_INDEX'],
            error:           null,
            coin:            this.config['COIN'],
            network:         this.config['NETWORK'],
            indexerDb:       this.indexerDb,
            protocolChanges: this.actions.protocolChanges,
            computeResponsibleSet: this.computeResponsibleSet.bind(this),
        });

        return verdict;
    },

    // The verified row's own action: its index, its deterministic synthetic tx hash and
    // the columns the chain path stamps, so the two rows are indistinguishable.
    async stampMirroredResponse(data, row, request, requestId, verdict){
        // Verified. Only now does the row get an action: minting first would leave a
        // gap in the action sequence for a row that wrote nothing.
        data['ACTION_INDEX'] = await this.indexerDb.createActionIndex({
            ACTION:      'ATTEST',
            BLOCK_INDEX: data['BLOCK_INDEX'],
            FORMAT:      1
        }, true);
        // Deterministic synthetic TX_HASH: sha256('ATTESTMIRROR:<network>:<chain>:<request_id>')
        // (execContext.synthesizeTxHash). Namespaced by request_id, which is unique per
        // request and derived from chain data, so every node derives the same hash and
        // anything the callback emits (ATTEST/XCALL/emit.execute) gets ids that resolve.
        data['TX_HASH'] = synthesizeTxHash(
            SYNTH_TAGS.ATTEST_MIRROR_RESPONSE, this.config['NETWORK'], this.config['CHAIN'], requestId);

        data['REQUEST_ID']       = requestId;
        data['PROVIDER_ID']      = row.provider_id;
        data['RESPONSE_PAYLOAD'] = String(row.response_payload == null ? '' : row.response_payload);
        data['RESPONSE_STATUS']  = String(row.status);
        data['META']             = row.meta;
        data['RESPONSE_HASH']    = verdict.responseHash;
        data['VALID_SIGS']       = verdict.validSigs;
        data['STATUS']           = 'valid';
        // Same inlined JSON the chain path stores, so a mirror-fed node's row and a
        // chain-fed node's row are byte-identical (a test asserts exactly that).
        data['VALIDATOR_SIGNATURES'] = verdict.verifiedSigs.length
            ? JSON.stringify(verdict.verifiedSigs.map(s => ({ pubkey: s.pubkey, sig: s.sig })))
            : null;

        getLogger().info("\t ATTEST mirror : id=" + requestId.substring(0,16) + '...' +
                    ' : status=' + data['RESPONSE_STATUS'] +
                    ' : sigs=' + verdict.validSigs + '/' + request.redundancy +
                    ' : effective=' + row.effective_time +
                    ' : block=' + data['BLOCK_INDEX'] + ' (no transaction)');
    },

    // Everything the applied row settles: the response row, the request's terminal flip,
    // the fee, and the contract callback. The caller writes the mappings row.
    async settleMirroredResponse(data, row, request, requestId, verdict){
        await this.indexerDb.createAttestationResponse(data);

        // The v5/v6 batch carrying this body can land BEFORE the row binds (the chain-only
        // rebuild inserts the mirror row with its link already stamped), in which case the
        // mirror's own stamp found no v1 row to write it onto. Fires only when the selected
        // mirror row carries the column, and the link is display only either way.
        if(row.batch_action_index != null)
            await this.indexerDb.setAttestationResponseBatchIndex(requestId, row.batch_action_index);

        if(String(data['RESPONSE_STATUS']) === 'ok'){
            for(let s of verdict.verifiedSigs){
                await this.indexerDb.incrementAttestationValidatorStat(
                    s.pubkey, String(row.provider_id), 'fulfilled_count', data['BLOCK_INDEX']
                );
            }
        }

        // Terminal by construction: the mirror carries no retryable status, so there is
        // no leave-the-request-pending branch here (the chain path's RETRYABLE_STATUSES).
        let newRequestStatus = (String(data['RESPONSE_STATUS']) === 'ok') ? 'fulfilled' : 'errored';
        await this.indexerDb.updateAttestationRequestStatus(requestId, newRequestStatus, data['BLOCK_INDEX']);

        // Fee disposition at THIS synthesized action's index, so a reorg of the applying
        // block removes the settle rows generically while the v0 escrow survives.
        await this.settleRequestFee(request, data, newRequestStatus);

        // A relay-materialized request's contract lives on the origin chain; the response
        // goes back as a v4 and the callback fires there (the same guard the chain path
        // has, for the same reason).
        if(this.isForeignOrigin(request)){
            getLogger().info("\t ATTEST mirror : id=" + requestId.substring(0,16) + '...' +
                        ' : origin=' + request.origin_chain + ', callback deferred to the relay leg');
            return;
        }

        try {
            let callbackActionIndex = await this.injectCallbackExecute(request, data);
            if(callbackActionIndex)
                await this.indexerDb.setAttestationResponseCallbackIndex(data['ACTION_INDEX'], callbackActionIndex);
        } catch(e){
            // Infra faults halt the block rather than commit a locally-dropped callback
            // that forks contract_hash against healthy peers (consensus/fault_guard.js).
            rethrowIfInfraFault(e);
            getLogger().warn('Mirror-applied attestation callback injection failed:', e);
        }
    }
};
