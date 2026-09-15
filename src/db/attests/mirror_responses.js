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
 * XChain Indexer - Database mixin part: attests / mirror_responses
 *
 * The hub-mirrored response read pair (local requests still awaiting a response, mirror
 * rows by request id) and the two stamps a response row takes after it applies.
 * Merged into the attests mixin by db/attests/index.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // ATTEST v0 (request) rows that a hub-mirrored response could still bind to at
    // `blockIndex`: pending, and not past their deadline. This is the LOCAL half of
    // the mirror applier's applicability read (the response-mirror design §4.1); the
    // mirror half is getMirroredAttestationResponses below and the predicate that
    // joins them is utility.selectApplicableAttestationResponses.
    //
    // THE SCAN IS DRIVEN FROM THIS SIDE ON PURPOSE. The mirror table grows without
    // bound and its rows carry hub-authored columns; scanning it by
    // request_block_index (its natural window) would make the set of rows an indexer
    // even CONSIDERS depend on a field no signature covers, so two indexers following
    // two hubs could consider different sets. Every column read here is local chain
    // state, and a request leaves this set the moment it resolves or its deadline
    // passes, which is what bounds the scan without a hub-supplied bound.
    //
    // `deadline_block >= ?` is the applier's half of §4.1's `B <= deadline_block`: a
    // row whose first satisfying block is past the deadline is never selected here,
    // the expiry sweep (deadline_block < B, one step later in the same block) flips
    // the request to 'expired', and the expired callback stands (AT3). The predicate
    // is re-stated in the selector, which is where it is tested; this bound only
    // keeps the read from returning rows the selector must then discard.
    //
    // ORDER BY (block_index, action_index) is the §4.1 applier order, read from the
    // LOCAL request rows and never from the mirror row or from a request_id
    // collation, so every node applies a block's responses in one order.
    //
    // PAGED, and the page is NOT consensus. `limit` and `after` walk that same order in
    // windows so the applier can stop once it has filled its per-block cap instead of
    // dragging every pending request (and then every one of their mirror rows) into
    // memory first. Two nodes paging at different sizes still select the same rows: the
    // order is TOTAL (action_index is unique), the pages are disjoint consecutive slices
    // of it, and the caller concatenates them in page order, so the sequence it sees is
    // the same sequence the unpaged read produced. The keyset carry is (block_index,
    // action_index) rather than an offset because an offset re-reads a shifted window
    // when a row resolves between pages.
    //
    // @param {number} blockIndex the block being processed
    // @param {number} [limit] page size; omitted reads the whole set, the legacy shape
    // @param {Object} [after] exclusive keyset cursor {block_index, action_index}
    async getAttestationRequestsAwaitingMirrorResponse(blockIndex, limit, after){
        let params = [Number(blockIndex)];
        let keyset = '';
        if(after){
            keyset = ` AND (ar.block_index > ? OR (ar.block_index = ? AND ar.action_index > ?))`;
            params.push(Number(after.block_index), Number(after.block_index), Number(after.action_index));
        }
        let page = '';
        if(limit !== undefined && limit !== null){
            page = ` LIMIT ?`;
            params.push(Number(limit));
        }
        let query = `SELECT ar.*, ia.address AS fee_payer
                     FROM attests ar
                     LEFT JOIN index_addresses ia ON ia.id = ar.fee_payer_id
                     WHERE ar.version = 0
                       AND ar.request_status = 'pending'
                       AND ar.deadline_block >= ?` + keyset + `
                     ORDER BY ar.block_index ASC, ar.action_index ASC` + page;
        return await this.doQuery(query, params);
    },

    // The hub-mirrored finalized responses for a given set of request ids whose SIGNED
    // effective_time has been reached at `blockTime`. The mirror half of the applier's
    // applicability read (§4.1).
    //
    // Read through mirrorDb(), which is a SEPARATE connection whenever the indexer
    // follows a remote hub DB, so this cannot be one SQL join against local `attests`
    // (the cross_chain_calls readers above have the same split for the same reason).
    //
    // Only network and effective_time filter here, and both are safe to filter on:
    // network scopes the mirror itself, and effective_time is INSIDE the signed
    // canonical, so no hub can move a row's applying block by editing it without
    // breaking every signature on it. The informational request_block_index /
    // request_action_index columns are deliberately not read.
    //
    // Chunked because the id list is caller-sized; the chunks are re-joined by the
    // caller's own deterministic order, so chunk boundaries cannot be observed.
    //
    // ABOVE THE MIRROR-ADMISSION CONSUMER ACTIVATION at `blockHeight` the time filter takes
    // the C33 form on admit_block_btc (the one column the hub stamps on this table, because
    // attest responses are read by BTC alone), and that column is read back so the selector
    // and the verifier can rebuild the signed map from it. Below the activation the
    // statement is byte for byte the one above, and the column is not named at all.
    async getMirroredAttestationResponses(network, requestIds, blockTime, blockHeight){
        let ids = (requestIds || []).map(id => String(id || '').toLowerCase()).filter(id => id.length > 0);
        if(ids.length === 0) return [];
        let mirror = this.mirrorDb();
        let out    = [];
        const CHUNK = 500;
        let bind      = this.mirrorBindClause(Number(blockTime), blockHeight, null, 'admit_block_btc');
        let admitCols = this.mirrorAdmissionActiveAt(blockHeight) ? ', admit_block_btc' : '';
        for(let i = 0; i < ids.length; i += CHUNK){
            let chunk        = ids.slice(i, i + CHUNK);
            let placeholders = chunk.map(() => '?').join(',');
            // doQueryStrict (not doQuery): a CONSENSUS input read on the hub mirror, which
            // never holds a transaction, so doQuery turns a transient DB fault into a missing
            // attestation chunk on this node alone, and the block hashes diverge.
            let rows = await mirror.doQueryStrict(
                `SELECT request_id, provider_id, status, response_payload, response_hash, meta,
                        effective_time, signer_pubkeys, signatures, widen, batch_action_index${admitCols}
                 FROM attestation_responses
                 WHERE network = ? AND ${bind.sql} AND request_id IN (${placeholders})`,
                [String(network || '')].concat(bind.args, chunk));
            for(let row of rows) out.push(row);
        }
        return out;
    },

    // Set callback_execute_action_index on an ATTEST v1 (response) row (after the system EXECUTE is injected)
    async setAttestationResponseCallbackIndex(responseActionIndex, callbackExecuteActionIndex){
        let query = `UPDATE attests
                     SET callback_execute_action_index = ?
                     WHERE action_index = ? AND version = 1`;
        await this.doQuery(query, [callbackExecuteActionIndex, responseActionIndex]);
    },

    // Stamp the ATTEST v5/v6 batch that carried a mirror-applied response's body onto
    // the chain, keyed on the REQUEST id rather than on an action_index.
    //
    // The request id is the only identifier the two sides share. The batch is parsed on
    // the DOGE indexer and names the responses it carries by request_id; the v1 row it
    // links to was minted locally on the BTC indexer at whatever block the mirror row
    // became applicable, so its action_index means nothing to the publisher and cannot
    // be on the wire. Scoped to version = 1 because a request also has a v0 row and the
    // batch describes the response, not the request.
    //
    // Idempotent and unordered: a re-delivered or replayed batch restamps the same
    // value, and a batch that lands before the mirror row was applied simply matches no
    // row yet. That is why the column is nullable and why the coverage watermark, not
    // this write, is what proves a window reached the chain.
    async setAttestationResponseBatchIndex(requestId, batchActionIndex){
        let query = `UPDATE attests
                     SET batch_action_index = ?
                     WHERE request_id = ? AND version = 1`;
        await this.doQuery(query, [batchActionIndex, String(requestId || '').toLowerCase()]);
    },

};
