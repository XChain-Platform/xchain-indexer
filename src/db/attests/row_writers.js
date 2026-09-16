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
 * XChain Indexer - Database mixin part: attests / row_writers
 *
 * The three action-indexed writers of the consolidated attests table: the ATTEST v0
 * request row, the v1 response row and the v5/v6 batch audit row.
 * Merged into the attests mixin by db/attests/index.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const { getLogger } = require('../../observability/index.js');

// The column values of one ATTEST v0 request row, resolved from the normalized action
// data in the order the writer has always resolved them (status, fee payer, then the
// fee tick), so the lookup-table ids those calls mint are minted in the same order.
async function requestColumns(db, data){
    let status_id        = await db.createStatus(data['STATUS']);
    let fee_payer_id     = await db.getAddressId(data['FEE_PAYER']);
    let action_index     = data['ACTION_INDEX'];
    let request_id       = String(data['REQUEST_ID'] || '').toLowerCase();
    let contract_index   = data['CONTRACT_INDEX'];
    let provider_id      = data['PROVIDER_ID'];
    let payload          = data['REQUEST_PAYLOAD'] || null;
    let callback_method  = data['CALLBACK_METHOD'];
    let callback_params  = data['CALLBACK_PARAMS'] || null;
    let redundancy       = Number(data['REDUNDANCY']) || 0;
    let deadline_block   = data['DEADLINE_BLOCK'] || 0;
    let gas_escrow       = data['GAS_ESCROW'] || '0';
    let request_status   = data['REQUEST_STATUS'] || 'pending';
    let block_index      = data['BLOCK_INDEX'];
    // Optional request fee (E1): tick resolved to an id (NULL = feeless)
    let fee_tick_id      = !db.util.isNull(data['FEE_TICK']) ? await db.createTicker(data['FEE_TICK']) : null;
    let fee_amount       = !db.util.isNull(data['FEE_AMOUNT']) ? String(data['FEE_AMOUNT']) : null;
    // ATT-RECOMP-1: the ordered responsible-set pubkeys pinned as-of block_index at request
    // time (JSON array string), so the reorg missed_count recompute reads the historical set
    // verbatim instead of re-deriving it against the CURRENT mutable stakes.amount. NULL for
    // rejected/feeless-legacy rows (the recompute falls back to the live re-derive).
    let responsible_set  = !db.util.isNull(data['RESPONSIBLE_SET_JSON']) ? String(data['RESPONSIBLE_SET_JSON']) : null;
    // Cross-chain relay: NULL on every native single-chain request, so a
    // pre-activation replay writes exactly the columns it wrote before. Set to the
    // origin chain on a relay-eligible LTC/DOGE v0 (what the hub's relay poll keys
    // on) and on the BTC v3 row that materializes it (where it also suppresses the
    // local callback, since the contract is not on BTC).
    let origin_chain     = !db.util.isNull(data['ORIGIN_CHAIN']) ? String(data['ORIGIN_CHAIN']) : null;
    let origin_action    = !db.util.isNull(data['ORIGIN_ACTION_INDEX']) ? Number(data['ORIGIN_ACTION_INDEX']) : null;
    return { status_id, fee_payer_id, action_index, request_id, contract_index, provider_id, payload,
             callback_method, callback_params, redundancy, deadline_block, gas_escrow, request_status,
             block_index, fee_tick_id, fee_amount, responsible_set, origin_chain, origin_action };
}

