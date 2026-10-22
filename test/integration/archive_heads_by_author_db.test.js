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
 * Its unit sibling (test/unit/bin/archive_heads_by_author.test.js) drives readHeads
 * over a stub doQueryStrict, so the SQL never executes: a wrong column, a bad join
 * or a LIMIT placeholder MariaDB will not accept passes every unit case. This file
 * pins what only a live server can: the query runs, returns the right rows in
 * (seq, action_index) order, filters by author, from-seq and limit, and the
 * refused head the reading counts is the one getArchiveHeadsByAuthorAndSeq
 * (the consensus read) excludes.
 *
 * Self-skips when TEST_DB_PASS is unset, matching the other DB-backed files here.
 * Run it with bin/run-db-tiers.sh -- test/integration/archive_heads_by_author_db.test.js
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
const DB_NAME = process.env.TEST_ARCHIVE_HEADS_BY_AUTHOR_DB || 'xchain_archive_heads_by_author';

const SQL_DIR = path.join(__dirname, '../../src/sql');
// Strip `--` line comments with the PRODUCT's own stripper: the licence banner starts
// `--***` with no whitespace, which MySQL does not treat as a comment (errno 1064).
const stripSqlLineComments = Database.prototype.stripSqlLineComments;
const SCHEMA = ['index_statuses.sql', 'index_addresses.sql', 'actions.sql', 'anchor_actions.sql']
    .map(f => stripSqlLineComments(fs.readFileSync(path.join(SQL_DIR, f), 'utf8')))
    .join('\n');

const AUTHOR_A = 'DAuthorAaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const AUTHOR_B = 'DAuthorBbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OTHER_INVALID = 'invalid: CHECKPOINT_SEQ (stale; replay of an older checkpoint)';

function makeDb() {
    const config = getTestConfig();
    const util   = new Utility();
    return new Database(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS, { config, util });
}

let db, status, addr;

const INSERT_ACTION = `INSERT INTO actions
    (action_index, block_index, tx_index, tx_vout, action_id, action_format, source_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`;
const INSERT_ANCHOR = `INSERT INTO anchor_actions
    (action_index, version, chain, network, block_index, checkpoint_seq, snapshot_block,
     match_batch_seq, match_count, batch_crc32, block_index_doge, status_id)
    VALUES (?, ?, 'BTC', 'regtest', 500, ?, ?, ?, ?, ?, 6240000, ?)`;

// One head: an actions row whose source_id is its author, plus its anchor_actions row.
async function plant(conn, h) {
    await conn.query(INSERT_ACTION, [h.action, 1000 + h.action, h.action, 0, 1, 0, addr[h.author]]);
    await conn.query(INSERT_ANCHOR, [h.action, h.version, h.seq, h.seq, h.seq,
        h.count === undefined ? null : h.count, h.crc === undefined ? null : h.crc, status[h.status]]);
}

async function seedHeads() {
    const conn = await db.getConnection();
    try {
        await conn.query('DELETE FROM anchor_actions');
        await conn.query('DELETE FROM actions');
        const heads = [
            { author: 'A', action: 40, version: 1, seq: 4, crc: 'aaaa', count: 2, status: 'valid' },
            { author: 'A', action: 41, version: 1, seq: 4, crc: 'bbbb', count: 3, status: ARCHIVE_REISSUE_RETRY_REASON },
            { author: 'A', action: 42, version: 2, seq: 4, status: 'valid' },
            { author: 'A', action: 50, version: 1, seq: 5, crc: 'cccc', count: 1, status: 'valid' },
            { author: 'B', action: 60, version: 1, seq: 4, crc: 'dddd', count: 4, status: 'valid' },
        ];
        for (const h of heads) await plant(conn, h);
    } finally { await conn.release(); }
}

