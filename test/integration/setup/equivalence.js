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
 * Cross-node equivalence oracle.
 *
 * Compares two indexer databases produced by INDEPENDENT indexer instances
 * over the same decoder data. Two comparison modes:
 *
 *   'strict': every table must be row-for-row, byte-for-byte identical,
 *               surrogate ids included. This is the contract for two nodes
 *               with IDENTICAL processing histories (no reorg on either):
 *               id assignment is first-touch order, which identical inputs
 *               make deterministic.
 *
 *   'content': for a reorg SURVIVOR vs a FRESH re-parse of the surviving
 *               chain. Three classes of local artifact legitimately differ:
 *                 1. AUTO_INCREMENT surrogate `id` columns: rollback deletes
 *                    data rows but the counter keeps its high-water mark, so
 *                    re-inserted rows get higher ids on the survivor.
 *                 2. index_* dedup tables: rollback.js never deletes index
 *                    rows, so the survivor retains residue created by
 *                    orphaned blocks; the fresh side must be a SUBSET.
 *                 3. Columns pointing INTO index_transactions (blocks'
 *                    *_hash_id incl. state_hash_id, tx_hash_id); the
 *                    survivor's id-space contains orphan residue (orphaned tx
 *                    hashes + orphaned block-hash strings), shifting pointer
 *                    values. The referenced STRINGS are verified instead: the
 *                    hash chain (ledger/actions/contracts + the replication-
 *                    integrity state hash) is compared resolved
 *                    (readHashChain), and tx hashes come verbatim from the
 *                    shared decoder corpus.
 *
 * In BOTH modes the consensus commitment is the resolved hash chain.
 * assertHashChainsEqual. Because getBlockHashes folds raw address_id /
 * tick_id / action_id / status_id values into the hashes, hash equality
 * transitively pins identical dedup-id ASSIGNMENT for all consensus-
 * relevant entities, which is what makes the raw-id comparisons in
 * 'content' mode sound for the non-excluded columns.
 */

'use strict';

const assert = require('assert');

// Wall-clock columns the indexer writes with NOW()/CURRENT_TIMESTAMP:
// local artifacts, never consensus data.
const GLOBAL_COLUMN_EXCLUSIONS = ['created_at', 'created', 'updated', 'logged_at'];
const TABLE_COLUMN_EXCLUSIONS = { events: ['time'] };

// The indexer's append-only dedup tables (rollback.js touches none of them).
const INDEX_TABLES = new Set([
    'index_actions', 'index_addresses', 'index_coins', 'index_fiats',
    'index_memos', 'index_mime_types', 'index_pubkeys', 'index_statuses',
    'index_tickers', 'index_transactions',
]);

// 'content'-mode exclusions: surrogate ids + pointers into index_transactions
// (see header). Everything else, including raw address_id/tick_id/status_id,
// values, is still compared byte-wise.
const CONTENT_MODE_TABLE_EXCLUSIONS = {
    // state_hash_id joined the three consensus-hash pointers when the per-block
    // replication-integrity state hash shipped (blocks.state_hash_id, interned in
    // index_transactions exactly like its siblings); its resolved STRING is
    // compared via readHashChain/assertHashChainsEqual instead.
    blocks: ['ledger_hash_id', 'actions_hash_id', 'contract_hash_id', 'state_hash_id'],
};
const CONTENT_MODE_GLOBAL_EXCLUSIONS = ['id', 'tx_hash_id'];

// Tables skipped ENTIRELY in 'content' mode: node-local operational state whose
// rows record processing HISTORY, not chain content. push_generations is the
// monotonic source-chain reorg fence (item 5308): bumped once per rollback and
// deliberately never rolled back (src/rollback.js), so a reorg survivor carries
// a generation a fresh re-parse of the same chain cannot have, BY DESIGN. The
// artifacts it fences (hub push rows) live in the hub DB, outside this oracle.
// 'strict' mode still compares it byte-wise: identical processing histories
// must produce identical generations.
const CONTENT_MODE_TABLE_SKIP = new Set(['push_generations']);

function excludedColumns(table, mode) {
    let cols = GLOBAL_COLUMN_EXCLUSIONS
        .concat(TABLE_COLUMN_EXCLUSIONS[table] || []);
    if (mode === 'content') {
        cols = cols.concat(CONTENT_MODE_GLOBAL_EXCLUSIONS)
            .concat(CONTENT_MODE_TABLE_EXCLUSIONS[table] || []);
    }
    return cols;
}

