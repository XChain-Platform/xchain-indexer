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
 * XChain Indexer - Database mixin: cross_chain
 * 
 * The queries over the cross_chain table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const path    = require('path');
// Per-block cap on the ATTEST deadline-expiry sweep. Vendored
// byte-identical from xchain-documentation/protocol/constants.js, same convention
// as the XCALL_MAX_CALLS_PER_BLOCK sibling it mirrors.
const { ATTEST_MAX_EXPIRIES_PER_BLOCK,
        CROSS_SETTLE_MAX_PER_BLOCK,
        ORACLE_VM_ROUND_WINDOW,
        ORACLE_VM_MAX_ROWS } = require('../../protocol/constants.js');
const diag = require('../../actions/anchor/diagnostic_events.js');

module.exports = {

    async getEffectiveUnsettledMatches(coin, block_time, limit, block_index){
        // network filter: a match only settles on the indexer of the network it was matched
        // + signed on (also bound into the signed canonical - see cross_settle.canonical).
        // ORDER BY (snapshot_block, match_id) - quorum-agreed row content, so the
        // settlement order is identical no matter which hub DB this indexer mirrors
        // (the hub-assigned id is per-hub AUTO_INCREMENT and MUST NOT order consensus
        // state).
        // Bound by the clock below the admission activation and by this chain's signed
        // admission height above it (mirrorBindClause); `block_index` is that key.
        let network = this.config['NETWORK'];
        let bind    = this.mirrorBindClause(block_time, block_index);
        // doQueryStrict (not doQuery): a CONSENSUS input read on the hub mirror, which never
        // holds a transaction, so doQuery turns a transient DB fault into an empty set on this
        // node alone - peers settle the matches, this node does not, and the block hashes
        // diverge. Throwing rolls the block back so it retries.
        let matches = await this.mirrorDb().doQueryStrict(
            `SELECT * FROM cross_chain_matches
             WHERE status = 'finalized' AND network = ? AND ${bind.sql} AND (a_chain = ? OR b_chain = ?)
             ORDER BY snapshot_block ASC, match_id ASC`,
            [network].concat(bind.args, [coin, coin]));
        if(matches.length === 0) return [];
        let ids = matches.map(m => m.match_id);
        let placeholders = ids.map(() => '?').join(',');
        let settled = await this.doQuery(
            `SELECT match_id FROM cross_chain_settlements WHERE match_id IN (${placeholders})`, ids);
        // match_id is stored and compared verbatim on both sides; do not add normalization to
        // only one side (unlike call_id, the match_id is never lowercased on write, so a one-
        // sided .toLowerCase() here would DESYNC the compare rather than fix it).
        let settledSet = new Set(settled.map(r => r.match_id));
        // The no-limit default reads the protocol constant rather than repeating its value,
        // so the cap has ONE definition. A literal here would be a second copy of a
        // consensus-visible number that no test compares against the first, and the caller
        // that omitted the limit would then settle a different prefix than the one that
        // passed it. The `|| 25` tail keeps the "no uncapped path" property even if the
        // constant is ever exported as 0 or undefined, since slice(0, undefined) returns
        // the whole backlog.
        return matches.filter(m => !settledSet.has(m.match_id))
                      .slice(0, Number(limit) || CROSS_SETTLE_MAX_PER_BLOCK || 25);
    },

    // Record that this chain settled its leg of a cross-chain match (idempotent on
    // match_id). The action_index is rollback-able, so a reorg drops this row and the
    // match re-applies. Both leg references are captured here because the mirror row
    // may later be deleted by a reorg retraction - the VM's crossChain.isSettled
    // snapshot reads this local table, never the mirror (getCrossChainDataForVM).
    async recordCrossChainSettlement(action_index, match, local_action_index, block_index){
        await this.doQuery(
            `INSERT IGNORE INTO cross_chain_settlements
             (action_index, match_id, local_action_index, block_index, a_chain, a_action_index, b_chain, b_action_index)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [action_index, match.match_id, local_action_index, block_index,
             match.a_chain, Number(match.a_action_index), match.b_chain, Number(match.b_action_index)]);
    },

    // Effective, unexecuted dispatch rows targeting THIS chain - drives the XEXEC
    // injection pass. cross_chain_calls is hub-mirrored (read via mirrorDb) while
    // cross_chain_call_executions is local, so the exclusion is filtered in JS.
    // ORDER BY (snapshot_block, call_id) - both quorum-agreed row content, so the
    // injection order is identical no matter which hub DB this indexer mirrors
    // (the hub-assigned id is per-hub AUTO_INCREMENT and MUST NOT order consensus
    // state). Cap per block (overflow carries forward; never dropped).
    async getEffectiveUndispatchedCalls(coin, network, block_time, limit, block_index){
        // Clock-bound below the admission activation, height-bound above it (mirrorBindClause).
        let bind  = this.mirrorBindClause(block_time, block_index);
        // doQueryStrict (not doQuery): a CONSENSUS input read on the hub mirror, which never
        // holds a transaction, so doQuery turns a transient DB fault into an empty dispatch set
        // on this node alone - peers inject the XEXEC actions, this node does not, and the
        // block hashes diverge. Throwing rolls the block back so it retries.
        let calls = await this.mirrorDb().doQueryStrict(
            `SELECT * FROM cross_chain_calls
             WHERE phase = 'dispatch' AND status = 'finalized' AND network = ?
               AND target_chain = ? AND ${bind.sql}
             ORDER BY snapshot_block ASC, call_id ASC`,
            [network, coin].concat(bind.args));
        if(calls.length === 0) return [];
        let ids = calls.map(c => c.call_id);
        let placeholders = ids.map(() => '?').join(',');
        let executed = await this.doQuery(
            `SELECT call_id FROM cross_chain_call_executions WHERE call_id IN (${placeholders})`, ids);
        // Local writes lowercase every call_id; a hub-mirrored call_id may arrive uppercase. The
        // case-insensitive collation lets the SQL prefilter match, but the executions row comes
        // back lowercase, so an unnormalized Set.has() would miss an uppercase mirror call_id and
        // re-dispatch a call already executed. Compare both sides lowercased. No-op for all-
        // lowercase data (no consensus change on the current chain).
        let executedSet = new Set(executed.map(r => String(r.call_id).toLowerCase()));
        return calls.filter(c => !executedSet.has(String(c.call_id).toLowerCase())).slice(0, Number(limit) || 25);
    },

    // Effective, unprocessed result rows for requests THIS chain originated -
    // drives the callback delivery pass. Same mirror/local split and ordering.
    //
    // cross_chain_calls is hub-mirrored (read via mirrorDb) while the
    // cross_chain_call_callbacks idempotency table is local. When the mirror IS the
    // local DB (the hub / single-DB deployments, including the test + regtest env) we
    // push the already-processed exclusion, the deterministic ordering, and the cap
    // into one SQL statement via NOT EXISTS + ORDER BY + LIMIT, so the DB never
    // materializes the already-delivered rows into JS. This is exactly equivalent to
    // the JS path below: both tables are utf8_general_ci and every call_id is canonical
    // lowercase on both sides, so NOT EXISTS matches iff the JS Set would, the ORDER BY
    // is byte-identical, and LIMIT after the exclusion == the current filter-then-slice.
    // When the mirror is a SEPARATE hub connection the callbacks table is not reachable
    // from it, so we keep the original two-query JS filter unchanged; that remote-mirror
    // path still materializes the full effective result set each tick (finalized result
    // rows accumulate on the mirror and are re-scanned every block), a residual cost that
    // a cross-database exclusion cannot address without a cross-DB join.
    async getEffectiveUnprocessedCallResults(coin, network, block_time, limit, block_index){
        let cap = Number(limit) || 25;
        let mirror = this.mirrorDb();
        // doQueryStrict (not doQuery) on both branches: these are CONSENSUS input reads. The
        // mirror branch never holds a transaction, so doQuery turns a transient DB fault into
        // an empty result set on this node alone - peers record the callbacks, this node does
        // not, and the block hashes diverge. The single-DB branch is strict for symmetry, so a
        // later caller outside the block transaction cannot reintroduce the swallow.
        if(mirror === this){
            // The single-DB form aliases the table, so the clause is spelled on the alias.
            let bind = this.mirrorBindClause(block_time, block_index, 'c');
            return await this.doQueryStrict(
                `SELECT c.* FROM cross_chain_calls c
                 WHERE c.phase = 'result' AND c.status = 'finalized' AND c.network = ?
                   AND c.source_chain = ? AND ${bind.sql}
                   AND NOT EXISTS (
                       SELECT 1 FROM cross_chain_call_callbacks k WHERE k.call_id = c.call_id)
                 ORDER BY c.snapshot_block ASC, c.call_id ASC
                 LIMIT ?`,
                [network, coin].concat(bind.args, [cap]));
        }
        let bind    = this.mirrorBindClause(block_time, block_index);
        let results = await mirror.doQueryStrict(
            `SELECT * FROM cross_chain_calls
             WHERE phase = 'result' AND status = 'finalized' AND network = ?
               AND source_chain = ? AND ${bind.sql}
             ORDER BY snapshot_block ASC, call_id ASC`,
            [network, coin].concat(bind.args));
        if(results.length === 0) return [];
        let ids = results.map(r => r.call_id);
        let placeholders = ids.map(() => '?').join(',');
        let processed = await this.doQuery(
            `SELECT call_id FROM cross_chain_call_callbacks WHERE call_id IN (${placeholders})`, ids);
        // Lowercase both sides: local callbacks are stored lowercase, a mirror call_id may be
        // uppercase (see getEffectiveUndispatchedCalls). No-op for all-lowercase data.
        let processedSet = new Set(processed.map(r => String(r.call_id).toLowerCase()));
        return results.filter(r => !processedSet.has(String(r.call_id).toLowerCase())).slice(0, cap);
    },

    // Record an injected target-chain execution (idempotent on call_id; the
    // action_index is rollback-able so a reorg drops this row and the call re-applies).
    async recordCrossChainCallExecution(action_index, call_id, execute_action_index, result_status, return_payload_b64, gas_used, block_index){
        await this.doQuery(
            `INSERT IGNORE INTO cross_chain_call_executions
             (action_index, call_id, execute_action_index, result_status, return_payload_b64, gas_used, block_index)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [action_index, String(call_id).toLowerCase(), execute_action_index,
             result_status, return_payload_b64, gas_used, block_index]);
        // The call made it in: any refusal diagnostics recorded while it was
        // starved (cross_chain_call_rejections) are now stale evidence.
        await this.clearCrossChainCallRejection(call_id);
    },

    // Record a REFUSED injection attempt for a dispatch row (XDISP-1 visibility).
    // Node-local diagnostics only: upserted per attempt, never consulted by the
    // injection pass (the call keeps retrying every block), deleted when the call
    // finally executes. See src/sql/cross_chain_call_rejections.sql.
    async recordCrossChainCallRejection(call_id, reason, detail, block_index){
        await this.doQuery(
            `INSERT INTO cross_chain_call_rejections
             (call_id, reason, detail, attempts, first_block, last_block)
             VALUES (?, ?, ?, 1, ?, ?)
             ON DUPLICATE KEY UPDATE
                reason     = VALUES(reason),
                detail     = VALUES(detail),
                attempts   = attempts + 1,
                last_block = VALUES(last_block)`,
            [String(call_id).toLowerCase(), String(reason),
             detail == null ? null : String(detail).substring(0, 250),
             block_index, block_index]);
        // The row alone is not visibility: this table is node-local, never
        // replicated, and read only when somebody asks getcrosschaincallresult
        // about this exact call. The event is what a collector can key on, and it
        // rides the write so the two can never drift.
        diag.noteXcallRejected({
            call_id:     String(call_id).toLowerCase(),
            reason:      String(reason),
            detail:      detail == null ? undefined : String(detail).substring(0, 250),
            block_index: block_index
        });
    },

    // Drop the refusal diagnostics for a call (called once it executes).
    async clearCrossChainCallRejection(call_id){
        await this.doQuery(
            `DELETE FROM cross_chain_call_rejections WHERE call_id = ?`,
            [String(call_id).toLowerCase()]);
    },

    // Refusal diagnostics for a single call (getcrosschaincallresult enrichment).
    async getCrossChainCallRejectionById(call_id){
        let rows = await this.doQuery(
            `SELECT * FROM cross_chain_call_rejections WHERE call_id = ? LIMIT 1`,
            [String(call_id).toLowerCase()]);
        return rows.length > 0 ? rows[0] : null;
    },

    // Execution outcome for a call on THIS (target) chain (getcrosschaincallresult RPC).
    async getCrossChainCallExecutionById(call_id){
        let rows = await this.doQuery(
            `SELECT * FROM cross_chain_call_executions WHERE call_id = ? LIMIT 1`,
            [String(call_id).toLowerCase()]);
        return rows.length > 0 ? rows[0] : null;
    },

    // Record a processed result row (idempotent on call_id; rollback-able).
    async recordCrossChainCallCallback(action_index, call_id, result_status, block_index){
        await this.doQuery(
            `INSERT IGNORE INTO cross_chain_call_callbacks
             (action_index, call_id, result_status, block_index)
             VALUES (?, ?, ?, ?)`,
            [action_index, String(call_id).toLowerCase(), result_status, block_index]);
    },


    // The cross-chain call mirror watermark, read off the HUB's own database. Returns the
    // highest finalized effective_time plus the hub's clock, taken in ONE statement on ONE
    // connection: the barrier that consumes this compares the two, and reading the clock
    // separately would let the skew between two readings decide a consensus barrier.
    // A chain narrows the scan to calls that touch it; without one the watermark is global.
    async getHubCrossChainCallCoverage(chain){
        let coverageSql = "SELECT MAX(effective_time) AS ts, UNIX_TIMESTAMP() AS hub_now " +
                          "FROM cross_chain_calls WHERE status = 'finalized'" +
                          (chain ? " AND (target_chain = ? OR source_chain = ?)" : "");
        let coverageArgs = chain ? [chain, chain] : [];
        // doQueryStrict, never doQuery: this runs on the hub connection, which holds no
        // transaction, so doQuery would collapse a hub fault to [] and the caller would read
        // that as "nothing to wait on" and clear the very barrier it exists to hold.
        return await this.doQueryStrict(coverageSql, coverageArgs);
    },

};
