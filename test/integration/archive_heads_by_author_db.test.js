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
 * test/integration/archive_heads_by_author_db.test.js
 *
 * Runs readHeads() from bin/archive_heads_by_author.js against a REAL MariaDB.
 *
 * Its unit sibling (test/unit/bin/archive_heads_by_author.test.js) drives readHeads over a
 * stub doQueryStrict, so the SQL never executes: a wrong column, a bad join or a LIMIT
 * placeholder MariaDB will not accept passes every unit case and first fails on a live node.
 * This file pins what only a real database can:
 *   - the heads of one author come back in (seq, action_index) order with the full status text
 *   - a version 2 continuation row and another author's head are left out
 *   - fromSeq and limit bind and filter as documented
 *   - the summary, conflict and exit code read off those rows
 *   - the refused head the reading counts is the one getArchiveHeadsByAuthorAndSeq excludes
 *
 * Self-skips when TEST_DB_PASS is unset, matching the other DB-backed files here.
 * Run it with bin/run-db-tiers.sh.
 */

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');

const { getTestConfig } = require('../fixtures/config');
const Utility  = require('../../src/utility');
const Database = require('../../src/db');
const { ARCHIVE_REISSUE_RETRY_REASON } =
    require('../../src/actions/anchor/archive/archive_reissue.js');
const { readHeads, exitCodeFor } = require('../../bin/archive_heads_by_author.js');

const DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.TEST_DB_PORT) || 3306;
const DB_USER = process.env.TEST_DB_USER || 'root';
const DB_PASS = process.env.TEST_DB_PASS;            // undefined => self-skip
const DB_NAME = process.env.TEST_ARCHIVE_HEADS_DB || 'xchain_archive_heads_by_author';

const SQL_DIR = path.join(__dirname, '../../src/sql');
// Strip `--` line comments with the PRODUCT's own stripper: the licence banner starts
// `--***` with no whitespace, which MySQL does not treat as a comment (errno 1064).
const stripSqlLineComments = Database.prototype.stripSqlLineComments;
const SCHEMA = ['index_statuses.sql', 'index_addresses.sql', 'actions.sql', 'anchor_actions.sql']
    .map(f => stripSqlLineComments(fs.readFileSync(path.join(SQL_DIR, f), 'utf8')))
    .join('\n');

const OTHER_INVALID = 'invalid: CHECKPOINT_SEQ (stale; replay of an older checkpoint)';
const AUTHOR_A = 'DAuthorAaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const AUTHOR_B = 'DAuthorBbbbbbbbbbbbbbbbbbbbbbbbbbbb';

let db, status, addr;

function makeDb() {
    const config = getTestConfig();
    const util   = new Utility();
    return new Database(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS, { config, util });
}

// Heads planted for the two authors. Action index doubles as the key the assertions use.
const HEADS = [
    { action: 40, author: 'A', version: 1, seq: 4, crc: 'aaaa', count: 2, status: 'valid' },
    { action: 41, author: 'A', version: 1, seq: 4, crc: 'bbbb', count: 3, status: ARCHIVE_REISSUE_RETRY_REASON },
    { action: 42, author: 'A', version: 2, seq: 4, crc: null,   count: null, status: 'valid' },
    { action: 50, author: 'A', version: 1, seq: 5, crc: 'cccc', count: 2, status: 'valid' },
    { action: 60, author: 'B', version: 1, seq: 4, crc: 'dddd', count: 4, status: 'valid' },
];

async function seedHeads(conn, heads) {
    await conn.query('DELETE FROM anchor_actions');
    await conn.query('DELETE FROM actions');
    for (const h of heads) {
        await conn.query(
            'INSERT INTO actions (action_index, block_index, action_id, source_id) VALUES (?, ?, ?, ?)',
            [h.action, 500, 1, addr[h.author]]);
        await conn.query(
            `INSERT INTO anchor_actions
                (action_index, version, chain, network, block_index, checkpoint_seq, snapshot_block,
                 match_batch_seq, match_count, batch_crc32, block_index_doge, status_id)
             VALUES (?, ?, 'BTC', 'regtest', 500, ?, ?, ?, ?, ?, 6240000, ?)`,
            [h.action, h.version, h.seq, h.seq, h.seq, h.count, h.crc, status[h.status]]);
    }
}