// Canonicalize one row: stable key order, Buffer -> hex, BigInt -> string,
// Date -> ISO string (DECIMALs already arrive as strings).
function canonicalRow(row, excluded) {
    const out = {};
    for (const key of Object.keys(row).sort()) {
        if (excluded.includes(key)) continue;
        let v = row[key];
        if (Buffer.isBuffer(v)) v = '0x' + v.toString('hex');
        else if (typeof v === 'bigint') v = v.toString();
        else if (v instanceof Date) v = v.toISOString();
        out[key] = v;
    }
    return JSON.stringify(out);
}

async function tableCanon(queryFn, table, excluded) {
    const rows = await queryFn('SELECT * FROM `' + table + '`');
    return rows.map(r => canonicalRow(r, excluded)).sort();
}

async function listTables(queryFn) {
    const rows = await queryFn('SHOW TABLES');
    return rows.map(r => String(Object.values(r)[0])).sort();
}

/** Read a node's chained consensus-hash triple (plus the replication-integrity
 *  state hash) for every block, RESOLVED to the hash strings (id-independent),
 *  ordered by height. */
async function readHashChain(queryFn) {
    const rows = await queryFn(
        `SELECT b.block_index,
                t1.hash AS ledger,
                t2.hash AS actions,
                t3.hash AS contracts,
                t4.hash AS state
         FROM blocks b
         LEFT JOIN index_transactions t1 ON t1.id = b.ledger_hash_id
         LEFT JOIN index_transactions t2 ON t2.id = b.actions_hash_id
         LEFT JOIN index_transactions t3 ON t3.id = b.contract_hash_id
         LEFT JOIN index_transactions t4 ON t4.id = b.state_hash_id
         ORDER BY b.block_index ASC`);
    return rows.map(r => ({
        block_index: Number(r.block_index),
        ledger: r.ledger, actions: r.actions, contracts: r.contracts,
        state: r.state,
    }));
}

/** Assert two resolved hash chains are identical, reporting the FIRST
 *  divergent block + field (that is where the consensus fork begins).
 *
 *  opts.skipStateHash compares only the hub-signed consensus triple
 *  (ledger/actions/contracts) and leaves the replication-integrity state hash
 *  alone. ONLY correct for two chains that are not required to assign the same
 *  index ids in the first place, i.e. runs of DIFFERENT coins: since P4
 *  (05d6056) the state hash folds the index map in, and the index map is
 *  coin-bound by construction (DONATE1 / GAS / FEE_DESTINATION are per-coin
 *  constants), so two coins processing the same corpus legitimately hash
 *  different addresses. For two nodes on the SAME chain the state hash is the
 *  follower-halt guard and MUST be compared, which is why this defaults off. */
function assertHashChainsEqual(chainA, chainB, labelA = 'node A', labelB = 'node B', opts = {}) {
    const skipStateHash = opts.skipStateHash === true;
    const len = Math.min(chainA.length, chainB.length);
    for (let i = 0; i < len; i++) {
        const a = chainA[i], b = chainB[i];
        assert.strictEqual(a.block_index, b.block_index,
            `${labelA} and ${labelB} disagree on block sequence at position ${i}: ` +
            `${a.block_index} vs ${b.block_index}`);
        for (const field of ['ledger', 'actions', 'contracts']) {
            assert.strictEqual(a[field], b[field],
                `CONSENSUS FORK: ${field} hash diverges at block ${a.block_index}: ` +
                `${labelA}=${a[field]} ${labelB}=${b[field]} (first divergent block; ` +
                `all earlier blocks agree)`);
        }
        // Replication-integrity state hash: not part of the hub-signed consensus
        // triple, but a follower recomputes it and HALTS on mismatch, so survivor
        // and resync must agree on the resolved string all the same.
        if (skipStateHash) continue;
        assert.strictEqual(a.state, b.state,
            `REPLICATION-INTEGRITY DIVERGENCE: state hash diverges at block ` +
            `${a.block_index}: ${labelA}=${a.state} ${labelB}=${b.state} ` +
            `(first divergent block; all earlier blocks agree)`);
    }
    assert.strictEqual(chainA.length, chainB.length,
        `hash-chain length differs: ${labelA}=${chainA.length} ${labelB}=${chainB.length}`);
}

/**
 * Assert two indexer DBs are equivalent (see header for modes).
 *
 * @param {function} queryA - query fn for node A (in 'content' mode this MUST
 *   be the reorg SURVIVOR (the side allowed to hold index_* residue)
 * @param {function} queryB - query fn for node B (the fresh re-parse)
 * @param {object} [opts] {mode: 'strict'|'content', labelA, labelB, maxDiffRows}
 */