describe('archive_heads_by_author readHeads() against a real MariaDB @tier3', function () {
    this.timeout(60000);

    before(async function () {
        if (!DB_PASS) this.skip();
        const admin = await mariadb.createConnection({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, multipleStatements: true });
        await admin.query('DROP DATABASE IF EXISTS ' + DB_NAME + '; CREATE DATABASE ' + DB_NAME + ';');
        await admin.query('USE ' + DB_NAME + '; ' + SCHEMA);
        await admin.end();

        db = makeDb();
        const conn = await db.getConnection();
        try {
            // Keyed by the FULL status text: the two invalid reasons share the prefix
            // before the colon and would fold onto one key if split there.
            for (const s of ['valid', 'unverified', ARCHIVE_REISSUE_RETRY_REASON, OTHER_INVALID])
                await conn.query('INSERT INTO index_statuses (status) VALUES (?)', [s]);
            status = {};
            for (const r of await conn.query('SELECT id, status FROM index_statuses'))
                status[String(r.status)] = Number(r.id);

            addr = {};
            for (const [k, a] of [['A', AUTHOR_A], ['B', AUTHOR_B]]) {
                await conn.query('INSERT INTO index_addresses (address, block_index) VALUES (?, ?)', [a, 1]);
                const rows = await conn.query('SELECT id FROM index_addresses WHERE address = ?', [a]);
                addr[k] = Number(rows[0].id);
            }
        } finally { await conn.release(); }
    });

    beforeEach(async function () { await seedHeads(); });

    after(async function () {
        if (db && db.close) await db.close();
    });

    it('lists the author heads in seq then action order with the full status text', async function () {
        const r = await readHeads(db, { author: AUTHOR_A, fromSeq: null, limit: 50, expectConflict: true });
        assert.deepStrictEqual(r.rows.map(x => Number(x.action_index)), [40, 41, 50]);
        assert.deepStrictEqual(r.rows.map(x => x.status), ['valid', ARCHIVE_REISSUE_RETRY_REASON, 'valid']);
        assert.deepStrictEqual(r.rows.map(x => x.batch_crc32), ['aaaa', 'bbbb', 'cccc']);
    });

    it('summarizes the refused seq and the later valid head', async function () {
        const r = await readHeads(db, { author: AUTHOR_A, fromSeq: null, limit: 50, expectConflict: true });
        assert.strictEqual(r.summary.refused, 1);
        assert.deepStrictEqual(r.summary.refusedSeqs, [4]);
        assert.strictEqual(r.summary.maxValidSeq, 5);
        assert.strictEqual(r.summary.redrawnAbove, true);
    });

    it('explains the refused head as a confirmed conflict against the earlier valid head', async function () {
        const r = await readHeads(db, { author: AUTHOR_A, fromSeq: null, limit: 50, expectConflict: true });
        assert.strictEqual(r.conflict.refused, 1);
        assert.strictEqual(r.conflict.confirmed, 1);
        assert.strictEqual(r.conflict.unexplained, 0);
    });

    it('applies fromSeq and limit as bound parameters', async function () {
        const from = await readHeads(db, { author: AUTHOR_A, fromSeq: 5, limit: 50, expectConflict: true });
        assert.deepStrictEqual(from.rows.map(x => Number(x.action_index)), [50]);
        const lim = await readHeads(db, { author: AUTHOR_A, fromSeq: null, limit: 1, expectConflict: true });
        assert.deepStrictEqual(lim.rows.map(x => Number(x.action_index)), [40]);
    });

    it('scopes to the author, so author B sees only its own head', async function () {
        const r = await readHeads(db, { author: AUTHOR_B, fromSeq: null, limit: 50, expectConflict: true });
        assert.deepStrictEqual(r.rows.map(x => Number(x.action_index)), [60]);
    });

    it('exitCodeFor passes the redraw expectation until the later head is gone', async function () {
        const opts = { author: AUTHOR_A, fromSeq: null, limit: 50, expectRedrawn: true };
        const before = await readHeads(db, opts);
        assert.strictEqual(exitCodeFor(before.summary, opts), 0);

        const conn = await db.getConnection();
        try {
            await conn.query('DELETE FROM anchor_actions WHERE action_index = 50');
            await conn.query('DELETE FROM actions WHERE action_index = 50');
        } finally { await conn.release(); }
        const after = await readHeads(db, opts);
        assert.strictEqual(exitCodeFor(after.summary, opts), 1);
    });

    it('the refused head the reading counts is the one the consensus read excludes', async function () {
        const rows = await db.getArchiveHeadsByAuthorAndSeq(AUTHOR_A, 4);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].batch_crc32, 'aaaa');
        assert.strictEqual(Number(rows[0].match_count), 2);
    });
});
