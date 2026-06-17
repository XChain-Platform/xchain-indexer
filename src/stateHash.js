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
 * Per-block state-hash preimage (in-place mutations + backdated credits)
 *
 * The three consensus hashes (ledger/actions/contract) cover only rows scoped
 * by actions.block_index = B (new, immutable rows). They deliberately CANNOT see
 * the in-place mutations the replication "updated_rows" channel carries on
 * SURVIVING (earlier-block) rows, nor the backdated cooldown-refund credits that
 * reuse an earlier-block action_index. A follower that silently fails to apply
 * one of those mutations therefore diverges with NO hash mismatch to flag it.
 *
 * This builds a canonical, id-RESOLVED preimage over exactly those mutated rows
 * for block B, so a fourth `state_hash` can be computed and compared. It captures
 * the same row classes the source replicates:
 *   - deactivation_block stamps (stakes/delegations/contract_stakes/contract_delegations)
 *   - SLASH amount cuts (stakes/unstakes/contract_stakes/contract_unstakes via debit logs)
 *   - v0 request_status flips (attests/xcalls)
 *   - cooldown-maturity status flips (unstakes/contract_unstakes)
 *   - backdated cooldown refund credits (capability GAS + contract own-tick)
 *   - invalid_archive stamp on anchor_actions v1 parent rows (CRC-failed chunked batches)
 *
 * CONSENSUS-STYLE DETERMINISM (mirrors db.js getBlockHashes):
 *   - surrogate AUTO_INCREMENT ids (address_id/tick_id/status_id) are NEVER hashed;
 *     they are resolved to canonical strings via LEFT JOIN (they diverge across
 *     nodes after a reorg, which is the reason BLOCK_HASH_VERSION exists).
 *     action_index is the deterministic on-chain index, safe to hash raw.
 *   - every row set is ORDER BY'd with BINARY-collation-pinned tie-breaks so the
 *     order is independent of each node's default collation.
 *   - the preimage object's key order is fixed in code; the caller hashes it with
 *     the shared util.getDataHash (JSON.stringify + bigint replacer + sha256).
 *
 * BYTE-ALIGNED TWIN: this file is copied verbatim into xchain-sync/src/stateHash.js
 * (the source computes+stores from here; the follower recomputes from the identical
 * copy at apply-time and HALTS on mismatch). Keep them identical; the
 * state-hash-vectors golden + the xchain-e2e recompute-conformance scenario guard
 * the pair. The selection predicates also mirror xchain-sync/src/updatedRows.js +
 * cooldownCredits.js (forward) and ClientRollback.js + rollback.js (reverse).
 *
 ********************************************************************/

// Bump ONLY on a deliberate preimage change; folded into the hash so two schemes
// can never compare equal. Independent of BLOCK_HASH_VERSION (the three-hash
// baseline is untouched by this additive, non-consensus integrity hash).
const STATE_HASH_VERSION = 2;

const DEACTIVATION_TABLES = ['stakes', 'delegations', 'contract_stakes', 'contract_delegations'];
const SLASH_SPECS = [
    { table: 'stakes',            debits: 'capability_slash_debits', target: 'stakes'            },
    { table: 'unstakes',          debits: 'capability_slash_debits', target: 'unstakes'          },
    { table: 'contract_stakes',   debits: 'contract_slash_debits',   target: 'contract_stakes'   },
    { table: 'contract_unstakes', debits: 'contract_slash_debits',   target: 'contract_unstakes' }
];
const REQUEST_STATUS_TABLES = ['attests', 'xcalls'];
const COOLDOWN_TABLES = ['unstakes', 'contract_unstakes'];