async function assertIndexerDbsEquivalent(queryA, queryB, opts = {}) {
    const mode = opts.mode || 'strict';
    const labelA = opts.labelA || 'node A';
    const labelB = opts.labelB || 'node B';
    const maxDiffRows = opts.maxDiffRows || 3;

    const tablesA = await listTables(queryA);
    const tablesB = await listTables(queryB);
    assert.deepStrictEqual(tablesB, tablesA,
        `${labelA} and ${labelB} have different table sets`);

    const diffs = [];
    for (const table of tablesA) {
        if (mode === 'content' && CONTENT_MODE_TABLE_SKIP.has(table)) continue;
        const excluded = excludedColumns(table, mode);
        const canonA = await tableCanon(queryA, table, excluded);
        const canonB = await tableCanon(queryB, table, excluded);
        const setA = new Set(canonA);
        const onlyInB = canonB.filter(r => !setA.has(r));
        if (mode === 'content' && INDEX_TABLES.has(table)) {
            // Fresh re-parse must be a subset of the survivor (residue may
            // exist only on the survivor side); a row the fresh side has
            // that the survivor lacks is still a hard failure.
            if (onlyInB.length === 0) continue;
        } else if (canonA.length === canonB.length &&
                   canonA.every((r, i) => r === canonB[i])) {
            continue;
        }
        const setB = new Set(canonB);
        diffs.push({
            table,
            [labelA + ' rows']: canonA.length,
            [labelB + ' rows']: canonB.length,
            ['only in ' + labelA]: canonA.filter(r => !setB.has(r)).slice(0, maxDiffRows),
            ['only in ' + labelB]: onlyInB.slice(0, maxDiffRows),
        });
    }
    if (diffs.length > 0) {
        assert.fail(`${labelA} and ${labelB} are NOT ${mode}-equivalent in ` +
            diffs.map(d => d.table).join(', ') + ':\n' + JSON.stringify(diffs, null, 2));
    }
}

/**
 * Capture a whole indexer DB as canonical table snapshots (for comparisons
 * where both sides cannot exist at once, e.g. the multi-chain sweep, which
 * rebuilds the SAME test DB once per coin). Returns {table: canonRows[]}.
 */
async function captureDbState(queryFn, opts = {}) {
    const mode = opts.mode || 'strict';
    const state = {};
    for (const table of await listTables(queryFn)) {
        state[table] = await tableCanon(queryFn, table, excludedColumns(table, mode));
    }
    return state;
}

/**
 * Assert two captured states are identical. `ignoreTables` lists tables
 * whose content differs BY CONSTRUCTION of the comparison (each entry must
 * carry its justification at the call site).
 */
function assertCapturedStatesEqual(stateA, stateB, opts = {}) {
    const labelA = opts.labelA || 'A';
    const labelB = opts.labelB || 'B';
    const ignore = new Set(opts.ignoreTables || []);
    const maxDiffRows = opts.maxDiffRows || 3;

    const tablesA = Object.keys(stateA).sort();
    const tablesB = Object.keys(stateB).sort();
    assert.deepStrictEqual(tablesB, tablesA,
        `${labelA} and ${labelB} have different table sets`);

    const diffs = [];
    for (const table of tablesA) {
        if (ignore.has(table)) continue;
        const canonA = stateA[table];
        const canonB = stateB[table];
        if (canonA.length === canonB.length &&
            canonA.every((r, i) => r === canonB[i])) continue;
        const setA = new Set(canonA);
        const setB = new Set(canonB);
        diffs.push({
            table,
            [labelA + ' rows']: canonA.length,
            [labelB + ' rows']: canonB.length,
            ['only in ' + labelA]: canonA.filter(r => !setB.has(r)).slice(0, maxDiffRows),
            ['only in ' + labelB]: canonB.filter(r => !setA.has(r)).slice(0, maxDiffRows),
        });
    }
    if (diffs.length > 0) {
        assert.fail(`${labelA} and ${labelB} states are NOT identical in ` +
            diffs.map(d => d.table).join(', ') + ':\n' + JSON.stringify(diffs, null, 2));
    }
}

module.exports = {
    readHashChain,
    assertHashChainsEqual,
    assertIndexerDbsEquivalent,
    captureDbState,
    assertCapturedStatesEqual,
};