module.exports = {

    // Create/Update an ATTEST v0 (request) row in the consolidated `attests` table
    async createAttestationRequest(data){
        data                 = this.normalizeDataValues(data);
        let { status_id, fee_payer_id, action_index, request_id, contract_index, provider_id, payload,
              callback_method, callback_params, redundancy, deadline_block, gas_escrow, request_status,
              block_index, fee_tick_id, fee_amount, responsible_set, origin_chain,
              origin_action } = await requestColumns(this, data);

        let query  = "SELECT action_index FROM attests WHERE action_index=? LIMIT 1";
        let exists = false;
        let results = await this.doQuery(query, [action_index]);
        if(results.length > 0) exists = true;
        if(exists){
            query = `UPDATE attests SET
                        version=0, request_id=?, contract_index=?, fee_payer_id=?, provider_id=?, payload=?,
                        callback_method=?, callback_params_json=?, redundancy=?, deadline_block=?,
                        gas_escrow=?, fee_tick_id=?, fee_amount=?, responsible_set_json=?,
                        origin_chain=?, origin_action_index=?, request_status=?, status_id=?, block_index=?
                    WHERE action_index=?`;
            await this.doQuery(query, [
                request_id, contract_index, fee_payer_id, provider_id, payload,
                callback_method, callback_params, redundancy, deadline_block,
                gas_escrow, fee_tick_id, fee_amount, responsible_set,
                origin_chain, origin_action, request_status, status_id, block_index, action_index
            ]);
        } else {
            // v0 single-request integrity. The (request_id, version) index was relaxed to
            // non-unique so multiple v1 response rounds can coexist (#4373); that also drops
            // the DB-level guard against a second v0 for one request_id. The request_id preimage
            // is collision-free, so this should never fire, but guard deterministically against
            // an un-threaded emission path: keep the first v0 row canonical and skip the
            // duplicate rather than splitting one request across two rows.
            let priorV0 = await this.doQuery("SELECT action_index FROM attests WHERE request_id=? AND version=0 LIMIT 1", [request_id]);
            if(priorV0.length > 0){
                getLogger().warn('createAttestationRequest: duplicate v0 for request_id=' + request_id +
                             ' (keeping action_index=' + priorV0[0].action_index + ', skipping ' + action_index + ')');
                return;
            }
            query = `INSERT INTO attests
                        (action_index, version, request_id, contract_index, fee_payer_id, provider_id, payload,
                         callback_method, callback_params_json, redundancy, deadline_block,
                         gas_escrow, fee_tick_id, fee_amount, responsible_set_json,
                         origin_chain, origin_action_index, request_status, status_id, block_index)
                    VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            await this.doQuery(query, [
                action_index, request_id, contract_index, fee_payer_id, provider_id, payload,
                callback_method, callback_params, redundancy, deadline_block,
                gas_escrow, fee_tick_id, fee_amount, responsible_set,
                origin_chain, origin_action, request_status, status_id, block_index
            ]);
        }
    },

    // Create/Update an ATTEST v1 (response) row in the consolidated `attests` table.
    // The verified federation signatures ride in the validator_signatures JSON
    // column (data['VALIDATOR_SIGNATURES'] - a JSON array string, or null) rather
    // than in a separate child table. Keyed on action_index: the retry-then-ok
    // lifecycle (#4373) produces MULTIPLE v1 rows per request_id (one per PBFT round,
    // a retryable round then the terminal ok), each its own immutable action-indexed
    // row, so (request_id, version) is intentionally NOT unique.
    async createAttestationResponse(data){
        data                 = this.normalizeDataValues(data);
        let status_id        = await this.createStatus(data['STATUS']);
        let action_index     = data['ACTION_INDEX'];
        let request_id       = String(data['REQUEST_ID'] || '').toLowerCase();
        let provider_id      = data['PROVIDER_ID'];
        let response_hash    = String(data['RESPONSE_HASH'] || '').toLowerCase();
        let response_payload = data['RESPONSE_PAYLOAD'] || null;
        let response_status  = data['RESPONSE_STATUS'];
        let meta             = data['META'] || null;
        let signatures       = data['VALIDATOR_SIGNATURES'] || null;
        let block_index      = data['BLOCK_INDEX'];

        let query  = "SELECT action_index FROM attests WHERE action_index=? LIMIT 1";
        let exists = false;
        let results = await this.doQuery(query, [action_index]);
        if(results.length > 0) exists = true;
        if(exists){
            query = `UPDATE attests SET
                        version=1, request_id=?, provider_id=?, response_hash=?, response_payload=?,
                        response_status=?, meta=?, validator_signatures=?, status_id=?, block_index=?
                    WHERE action_index=?`;
            await this.doQuery(query, [
                request_id, provider_id, response_hash, response_payload,
                response_status, meta, signatures, status_id, block_index, action_index
            ]);
        } else {
            query = `INSERT INTO attests
                        (action_index, version, request_id, provider_id, response_hash, response_payload,
                         response_status, meta, validator_signatures, status_id, block_index)
                    VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            await this.doQuery(query, [
                action_index, request_id, provider_id, response_hash, response_payload,
                response_status, meta, signatures, status_id, block_index
            ]);
        }
    },

    // Create the audit row for an ATTEST v5/v6 batch action in the consolidated `attests`
    // table. Keyed on action_index like every other row there.
    //
    // A batch action carries no request, no provider and no response body, so this writes
    // only the four columns that mean something for it:
    //   version      5 (head) or 6 (continuation)
    //   request_id   THE BATCH KEY. The column's role is "correlation key across versions",
    //                and for the batch pair that is exactly what this is: a continuation
    //                names its head by this value and nothing else. Empty on a wire so
    //                malformed that no key could be derived from it.
    //   provider_id  '' - NOT NULL with no provider to name, the same reason a rejected
    //                ATTEST v4 with no matching request stores the empty string.
    //   status_id    the batch verdict, which is what a replay re-derives.
    //
    // The wire BODY is deliberately not stored: absorption happens at parse time from the
    // action's own params, so persisting the compressed bytes would duplicate chain data
    // this table has no reader for. A cross-action chunk store, which head-side reassembly
    // of a MULTI-chunk batch needs, is separate work: it wants its own columns on this
    // table rather than a reinterpretation of these.
    async createAttestationBatchAction(data){
        data             = this.normalizeDataValues(data);
        let status_id    = await this.createStatus(data['STATUS']);
        let action_index = data['ACTION_INDEX'];
        let version      = Number(data['VERSION']);
        let batch_key    = String(data['REQUEST_ID'] || '').toLowerCase();
        let block_index  = data['BLOCK_INDEX'];

        // The chunk-table half of the row: this action's slot, its body slice, and (on a
        // head) the window header the completing action reassembles against. Absent on a
        // structurally broken wire, where nothing was parsed to store.
        let num = (v) => (v != null && v !== '') ? Number(v) : null;
        let str = (v) => (v != null && v !== '') ? String(v)  : null;
        let window_start     = num(data['WINDOW_START']);
        let window_end       = num(data['WINDOW_END']);
        let row_count        = num(data['ROW_COUNT']);
        let btc_block_height = num(data['BTC_BLOCK_HEIGHT']);
        let batch_crc32      = str(data['BATCH_CRC32']);
        let total_chunks     = num(data['TOTAL_CHUNKS']);
        let chunk_index      = num(data['CHUNK_INDEX']);
        let chunk_b64        = str(data['CHUNK_B64']);

        let results = await this.doQuery("SELECT action_index FROM attests WHERE action_index=? LIMIT 1", [action_index]);
        if(results.length > 0){
            await this.doQuery(`UPDATE attests SET
                                    version=?, request_id=?, provider_id='', status_id=?, block_index=?,
                                    batch_window_start=?, batch_window_end=?, batch_row_count=?,
                                    batch_btc_block_height=?, batch_crc32=?, batch_total_chunks=?,
                                    batch_chunk_index=?, batch_chunk_b64=?
                                WHERE action_index=?`,
                [version, batch_key, status_id, block_index,
                 window_start, window_end, row_count, btc_block_height,
                 batch_crc32, total_chunks, chunk_index, chunk_b64, action_index]);
        } else {
            await this.doQuery(`INSERT INTO attests
                                    (action_index, version, request_id, provider_id, status_id, block_index,
                                     batch_window_start, batch_window_end, batch_row_count,
                                     batch_btc_block_height, batch_crc32, batch_total_chunks,
                                     batch_chunk_index, batch_chunk_b64)
                                VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [action_index, version, batch_key, status_id, block_index,
                 window_start, window_end, row_count, btc_block_height,
                 batch_crc32, total_chunks, chunk_index, chunk_b64]);
        }
    },

};
