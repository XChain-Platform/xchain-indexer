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
 * XChain Indexer - Database mixin part: attests / request_queues
 *
 * The multi-row request listings: the pending queue the hub polls, the materialized
 * relay legs, and the capped deadline-expiry sweep.
 * Merged into the attests mixin by db/attests.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

// Per-block cap on the ATTEST deadline-expiry sweep. Vendored
// byte-identical from xchain-documentation/protocol/constants.js, same convention
// as the XCALL_MAX_CALLS_PER_BLOCK sibling it mirrors.
const { ATTEST_MAX_EXPIRIES_PER_BLOCK,
        CROSS_SETTLE_MAX_PER_BLOCK,
        ORACLE_VM_ROUND_WINDOW,
        ORACLE_VM_MAX_ROWS } = require('../../protocol/constants.js');

module.exports = {

    // List ATTEST v0 (request) rows currently in 'pending' status, ordered by
    // creation. xchain-hub's AttestationRound polls this to discover work.
    // Optional providerId filter lets a validator only see requests for
    // providers it serves.
    async getPendingAttestationRequests(providerId, limit, cursor){
        let where = "request_status = 'pending'";
        let args  = [];
        if(providerId){
            where += ' AND provider_id = ?';
            args.push(String(providerId));
        }
        where += ' AND version = 0';
        // Keyset/cursor pagination. When the caller passes the last
        // (block_index, action_index) it has already consumed, return only rows
        // strictly after it. This lets a poller page through more than `limit`
        // pending requests across successive calls instead of being permanently
        // pinned to the oldest `limit` rows - without a cursor, a backlog larger
        // than `limit` starves every newer request until the oldest ones drain.
        let afterBlock  = cursor ? Number(cursor.after_block_index)  : NaN;
        let afterAction = cursor ? Number(cursor.after_action_index) : NaN;
        if(Number.isFinite(afterBlock) && Number.isFinite(afterAction)){
            where += ' AND (block_index > ? OR (block_index = ? AND action_index > ?))';
            args.push(afterBlock, afterBlock, afterAction);
        }
        // Floor + hard-cap here at the interpolation site so the row count is
        // always a bounded integer regardless of caller: a fractional limit
        // (e.g. 100.5) would produce `LIMIT 100.5`, a MariaDB syntax error that
        // throws and fails the whole attestation-work poll, and an unclamped large
        // integer would be an unbounded scan. The RPC layer also range-clamps, but
        // this method owns the SQL so it enforces the invariant for every caller.
        let max = Number(limit);
        max = (Number.isFinite(max) && max > 0) ? Math.min(Math.floor(max), 500) : 100;
        let query = `SELECT action_index, request_id, contract_index, fee_payer_id, provider_id,
                            payload, callback_method, callback_params_json,
                            redundancy, deadline_block, gas_escrow, fee_tick_id, fee_amount,
                            origin_chain, origin_action_index,
                            request_status, status_id, block_index
                     FROM attests
                     WHERE ` + where + `
                     ORDER BY block_index ASC, action_index ASC
                     LIMIT ?`;
        args.push(max);
        let rows = await this.doQuery(query, args);
        // Convert BigInt columns to Number so the express JSON serializer
        // doesn't throw `TypeError: Do not know how to serialize a BigInt`.
        // Bounded chain values (block heights, action indexes) stay well
        // within Number.MAX_SAFE_INTEGER on a regtest or production network.
        return rows.map(r => ({
            ...r,
            action_index:   typeof r.action_index   === 'bigint' ? Number(r.action_index)   : r.action_index,
            contract_index: typeof r.contract_index === 'bigint' ? Number(r.contract_index) : r.contract_index,
            fee_payer_id:   typeof r.fee_payer_id   === 'bigint' ? Number(r.fee_payer_id)   : r.fee_payer_id,
            fee_tick_id:    typeof r.fee_tick_id    === 'bigint' ? Number(r.fee_tick_id)    : r.fee_tick_id,
            deadline_block: typeof r.deadline_block === 'bigint' ? Number(r.deadline_block) : r.deadline_block,
            status_id:      typeof r.status_id      === 'bigint' ? Number(r.status_id)      : r.status_id,
            // NULL on every native request. Non-null marks the row as one leg of a
            // cross-chain relay, which is what the hub's relay driver filters on.
            origin_action_index: typeof r.origin_action_index === 'bigint' ? Number(r.origin_action_index) : r.origin_action_index,
            block_index:    typeof r.block_index    === 'bigint' ? Number(r.block_index)    : r.block_index
        }));
    },

    // Cross-chain relay: every ATTEST v0 request this chain holds only as a MATERIALIZED
    // relay leg, i.e. whose row carries an origin_chain that is some OTHER chain, with
    // its terminal response attached when one exists. On BTC that is exactly the set of
    // v3-materialized requests, at any lifecycle status. The predicate is
    // self-restricting rather than coin-gated: on an ORIGIN chain a relay-eligible
    // row's origin_chain equals that coin, so it never matches and this returns empty.
    //
    // ONE READ, TWO QUESTIONS, and the first is why it is driven by the request rather
    // than the response. xchain-hub's relay driver must not materialize a request that
    // is already on BTC, and its only home-side view was the PENDING queue: a request
    // that had been fulfilled or had expired was no longer pending, so it read as
    // never materialized and the driver would broadcast a second v3, which v3 admission
    // rejects as a duplicate REQUEST_ID after the fee is already spent. Returning the
    // request row whatever its status answers that; the LEFT JOIN answers the second
    // question, which response is owed back to the origin chain as an ATTEST v4.
    //
    // The response join is deliberately narrow. Only the two TERMINAL statuses can
    // relay: the retryable ones (no_quorum / timeout / provider_error) leave the
    // request pending for another round, and relaying one would close an origin
    // request the home chain still intends to fulfill. That, plus the valid-status
    // match, is what makes the join produce AT MOST one response row per request: the
    // retry-then-ok lifecycle writes several v1 rows, but only one can be both valid
    // and terminal, every later one being rejected as 'REQUEST already fulfilled'.
    // The status id is resolved once and compared as an integer so the filter can sit
    // in the ON clause, where a LEFT JOIN needs it, without a third join.
    //
    // response_hash is returned alongside response_payload deliberately: the stored
    // payload is the UTF-8 DECODE of the bytes that were hashed, so a non-UTF-8
    // attested body cannot be re-encoded to the same bytes. The caller compares the
    // two and refuses to relay a body it cannot reproduce (see AttestationRelay).
    async getRelayedAttestationRequests(coin, requestId, limit, cursor){
        let validStatusId = await this.getStatusId('valid');
        let where = `req.version = 0
                       AND req.origin_chain IS NOT NULL
                       AND req.origin_chain <> ?`;
        let args = [validStatusId, String(coin || '')];
        if(requestId){
            where += ' AND req.request_id = ?';
            args.push(String(requestId).toLowerCase());
        }
        // Same keyset cursor contract as getPendingAttestationRequests: the caller pages
        // forward by the last (block_index, action_index) it consumed, so a backlog
        // larger than `limit` does not starve newer rows forever. The cursor is on the
        // REQUEST's pair, which is the ordering, so a caller can page this read with
        // exactly the code it uses for the pending one.
        let afterBlock  = cursor ? Number(cursor.after_block_index)  : NaN;
        let afterAction = cursor ? Number(cursor.after_action_index) : NaN;
        if(Number.isFinite(afterBlock) && Number.isFinite(afterAction)){
            where += ' AND (req.block_index > ? OR (req.block_index = ? AND req.action_index > ?))';
            args.push(afterBlock, afterBlock, afterAction);
        }
        // Floored and hard-capped here, at the interpolation site, for the same reason
        // getPendingAttestationRequests does it: a fractional limit is a MariaDB syntax
        // error and an unclamped one is an unbounded scan, and this method owns the SQL.
        let max = Number(limit);
        max = (Number.isFinite(max) && max > 0) ? Math.min(Math.floor(max), 500) : 100;
        let query = `SELECT req.action_index, req.block_index, req.request_id, req.provider_id,
                            req.origin_chain, req.origin_action_index, req.request_status,
                            resp.action_index  AS response_action_index,
                            resp.block_index   AS response_block_index,
                            resp.response_hash, resp.response_payload,
                            resp.response_status, resp.meta
                     FROM attests req
                     LEFT JOIN attests resp
                            ON (resp.request_id = req.request_id
                                AND resp.version = 1
                                AND resp.status_id = ?
                                AND resp.response_status IN ('ok','expired'))
                     WHERE ` + where + `
                     ORDER BY req.block_index ASC, req.action_index ASC
                     LIMIT ?`;
        args.push(max);
        let rows = await this.doQuery(query, args);
        // BigInt -> Number for the express JSON serializer, as in
        // getPendingAttestationRequests; every column here is a bounded chain value.
        return rows.map(r => ({
            ...r,
            action_index:          typeof r.action_index          === 'bigint' ? Number(r.action_index)          : r.action_index,
            block_index:           typeof r.block_index           === 'bigint' ? Number(r.block_index)           : r.block_index,
            response_action_index: typeof r.response_action_index === 'bigint' ? Number(r.response_action_index) : r.response_action_index,
            response_block_index:  typeof r.response_block_index  === 'bigint' ? Number(r.response_block_index)  : r.response_block_index,
            origin_action_index:   typeof r.origin_action_index   === 'bigint' ? Number(r.origin_action_index)   : r.origin_action_index
        }));
    },

    // Find ATTEST v0 (request) rows whose deadline_block has passed without a response.
    // Returns full rows so the expiry handler doesn't have to refetch.
    //
    // CAPPED per block at ATTEST_MAX_EXPIRIES_PER_BLOCK. Unbounded, one
    // block could inherit an arbitrary backlog of expiries, each of which synthesizes
    // an ATTEST v2 and fires a contract callback, so block processing time became a
    // function of how many deadlines happened to coincide: an attacker picks that
    // number by batching requests on a common deadline.
    //
    // The overflow is NOT dropped, it carries to the next block. That is safe only
    // because the ORDER BY is a TOTAL order: deadline_block is not unique, but
    // action_index is, so (deadline_block ASC, action_index ASC) has exactly one
    // valid ordering and every node takes the same prefix. A cap over a partial or
    // planner-dependent order would let two nodes select different subsets and fork,
    // which is why the ordering is spelled out here rather than left implicit.
    async getExpiredAttestationRequests(blockIndex, limit = ATTEST_MAX_EXPIRIES_PER_BLOCK){
        let query = `SELECT ar.*, ia.address AS fee_payer
                     FROM attests ar
                     LEFT JOIN index_addresses ia ON ia.id = ar.fee_payer_id
                     WHERE ar.version = 0
                       AND ar.request_status = 'pending'
                       AND ar.deadline_block < ?
                     ORDER BY ar.deadline_block ASC, ar.action_index ASC
                     LIMIT ?`;
        return await this.doQuery(query, [blockIndex, limit]);
    },

};
