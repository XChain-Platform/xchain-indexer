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
 * XChain Indexer - Database mixin: xcalls
 * 
 * The queries over the xcalls table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const { fitColumnText } = require('../column_text.js');

const U64_MAX = '18446744073709551615';   // BIGINT UNSIGNED
const I32_MIN = '-2147483648';            // INT
const I32_MAX = '2147483647';

// gas_limit, cross_hops, deadline_block and target_contract_index are nullable integer
// columns, and an XCALL v0 writes its row valid or not, so a refused request (one broadcast
// inside a BATCH, which is not a VM emission) carrying '-1', 1e30 or a hexadecimal, binary or
// octal literal failed the insert and wedged the block. A valid row holds values
// range-checked as JavaScript reads them, which the fitted value keeps, and every reader
// selects valid rows only. A value that is not a number stores NULL. None of the four
// enters the state hash, which covers the request_status flip alone.
function storableRequestLimits(util, data){
    return {
        gas_limit:      util.fitIntegerColumn(data['GAS_LIMIT'], '0', U64_MAX),
        cross_hops:     util.fitIntegerColumn(data['CROSS_HOPS'], I32_MIN, I32_MAX),
        deadline_block: util.fitIntegerColumn(data['DEADLINE_BLOCK'], '0', U64_MAX),
        target_index:   util.fitIntegerColumn(data['TARGET_CONTRACT_INDEX'], '0', U64_MAX)
    };
}

// The four text columns a refused XCALL v0 fills from its raw wire (a request broadcast
// inside a BATCH is refused as not a VM emission, and its row is still written): call_id
// VARCHAR(80) and target_chain VARCHAR(10) are utf8mb3, method and callback_method are
// VARCHAR(64) utf8mb4. An over-long value or a supplementary-plane character in a utf8mb3
// column failed the INSERT on every retry. A valid row's values (a 64-hex id, a listed chain,
// names of at most 64 bytes) already fit and bind unchanged, and every reader of these
// columns selects valid rows, so the fitted value of a refused row is never read back.
function storableRequestText(data){
    return {
        call_id:         fitColumnText(String(data['CALL_ID']).toLowerCase(), 80, true),
        target_chain:    fitColumnText(data['TARGET_CHAIN'], 10, true),
        method:          fitColumnText(data['METHOD'], 64, false),
        callback_method: fitColumnText(data['CALLBACK_METHOD'], 64, false)
    };
}

module.exports = {

    // ── Cross-chain contract calls (XCALL) ──────────────────────────────────────

    // Persist an XCALL v0 request row (the source-chain side of a cross-chain call).
    async createCrossChainCallRequest(data){
        data = this.normalizeDataValues(data);
        let status_id = await this.createStatus(data['STATUS']);
        let limits    = storableRequestLimits(this.util, data);
        let text      = storableRequestText(data);
        await this.doQuery(
            `INSERT INTO xcalls
             (action_index, version, call_id, contract_index, target_chain, target_contract_index,
              method, params_json, gas_limit, cross_hops, callback_method, callback_params_json,
              deadline_block, request_status, block_index, status_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [data['ACTION_INDEX'], 0, text.call_id, data['CONTRACT_INDEX'],
             text.target_chain, limits.target_index, text.method, data['PARAMS_JSON'],
             limits.gas_limit, limits.cross_hops, text.callback_method, data['CALLBACK_PARAMS'],
             limits.deadline_block, data['REQUEST_STATUS'], data['BLOCK_INDEX'], status_id]);
    },

    // Latest VALID v0 request row for a call_id.
    async getCrossChainCallRequestById(call_id){
        let rows = await this.doQuery(
            `SELECT x.* FROM xcalls x
             JOIN index_statuses s ON s.id = x.status_id
             WHERE x.call_id = ? AND x.version = 0 AND s.status = 'valid'
             ORDER BY x.action_index DESC LIMIT 1`,
            [String(call_id).toLowerCase()]);
        return rows.length > 0 ? rows[0] : null;
    },

    // Flip a request to a terminal status and capture the delivered outcome
    // (the exactly-once interlock + the xchain.crossChain.getCallResult source).
    async updateCrossChainCallRequestStatus(call_id, request_status, result_status, result_payload, resolved_block){
        await this.doQuery(
            `UPDATE xcalls SET request_status = ?, result_status = ?, result_payload = ?, resolved_block = ?
             WHERE call_id = ? AND version = 0`,
            [request_status, result_status, String(result_payload == null ? '' : result_payload),
             resolved_block, String(call_id).toLowerCase()]);
    },

    async setCrossChainCallCallbackIndex(call_id, callback_action_index){
        await this.doQuery(
            `UPDATE xcalls SET callback_action_index = ? WHERE call_id = ? AND version = 0`,
            [callback_action_index, String(call_id).toLowerCase()]);
    },

    // Pending requests whose deadline has passed (drives the v2 expiry synthesis).
    // Pending requests whose deadline has passed, capped at `cap` per block (carry-forward: the
    // remainder is picked up in later blocks). The cap is load-bearing for liveness: deadline_block
    // is caller-chosen in [10,4000], so an attacker can align many requests' deadlines onto one
    // block; without a bound the expiry pass would synthesize an XCALL v2 + run a VM callback isolate
    // for every one of them inside a single block transaction, blowing BLOCK_PROCESS_TIMEOUT and
    // wedging every indexer on the chain at the identical block. Ordering is deterministic and
    // node-invariant (deadline_block, then per-chain action_index), so the capped subset and the
    // carry-forward converge byte-identically across operators (matches the dispatch/result caps).
    async getExpiredCrossChainCallRequests(block_index, cap){
        let limit = (Number.isInteger(cap) && cap > 0) ? cap : Number.MAX_SAFE_INTEGER;
        return await this.doQuery(
            `SELECT x.call_id FROM xcalls x
             JOIN index_statuses s ON s.id = x.status_id
             WHERE x.version = 0 AND s.status = 'valid'
               AND x.request_status = 'pending' AND x.deadline_block < ?
             ORDER BY x.deadline_block ASC, x.action_index ASC
             LIMIT ?`,
            [block_index, limit]);
    },

    // Pending requests for the federation relay (getpendingcrosschaincalls RPC).
    async getPendingCrossChainCallRequests(limit){
        return await this.doQuery(
            `SELECT x.call_id, x.action_index, x.block_index, x.contract_index AS source_contract_index,
                    x.target_chain, x.target_contract_index, x.method, x.params_json, x.gas_limit,
                    x.cross_hops, x.deadline_block
             FROM xcalls x
             JOIN index_statuses s ON s.id = x.status_id
             WHERE x.version = 0 AND s.status = 'valid' AND x.request_status = 'pending'
             ORDER BY x.action_index ASC LIMIT ?`,
            [limit]);
    },

};
