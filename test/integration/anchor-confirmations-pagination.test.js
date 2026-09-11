/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/integration/anchor-confirmations-pagination.test.js
 *
 * getanchorconfirmations and its anchor-by-txid pagination SQL
 * (ANCHOR_BY_TXID_SQL / ANCHOR_BY_TXID_AFTER_SQL, src/anchor-action-query.js) had no
 * executing test venue against real MariaDB. The 2026-08-24 round landed the
 * pagination itself (truncation probe + an AFTER_SQL resume on action_index) with
 * only unit coverage, which pins the query TEXT but proves nothing about whether
 * MariaDB actually executes it the way the truncation-probe reasoning assumes: that
 * `LIMIT ANCHOR_ROW_LIMIT + 1` really yields one extra probe row, that the exclusive
 * `action_index > ?` cursor really resumes without re-serving or skipping a row, and
 * that the ORDER BY really holds stable across a resume. A stubbed doQuery can never
 * exercise any of that.
 *
 * This drives both statements against a throwaway real MariaDB with more than
 * ANCHOR_ROW_LIMIT anchor_actions rows sharing one DOGE txid, walks every page the
 * way anchor_proof_client.proveMined does (follow next_after_action_index until
 * truncated is false), and asserts the walk partitions the full row set with no gap
 * and no overlap - matching this item's verify clause exactly.
 *
 * A second scenario plants a v0-style BUNDLE (several section_index rows sharing one
 * action_index) straddling the LIMIT+1 probe boundary, because that is the one case
 * buildAnchorConfirmationsResponse's own comments call out as able to silently drop
 * rows if the cut lands inside an action instead of between two actions - exactly the
 * kind of execution-semantics defect a unit test with synthetic rows cannot surface,
 * since it never has to survive a real ORDER BY + LIMIT round trip.
 *
 * Self-skips when TEST_DB_PASS is unset, matching the other DB-backed files here.
 * Run it with bin/run-db-tiers.sh (throwaway docker MariaDB), or point TEST_DB_* at
 * any throwaway MariaDB reachable over TCP.
 */

'use strict';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');

const Database = require('../../src/db');
const anchorActionQuery = require('../../src/anchor-action-query');

const {
    ANCHOR_ROW_LIMIT,
    ANCHOR_BY_TXID_SQL,
    ANCHOR_BY_TXID_AFTER_SQL,
    buildAnchorConfirmationsResponse
} = anchorActionQuery;

const DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.TEST_DB_PORT) || 3306;
const DB_USER = process.env.TEST_DB_USER || 'root';
const DB_PASS = process.env.TEST_DB_PASS;            // undefined => self-skip
const DB_NAME = process.env.TEST_ANCHOR_CONFIRMATIONS_DB || 'xchain_test_anchor_confirmations_pagination';

const SQL_DIR = path.join(__dirname, '../../src/sql');
// Strip `--` line comments with the PRODUCT's own stripper: the licence banner opens
// `--***` with no whitespace, which MySQL does not treat as a comment, so a verbatim
// send is errno 1064 on the first line. Only the tables ANCHOR_BY_TXID_SQL actually
// joins are loaded; none of the five declares a real FOREIGN KEY (the "FK to ..."
// notes in anchor_actions.sql/actions.sql are comments, not constraints), so loading
// this subset stays consistent with the canonical schema rather than approximating it.
const stripSqlLineComments = Database.prototype.stripSqlLineComments;
const SCHEMA = ['index_statuses.sql', 'index_transactions.sql', 'transactions.sql',
                'actions.sql', 'anchor_actions.sql']
    .map(f => stripSqlLineComments(fs.readFileSync(path.join(SQL_DIR, f), 'utf8')))
    .join('\n');

const CONFIG = { COIN: 'BTC', NETWORK: 'regtest' };
const LATEST_DOGE_BLOCK = 1000000;

// A DOGE txid, lowercase hex, matching TXID_RE in anchor-action-query.js.
const TXID = 'ab'.repeat(32);
const OTHER_TXID = 'cd'.repeat(32);