// Build the canonical state-hash preimage object for block B. db must expose
// doQuery(sql, args) and getStatusId(name) (both xchain-indexer and xchain-sync
// Database classes do). opts: { activationDelay, gasTick }. The caller hashes the
// returned object with util.getDataHash. A try/catch around each class lets older
// schemas (missing a table/column) degrade to an empty class rather than throw.
async function buildStateHashData(db, blockIndex, opts){
    let B       = Number(blockIndex);
    let delay   = (opts && opts.activationDelay != null) ? Number(opts.activationDelay) : null;
    let gasTick = (opts && opts.gasTick != null) ? opts.gasTick : null;
    let completedStatusId = await db.getStatusId('completed');

    // 1. deactivation_block stamps. A stamp written at block B carries value
    //    B + delay, so a stamp landed at B iff deactivation_block = B + delay.
    //    Skipped when delay is unknown (mirrors collectUpdatedRows).
    let deactivations = {};
    for(let t of DEACTIVATION_TABLES){
        deactivations[t] = [];
        if(delay == null) continue;
        try {
            deactivations[t] = await db.doQuery(
                "SELECT action_index, deactivation_block FROM `" + t + "` " +
                "WHERE deactivation_block BETWEEN ? AND ? ORDER BY action_index ASC",
                [B + delay, B + delay]);
        } catch(e){ /* table/column may not exist on older schemas */ }
    }

    // 2. SLASH amount cuts: the slashed row reached via its debit-log entry for
    //    this block. DISTINCT collapses multiple debits for one stake (amount is
    //    functionally determined by action_index).
    let slashes = {};
    for(let s of SLASH_SPECS){
        slashes[s.table] = [];
        try {
            slashes[s.table] = await db.doQuery(
                "SELECT DISTINCT t.action_index, t.amount FROM `" + s.table + "` t " +
                "JOIN `" + s.debits + "` d ON d.stake_action_index = t.action_index " +
                "WHERE d.target_table = ? AND d.block_index BETWEEN ? AND ? ORDER BY t.action_index ASC",
                [s.target, B, B]);
        } catch(e){ /* table may not exist on older schemas */ }
    }

    // 3. v0 request_status flips (the resolved_block stamp), attests + xcalls.
    let request_status = {};
    for(let t of REQUEST_STATUS_TABLES){
        request_status[t] = [];
        try {
            request_status[t] = await db.doQuery(
                "SELECT action_index, request_status, resolved_block FROM `" + t + "` " +
                "WHERE version = 0 AND resolved_block BETWEEN ? AND ? ORDER BY action_index ASC",
                [B, B]);
        } catch(e){ /* table/column may not exist on older schemas */ }
    }

    // 4. cooldown-maturity status flips, keyed by the maturity block. status_id
    //    resolved to its canonical status string.
    let cooldown = {};
    for(let t of COOLDOWN_TABLES){
        cooldown[t] = [];
        try {
            cooldown[t] = await db.doQuery(
                "SELECT t.action_index, s.status AS status FROM `" + t + "` t " +
                "LEFT JOIN index_statuses s ON (s.id = t.status_id) " +
                "WHERE t.cooldown_end_block BETWEEN ? AND ? ORDER BY t.action_index ASC",
                [B, B]);
        } catch(e){ /* table/column may not exist on older schemas */ }
    }

    // 5. backdated cooldown refund credits: capability (GAS) + contract (own tick),
    //    keyed by the matured unstake's cooldown_end_block (the forward mirror of
    //    cooldownCredits.js). address_id/tick_id resolved; ordered with the same
    //    BINARY-collation-pinned keys as the ledger credit hash. A null gasTick makes
    //    the GAS join match nothing (capability branch empties); contract still runs.
    let credits = [];
    if(completedStatusId != null && completedStatusId !== undefined){
        try {
            credits = await db.doQuery(
                "SELECT action_index, address, tick, amount FROM ( " +
                    "SELECT c.action_index, a.address AS address, ti.tick AS tick, c.amount " +
                    "FROM credits c " +
                    "JOIN unstakes u ON (u.action_index = c.action_index AND u.source_id = c.address_id) " +
                    "JOIN index_tickers g ON (g.id = c.tick_id AND g.tick = ?) " +
                    "LEFT JOIN index_addresses a ON (a.id = c.address_id) " +
                    "LEFT JOIN index_tickers ti ON (ti.id = c.tick_id) " +
                    "WHERE u.status_id = ? AND u.cooldown_end_block BETWEEN ? AND ? " +
                    "UNION ALL " +
                    "SELECT c.action_index, a.address AS address, ti.tick AS tick, c.amount " +
                    "FROM credits c " +
                    "JOIN contract_unstakes cu ON (cu.action_index = c.action_index AND cu.source_id = c.address_id AND cu.tick_id = c.tick_id) " +
                    "LEFT JOIN index_addresses a ON (a.id = c.address_id) " +
                    "LEFT JOIN index_tickers ti ON (ti.id = c.tick_id) " +
                    "WHERE cu.status_id = ? AND cu.cooldown_end_block BETWEEN ? AND ? " +
                ") x ORDER BY action_index ASC, address COLLATE utf8_bin ASC, tick COLLATE utf8mb4_bin ASC, amount ASC",
                [gasTick, completedStatusId, B, B, completedStatusId, B, B]);
        } catch(e){ /* table may not exist on older schemas */ }
    }

    // 6. invalid_archive stamp on anchor_actions v1 parent rows. When the final v2
    //    chunk of a chunked archive batch lands at block B and the reassembled blob
    //    fails its CRC check, anchor.js stamps the v1 parent 'invalid_archive' in
    //    place. The parent's action_index is in an earlier block, so it is invisible
    //    to the action-scoped consensus hashes and to the per-block stream. Resolved
    //    via the status name (not status_id) to stay id-independent across nodes.
    let anchor_invalid = [];
    try {
        anchor_invalid = await db.doQuery(
            "SELECT p.action_index, s.status AS status FROM anchor_actions p " +
            "JOIN anchor_actions c ON c.version = 2 AND c.match_batch_seq = p.match_batch_seq " +
            "JOIN index_statuses s ON s.id = p.status_id AND s.status = 'invalid_archive' " +
            "JOIN index_statuses cs ON cs.id = c.status_id AND cs.status = 'valid' " +
            "WHERE p.version = 1 AND c.block_index BETWEEN ? AND ? " +
            "ORDER BY p.action_index ASC",
            [B, B]);
    } catch(e){ /* table/columns may not exist on older schemas */ }

    // Fixed key order: the hash preimage. NOT chained on a previous state_hash
    // (the adjacent three hashes already carry chain-continuity; a chain would only
    // make NULL-backfill of historical blocks poison every successor).
    return {
        deactivations:      deactivations,
        slashes:            slashes,
        request_status:     request_status,
        cooldown:           cooldown,
        credits:            credits,
        anchor_invalid:     anchor_invalid,
        block_index:        B,
        state_hash_version: STATE_HASH_VERSION
    };
}

module.exports = { buildStateHashData, STATE_HASH_VERSION,
                   DEACTIVATION_TABLES, SLASH_SPECS, REQUEST_STATUS_TABLES, COOLDOWN_TABLES };
