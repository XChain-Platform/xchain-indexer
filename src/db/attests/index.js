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
 * XChain Indexer - Database mixin: attests
 * 
 * The queries over the attests table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const path    = require('path');
const { CHECKPOINT_VERSIONS: ANCHOR_CHECKPOINT_VERSIONS,
        ARCHIVE_CHUNK_SET_SQL, ARCHIVE_CHUNK_SET_BY_AUTHOR_SQL,
        ARCHIVE_ANCHOR_BY_CONTENT_SQL, selectArchiveHeadRow,
        dedupeArchiveChunks } = require('../../actions/anchor/anchor_action_query');
// The frozen anchor/archive reward heights: the derive flag-day and the fleet-agreed
// mirror-completeness watermark. Recovery-restored rewards claim their ORIGINAL derive
// height from here, so a restored row and a live-derived one carry the same stamp.
const ar = require('../../anchor_reward_activation.js');
// The attests mixin is cut into parts by behaviour under attests/; this entry merges them
// back into the one method set db/index.js installs, at the position those methods held here.
const rowWriters       = require('./row_writers.js');
const batchChunks      = require('./batch_chunks.js');
const validatorStats   = require('./validator_stats.js');
const requestLookups   = require('./request_lookups.js');
const requestQueues    = require('./request_queues.js');
const mirrorResponses  = require('./mirror_responses.js');

module.exports = {

    // Build the read-only attestation-response snapshot the VM exposes through
    // xchain.attestation.getResponse(requestId). Scoped to fulfilled requests emitted by
    // THIS contract (the v0 request row's contract_index), visible as-of blockIndex.
    // Returns a SERIALIZABLE snapshot { responses: { [request_id]: { status, payload,
    // providerId, blockIndex, validatorCount } } }; xchain-vm/src/readonly_accessors.js
    // rebuilds the synchronous getResponse accessor from it inside the forked worker
    // (so this returns plain data, not closures, exactly like getContractStakeDataForVM).
    // Only wired into the snapshot at/after the VM_ATTESTATION_GETRESPONSE flag-day; below
    // it execute.js passes attestationData:null and getResponse() returns null.
    //
    // Dedup (#4373): the retry-then-ok lifecycle can write MULTIPLE v1 rows per request_id
    // (a retryable no_quorum/provider_error round, then the terminal ok). getResponse must
    // surface the response the callback fired on - the terminal ok - so we select only
    // response_status='ok' rows and, on the (defensive) chance more than one exists, keep
    // the EARLIEST by (block_index, action_index). A fulfilled request has exactly one ok
    // in practice, but the tie-break keeps the choice deterministic regardless.
    //
    // Determinism + bounding: only 'valid' rows with block_index <= blockIndex are visible
    // (an ok response that lands in a later block, or is rolled back, is not observable
    // as-of this block). The result is capped at the most-recent GETRESPONSE_MAX fulfilled
    // requests, ordered newest-first, so the surviving set is identical on every node; a
    // contract reading a request older than the cap deterministically sees null on all
    // nodes (the callback already delivered that response at fulfillment time, and a
    // contract needing it long-term persists it to its own state).
    async getAttestationDataForVM(contractIndex, blockIndex){
        // Most-recent-N cap. Keeps the per-EXECUTE snapshot bounded (each payload can be
        // up to the provider's max_response_bytes) while covering the re-consult-recent
        // use case; the value is consensus-critical (it decides snapshot membership), so
        // a change is a flag-day, not a config knob.
        const GETRESPONSE_MAX = 100;
        let responses = {};
        let valid_id = await this.getStatusId('valid');
        if(valid_id === null) return { responses };
        let query = `SELECT v1.request_id, v1.provider_id, v1.response_payload, v1.response_status,
                            v1.validator_signatures, v1.block_index, v1.action_index
                     FROM attests v1
                         INNER JOIN attests v0 ON (v0.request_id = v1.request_id AND v0.version = 0)
                     WHERE v1.version = 1
                       AND v1.response_status = 'ok'
                       AND v1.status_id = ?
                       AND v1.block_index <= ?
                       AND v0.contract_index = ?
                       AND v0.status_id = ?
                     ORDER BY v1.block_index DESC, v1.action_index DESC
                     LIMIT ?`;
        let rows = await this.doQuery(query, [valid_id, Number(blockIndex), Number(contractIndex), valid_id, GETRESPONSE_MAX]);
        // rid -> chosen row's (block, action), so the earliest-ok tie-break is explicit
        // and does not rely on the SQL ordering alone.
        let chosen = {};
        for(let row of rows){
            let rid = String(row.request_id || '').toLowerCase();
            if(!rid) continue;
            let cb = Number(row.block_index);
            let ca = Number(row.action_index);
            let prev = chosen[rid];
            if(prev !== undefined && !(cb < prev.block || (cb === prev.block && ca < prev.action)))
                continue;
            // validatorCount = number of verified federation signatures inlined on the
            // response row (JSON array); a malformed/absent column reads as 0.
            let vc = 0;
            if(row.validator_signatures){
                try { let arr = JSON.parse(row.validator_signatures); if(Array.isArray(arr)) vc = arr.length; }
                catch(e){ vc = 0; }
            }
            responses[rid] = {
                status:         String(row.response_status),
                payload:        row.response_payload != null ? String(row.response_payload) : '',
                providerId:     String(row.provider_id || ''),
                blockIndex:     cb,
                validatorCount: vc
            };
            chosen[rid] = { block: cb, action: ca };
        }
        return { responses };
    },

    /*
     * External attestation framework - see specs/2026-05-24_external-attestation-framework.md
     */

    ...rowWriters,

    ...batchChunks,

    ...validatorStats,

    ...requestLookups,

    ...requestQueues,

    ...mirrorResponses,

};