describe('getanchorconfirmations anchor-by-txid pagination against a real MariaDB @tier3', function () {
    this.timeout(60000);

    let admin, pool;

    before(async function () {
        if (!DB_PASS) this.skip();
        admin = await mariadb.createConnection({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, multipleStatements: true });
        await admin.query('DROP DATABASE IF EXISTS ' + DB_NAME + '; CREATE DATABASE ' + DB_NAME + ';');
        await admin.query('USE ' + DB_NAME + '; ' + SCHEMA);
        pool = mariadb.createPool({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS,
            database: DB_NAME, connectionLimit: 5, insertIdAsNumber: true });
    });

    after(async function () {
        if (pool) await pool.end();
        if (admin) await admin.end();
    });

    beforeEach(reset);

    async function conn(fn) {
        const c = await pool.getConnection();
        try { return await fn(c); } finally { c.release(); }
    }

    async function reset() {
        await conn(async c => {
            for (const t of ['anchor_actions', 'actions', 'transactions', 'index_transactions', 'index_statuses'])
                await c.query('DELETE FROM ' + t);
        });
    }

    /** Insert (or reuse) a status row and return its id. */
    async function statusId(status) {
        return conn(async c => {
            await c.query('INSERT IGNORE INTO index_statuses (status) VALUES (?)', [status]);
            const rows = await c.query('SELECT id FROM index_statuses WHERE status = ?', [status]);
            return Number(rows[0].id);
        });
    }

    /** Insert (or reuse) an index_transactions row for `hash` and return its id. */
    async function txHashId(hash) {
        return conn(async c => {
            await c.query('INSERT IGNORE INTO index_transactions (hash) VALUES (?)', [hash]);
            const rows = await c.query('SELECT id FROM index_transactions WHERE hash = ?', [hash]);
            return Number(rows[0].id);
        });
    }

    /** Insert a transactions row and return its tx_index. */
    async function insertTransaction(txIndex, blockIndex, hashId) {
        await conn(c => c.query(
            `INSERT INTO transactions (tx_index, block_index, tx_hash_id) VALUES (?, ?, ?)`,
            [txIndex, blockIndex, hashId]));
        return txIndex;
    }

    /** Insert an actions row (action_id/action_format are arbitrary; not read by this query). */
    async function insertAction(actionIndex, blockIndex, txIndex) {
        await conn(c => c.query(
            `INSERT INTO actions (action_index, block_index, tx_index, action_id, action_format)
             VALUES (?, ?, ?, 1, 1)`,
            [actionIndex, blockIndex, txIndex]));
    }

    /** Insert an anchor_actions row bound to `actionIndex` (one DOGE ANCHOR action carried by TXID). */
    async function insertAnchor(actionIndex, sectionIndex, statusIdVal, dogeBlock) {
        await conn(c => c.query(
            `INSERT INTO anchor_actions
                 (action_index, section_index, version, chain, network, block_index,
                  checkpoint_seq, status_id, block_index_doge)
             VALUES (?, ?, 0, 'BTC', 'regtest', ?, ?, ?, ?)`,
            [actionIndex, sectionIndex, actionIndex, actionIndex, statusIdVal, dogeBlock]));
    }

    /** Run the two production SQL statements directly, exactly as api.js's getanchorconfirmations does. */
    async function fetchPage(txid, after) {
        return conn(c => (after === null)
            ? c.query(ANCHOR_BY_TXID_SQL, [txid])
            : c.query(ANCHOR_BY_TXID_AFTER_SQL, [txid, after]));
    }

    /** Walk every page for `txid` the way anchor_proof_client.proveMined does, returning the
     *  concatenated `anchors` list plus how many response pages the walk took. */
    async function walkAllPages(txid) {
        let after = null;
        let anchors = [];
        let pages = 0;
        for (;;) {
            const rows = await fetchPage(txid, after);
            const resp = buildAnchorConfirmationsResponse(CONFIG, LATEST_DOGE_BLOCK, rows);
            pages++;
            assert.ok(resp.anchors.length <= ANCHOR_ROW_LIMIT,
                `page ${pages} returned ${resp.anchors.length} anchors, over ANCHOR_ROW_LIMIT (${ANCHOR_ROW_LIMIT})`);
            anchors = anchors.concat(resp.anchors);
            if (!resp.truncated) return { anchors, pages };
            assert.ok(resp.next_after_action_index !== null, 'a truncated page must carry a resume cursor');
            assert.ok(resp.next_after_action_index > (after === null ? -1 : after),
                'the resume cursor must move strictly forward, or the walk never terminates');
            after = resp.next_after_action_index;
            // Guard the test itself against an infinite loop if the production code regresses.
            assert.ok(pages < 100, 'walk did not terminate within 100 pages');
        }
    }

    // ── (a) more than ANCHOR_ROW_LIMIT rows, one per action_index ────────────────────

    it('partitions a set of ANCHOR_ROW_LIMIT * 2 + 3 rows across pages with no gap and no overlap', async function () {
        const statusValid = await statusId('valid');
        const hashId = await txHashId(TXID);
        await insertTransaction(1, 100, hashId);

        const total = ANCHOR_ROW_LIMIT * 2 + 3;   // guarantees at least 3 pages
        for (let i = 0; i < total; i++) {
            const actionIndex = 1000 + i;
            await insertAction(actionIndex, 100, 1);
            await insertAnchor(actionIndex, 0, statusValid, 500000 + i);
        }

        // A second txid's rows must never leak into TXID's walk (the WHERE it.hash = ?
        // term is exactly what a broken cursor could accidentally widen past).
        const otherHashId = await txHashId(OTHER_TXID);
        await insertTransaction(2, 100, otherHashId);
        await insertAction(9999, 100, 2);
        await insertAnchor(9999, 0, statusValid, 999999);

        const { anchors, pages } = await walkAllPages(TXID);

        assert.ok(pages >= 3, `expected the walk to take at least 3 pages, took ${pages}`);

        // No overlap: every (action_index, section_index) pair appears exactly once.
        const seen = new Set();
        for (const a of anchors) {
            const key = a.action_index + ':' + a.section_index;
            assert.ok(!seen.has(key), `row ${key} was served more than once across pages`);
            seen.add(key);
        }

        // No gap, and nothing missing or extra: the walked set is exactly the rows planted
        // for TXID, action_index 1000..1000+total-1, each ascending and none repeated.
        const gotIndexes = anchors.map(a => a.action_index).sort((x, y) => x - y);
        const wantIndexes = Array.from({ length: total }, (_, i) => 1000 + i);
        assert.deepStrictEqual(gotIndexes, wantIndexes,
            'the walked set must equal exactly the rows planted for this txid');

        // Confirmations math executed for real, not just shape: block_index_doge 500000+i
        // against LATEST_DOGE_BLOCK.
        const first = anchors.find(a => a.action_index === 1000);
        assert.strictEqual(first.confirmations, LATEST_DOGE_BLOCK - 500000 + 1);
    });

    // ── (b) a bundle (multiple section_index rows on one action_index) straddling the
    //        LIMIT+1 probe boundary must not be split mid-action ─────────────────────

    it('never ends a page inside a bundle: a multi-section action at the boundary moves whole to the next page', async function () {
        const statusValid = await statusId('valid');
        const hashId = await txHashId(TXID);
        await insertTransaction(1, 100, hashId);

        // ANCHOR_ROW_LIMIT - 1 singleton actions, then one 4-section bundle whose rows would
        // otherwise straddle the (ANCHOR_ROW_LIMIT, ANCHOR_ROW_LIMIT+1) boundary, then one
        // more singleton action after it so the bundle is provably not the last row in the
        // table (which would hide a boundary bug behind "there was nothing left to drop").
        const singletonsBefore = ANCHOR_ROW_LIMIT - 1;
        for (let i = 0; i < singletonsBefore; i++) {
            const actionIndex = 2000 + i;
            await insertAction(actionIndex, 100, 1);
            await insertAnchor(actionIndex, 0, statusValid, 600000 + i);
        }
        const bundleActionIndex = 2000 + singletonsBefore;
        await insertAction(bundleActionIndex, 100, 1);
        for (let s = 0; s < 4; s++)
            await insertAnchor(bundleActionIndex, s, statusValid, 700000);

        const trailingActionIndex = bundleActionIndex + 1;
        await insertAction(trailingActionIndex, 100, 1);
        await insertAnchor(trailingActionIndex, 0, statusValid, 800000);

        const { anchors } = await walkAllPages(TXID);

        // Every section of the bundle action must be present, and adjacent: a mid-bundle
        // cut would silently drop the sections that fell on the far side of the cursor.
        const bundleRows = anchors.filter(a => a.action_index === bundleActionIndex);
        assert.strictEqual(bundleRows.length, 4, 'all four bundle sections must survive the walk');
        assert.deepStrictEqual(bundleRows.map(a => a.section_index).sort((x, y) => x - y), [0, 1, 2, 3]);

        // And nothing else was lost either: singletons before and the trailing action are
        // both present, giving the exact expected total row count.
        assert.strictEqual(anchors.length, singletonsBefore + 4 + 1);
        assert.ok(anchors.some(a => a.action_index === trailingActionIndex));

        // Falsification: with the boundary trim removed, buildAnchorConfirmationsResponse
        // would keep the raw LIMIT-sized slice and truncate mid-bundle, dropping the
        // bundle's higher-numbered sections from the first page and then re-serving none of
        // them (the resume cursor is EXCLUSIVE on the bundle's own action_index). Reproduced
        // directly against the same real rows, without touching production code: slicing the
        // first-page result to ANCHOR_ROW_LIMIT with no trim loses exactly the sections the
        // real (trimmed) response preserves.
        const rawFirstPage = await fetchPage(TXID, null);
        const naiveSlice = rawFirstPage.slice(0, ANCHOR_ROW_LIMIT);
        const naiveBundleSections = naiveSlice
            .filter(r => r.action_index === bundleActionIndex)
            .map(r => r.section_index);
        assert.ok(naiveBundleSections.length < 4,
            'sanity check: an untrimmed LIMIT slice really does cut the bundle, proving the trim in ' +
            'buildAnchorConfirmationsResponse is load-bearing and this test would catch its removal');
    });
});
