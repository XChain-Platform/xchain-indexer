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
 * XChain Indexer - Database mixin part: attests / request_lookups
 *
 * Single-request reads of ATTEST v0 rows (by request id, by relay origin, admitted
 * only), the per-block admission counts, and the request_status flip.
 * Merged into the attests mixin by db/attests/index.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Look up an ATTEST v0 (request) row by its request_id (64-hex hash)
    async getAttestationRequestById(requestId){
        let query = `SELECT ar.*, ia.address AS fee_payer
                     FROM attests ar
                     LEFT JOIN index_addresses ia ON ia.id = ar.fee_payer_id
                     WHERE ar.request_id = ? AND ar.version = 0
                     ORDER BY ar.action_index ASC
                     LIMIT 1`;
        let rows = await this.doQuery(query, [String(requestId || '').toLowerCase()]);
        return rows.length > 0 ? rows[0] : null;
    },

    // Per-block ATTEST v0 admission counts, for the spec §11.1 caps
    // (attest_request_cap_activation.js). Returns { total, byContract }: admitted v0
    // requests EARLIER IN THIS BLOCK, and how many of those came from `contractIndex`.
    //
    // Deterministic by construction, which is the whole requirement for a consensus
    // gate. Every node processes a block's actions in action_index order inside one
    // transaction, so `action_index < ?` selects exactly the earlier admissions of this
    // block and nothing else; action_index is unique, so the order is total and every
    // node sees the same prefix at the same action. A from-genesis replay reproduces it.
    //
    // 'rejected' rows are excluded for the same reason the relay lookup below excludes
    // them: a refused request never escrowed a fee and was never served, so it consumed
    // no slot. Counting them would let one malformed request burn capacity, which turns
    // an anti-abuse cap into an abuse vector.
    //
    // doQueryStrict, not doQuery: a swallowed DB fault here would silently return zero
    // counts and admit past the cap. A throw rolls the block back and retries it, which
    // is the correct answer to a DB fault on a consensus path.
    async getAttestationAdmissionCounts(blockIndex, actionIndex, contractIndex){
        let query = `SELECT COUNT(*) AS total,
                            COALESCE(SUM(CASE WHEN contract_index = ? THEN 1 ELSE 0 END), 0) AS by_contract
                     FROM attests
                     WHERE version = 0
                       AND block_index = ?
                       AND action_index < ?
                       AND request_status <> 'rejected'`;
        let rows = await this.doQueryStrict(query, [contractIndex, Number(blockIndex), Number(actionIndex)]);
        let row  = (rows && rows.length > 0) ? rows[0] : {};
        return {
            total:      Number(row.total || 0),
            byContract: Number(row.by_contract || 0)
        };
    },

    // Cross-chain relay: look up the ATTEST v0 row that already materialized a given relay
    // identity (origin_chain, origin_action_index) on this chain. This is the exactly-once
    // key the v3 admission guard needs and request_id cannot supply: request_id derives
    // from the ORIGIN tx_hash, so a reorg that re-emits the same origin action from a
    // different transaction yields a new request_id for the same identity.
    //
    // 'rejected' rows are excluded deliberately. A rejected row never enters the pending
    // pool, is never fulfilled and spends no fee, so it consumed no exactly-once slot;
    // counting it would let anyone permanently block a legitimate materialization by
    // broadcasting one malformed v3 naming the same origin action. ORDER BY action_index
    // keeps the FIRST materialization canonical on every node.
    //
    // doQueryStrict, not doQuery, and the difference is a fork. This read is a CONSENSUS
    // INPUT: null here is what admits the v3 and writes a 'valid'/'pending' row, so a
    // swallowed query error collapsing to [] is indistinguishable from "no prior
    // materialization" and makes one faulting node materialize a duplicate BTC request
    // every other node rejected - the M-17 shape doQueryStrict was added for. Block
    // processing already holds a transaction, under which doQuery re-throws anyway, so
    // this is not a behavior flip on the live path; it is the guarantee stated
    // unconditionally, for the replay/genesis/synthetic entry points that reach the same
    // handler outside one. A throw rolls the block back and retries it, which is the
    // correct answer to a DB fault and is NOT the DB-constraint throw the schema comment
    // rules out: that one fires on legitimate DATA and would halt every node in turn.
    async getRelayRequestByOrigin(originChain, originActionIndex){
        let query = `SELECT action_index, request_id, request_status
                     FROM attests
                     WHERE origin_chain = ? AND origin_action_index = ?
                       AND version = 0 AND request_status <> 'rejected'
                     ORDER BY action_index ASC
                     LIMIT 1`;
        let rows = await this.doQueryStrict(query, [String(originChain || ''), Number(originActionIndex)]);
        return rows.length > 0 ? rows[0] : null;
    },

    // Cross-chain relay: has THIS request_id already been ADMITTED on this chain?
    //
    // Narrow by design, and deliberately not a change to getAttestationRequestById
    // above. That shared lookup answers "show me the request row for this id" and
    // four consensus paths depend on it seeing every stored row, rejected verdicts
    // included (v1 response resolution, v2 expiry, v4 relay response, slash round
    // lookup). Only the v3 admission guard needs the narrower question, so only the
    // v3 admission guard gets this query.
    //
    // 'rejected' rows are excluded for the same reason getRelayRequestByOrigin
    // excludes them, and the omission was exploitable in exactly the shape that
    // sibling was written to prevent. request_id arrives on the wire and is derivable
    // in public from the origin chain's v0, so anyone can watch an origin chain, take
    // the id of a request the federation is about to relay, and broadcast a
    // deliberately malformed v3 naming it. The malformed one is rejected but still
    // stored, and a guard that counts stored rows then reads that audit row as "this
    // id is taken" and refuses the federation's real relay forever. One transaction
    // fee, one permanently unservable request. A rejected row escrowed nothing, was
    // never pending and was never served, so it consumed no materialization.
    //
    // ORDER BY action_index keeps the FIRST admission canonical on every node, and
    // doQueryStrict for the reason spelled out on getRelayRequestByOrigin: null here
    // is what ADMITS the v3, so a swallowed query error collapsing to [] would make
    // one faulting node materialize a request every other node refused.
    async getRelayRequestById(requestId){
        let query = `SELECT action_index, request_id, request_status
                     FROM attests
                     WHERE request_id = ? AND version = 0
                       AND request_status <> 'rejected'
                     ORDER BY action_index ASC
                     LIMIT 1`;
        let rows = await this.doQueryStrict(query, [String(requestId || '').toLowerCase()]);
        return rows.length > 0 ? rows[0] : null;
    },

    // Update the request_status field on an ATTEST v0 (request) row
    // resolvedBlock anchors a TERMINAL flip ('fulfilled'/'errored'/'expired') to the
    // block that caused it, so the rollback pass can reset the surviving request row
    // when that block reorgs (covers the v1-response AND v2-expiry paths - the old
    // v1-only self-join reset left a reorged expiry stuck terminal, and replay then
    // skipped re-synthesizing the v2 row: reorged-node vs fresh-sync divergence).
    async updateAttestationRequestStatus(requestId, newStatus, resolvedBlock){
        let query = `UPDATE attests
                     SET request_status = ?, resolved_block = ?
                     WHERE request_id = ? AND version = 0`;
        await this.doQuery(query, [newStatus, (resolvedBlock != null ? resolvedBlock : null),
                                   String(requestId || '').toLowerCase()]);
    },

};