async function withConn(fn) {
    const conn = await db.getConnection();
    try { return await fn(conn); } finally { await conn.release(); }
}

describe('bin/archive_heads_by_author.js readHeads() against a real MariaDB @tier3', function () {
    this.timeout(60000);

    before(async function () {
        if (!DB_PASS) this.skip();
        const admin = await mariadb.createConnection({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, multipleStatements: true });
        await admin.query('DROP DATABASE IF EXISTS ' + DB_NAME + '; CREATE DATABASE ' + DB_NAME + ';');
        await admin.query('USE ' + DB_NAME + '; ' + SCHEMA);
        await admin.end();

        db = makeDb();
        await withConn(async conn => {
            // Keyed by the FULL status text: the two invalid reasons share the prefix before
            // the colon and would fold onto one key if split there.
            for (const s of ['valid', 'unverified', ARCHIVE_REISSUE_RETRY_REASON, OTHER_INVALID])
                await conn.query('INSERT INTO index_statuses (status) VALUES (?)', [s]);
            status = {};
            for (const r of await conn.query('SELECT id, status FROM index_statuses'))
                status[r.status] = Number(r.id);
            assert.strictEqual(Object.keys(status).length, 4);

            addr = {};
            for (const [k, a] of [['A', AUTHOR_A], ['B', AUTHOR_B]]) {
                const res = await conn.query('INSERT INTO index_addresses (address, block_index) VALUES (?, 1)', [a]);
                addr[k] = Number(res.insertId);
            }
        });
    });

    beforeEach(async function () {
        await withConn(conn => seedHeads(conn, HEADS));
    });

    const opts = (o) => Object.assign(
        { author: AUTHOR_A, fromSeq: null, limit: 50, expectConflict: true }, o);

    it('returns the author heads in seq order with the full status text, leaving out v2 and other authors', async function () {
        const result = await readHeads(db, opts());
        assert.deepStrictEqual(result.rows.map(r => Number(r.action_index)), [40, 41, 50]);
        assert.deepStrictEqual(result.rows.map(r => r.status),
                               ['valid', ARCHIVE_REISSUE_RETRY_REASON, 'valid']);
        assert.strictEqual(result.rows[1].batch_crc32, 'bbbb');
        assert.strictEqual(Number(result.rows[1].match_count), 3);
    });

    it('summarizes the refused seq and the later valid head, and explains the refusal as a conflict', async function () {
        const result = await readHeads(db, opts());
        assert.strictEqual(result.summary.refused, 1);
        assert.deepStrictEqual(result.summary.refusedSeqs, [4]);
        assert.strictEqual(result.summary.maxValidSeq, 5);
        assert.strictEqual(result.summary.redrawnAbove, true);
        assert.strictEqual(result.conflict.refused, 1);
        assert.strictEqual(result.conflict.confirmed, 1);
        assert.strictEqual(result.conflict.unexplained, 0);
    });

    it('binds fromSeq and limit', async function () {
        const from = await readHeads(db, opts({ fromSeq: 5 }));
        assert.deepStrictEqual(from.rows.map(r => Number(r.action_index)), [50]);
        const limited = await readHeads(db, opts({ limit: 1 }));
        assert.deepStrictEqual(limited.rows.map(r => Number(r.action_index)), [40]);
    });

    it('exits 0 for an expected redraw, and 1 once the later head is gone', async function () {
        const present = await readHeads(db, opts());
        assert.strictEqual(exitCodeFor(present.summary, { expectRedrawn: true }), 0);

        await withConn(conn => conn.query('DELETE FROM anchor_actions WHERE action_index = 50'));
        const absent = await readHeads(db, opts());
        assert.strictEqual(absent.summary.redrawnAbove, false);
        assert.strictEqual(exitCodeFor(absent.summary, { expectRedrawn: true }), 1);
    });

    it('counts the refused head that getArchiveHeadsByAuthorAndSeq excludes from the consensus read', async function () {
        const rows = await db.getArchiveHeadsByAuthorAndSeq(AUTHOR_A, 4);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].batch_crc32, 'aaaa');
        assert.strictEqual(Number(rows[0].match_count), 2);
        assert.strictEqual(rows[0].status, 'valid');
    });
});
