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
 * Its unit sibling (test/unit/bin/archive_heads_by_author.test.js) drives
 * readHeads over a stub doQueryStrict, so the SQL never executes: a wrong
 * column, a bad join or a LIMIT placeholder MariaDB will not run passes every
 * unit case and first fails on a live rail. This file plants real rows and
 * pins what the reading returns for them:
 *   - the heads of one author come back at every status, ordered by seq then
 *     action, with the full status text, and a version 2 row never appears
 *   - another author's head at the same seq is not read
 *   - --from-seq and --limit narrow the rows
 *   - summary, conflict and exit code follow from those rows
 *   - the refused head the reading counts is the one the consensus read
 *     (getArchiveHeadsByAuthorAndSeq) excludes
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
// Strip `--` line comments with the PRODUCT's own stripper: the licence banner
// starts `--***` with no whitespace, which MySQL does not treat as a comment.
const stripSqlLineComments = Database.prototype.stripSqlLineComments;
const SCHEMA = ['index_statuses.sql', 'index_addresses.sql', 'actions.sql', 'anchor_actions.sql']
    .map(f => stripSqlLineComments(fs.readFileSync(path.join(SQL_DIR, f), 'utf8')))
    .join('\n');

const AUTHOR_A = 'archive-author-A';
const AUTHOR_B = 'archive-author-B';
const OTHER_INVALID = 'invalid: CHECKPOINT_SEQ (stale; replay of an older checkpoint)';

let db, status, addr;

function makeDb() {
    const config = getTestConfig();
    const util   = new Utility();
    return new Database(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS, { config, util });
}

// One head: an actions row whose source_id points at its author, and the anchor row.
async function plant(conn, h) {
    await conn.query(
        'INSERT INTO actions (action_index, block_index, action_id, source_id) VALUES (?, ?, ?, ?)',
        [h.action, 500, 1, addr[h.author]]);
    await conn.query(
        `INSERT INTO anchor_actions
            (action_index, version, chain, network, block_index, checkpoint_seq, snapshot_block,
             match_batch_seq, match_count, batch_crc32, status_id, block_index_doge)
         VALUES (?, ?, 'BTC', 'regtest', 500, ?, ?, ?, ?, ?, ?, 6240000)`,
        [h.action, h.version, h.seq, h.seq, h.seq, h.count || null, h.crc || null, status[h.status]]);
}

async function seedHeads() {
    const conn = await db.getConnection();
    try {
        await conn.query('DELETE FROM anchor_actions');
        await conn.query('DELETE FROM actions');
        const heads = [
            { author: AUTHOR_A, action: 40, version: 1, seq: 4, crc: 'aaaa', count: 2, status: 'valid' },
            { author: AUTHOR_A, action: 41, version: 1, seq: 4, crc: 'bbbb', count: 3, status: ARCHIVE_REISSUE_RETRY_REASON },
            { author: AUTHOR_A, action: 42, version: 2, seq: 4, status: 'valid' },
            { author: AUTHOR_A, action: 50, version: 1, seq: 5, crc: 'cccc', count: 1, status: 'valid' },
            { author: AUTHOR_B, action: 60, version: 1, seq: 4, crc: 'dddd', count: 4, status: 'valid' },
        ];
        for (const h of heads) await plant(conn, h);
    } finally { await conn.release(); }
}

const A = (extra) => Object.assign(
    { author: AUTHOR_A, fromSeq: null, limit: 50, expectConflict: true }, extra);

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
        const conn = await db.getConnection();
        try {
            // Keyed by the FULL status text: the two invalid reasons share the prefix
            // before the colon and must not fold onto one key.
            const texts = ['valid', 'unverified', ARCHIVE_REISSUE_RETRY_REASON, OTHER_INVALID];
            for (const s of texts)
                await conn.query('INSERT INTO index_statuses (status) VALUES (?)', [s]);
            status = {};
            for (const r of await conn.query('SELECT id, status FROM index_statuses'))
                status[String(r.status)] = Number(r.id);
            assert.strictEqual(Object.keys(status).length, texts.length);

            addr = {};
            for (const a of [AUTHOR_A, AUTHOR_B]) {
                await conn.query('INSERT INTO index_addresses (address) VALUES (?)', [a]);
                const rows = await conn.query('SELECT id FROM index_addresses WHERE address = ?', [a]);
                addr[a] = Number(rows[0].id);
            }
        } finally { await conn.release(); }
    });

    beforeEach(async function () { await seedHeads(); });

    it('returns the author heads at every status in seq then action order, without the v2 row or the other author', async function () {
        const result = await readHeads(db, A());
        assert.deepStrictEqual(result.rows.map(r => Number(r.action_index)), [40, 41, 50]);
        assert.deepStrictEqual(result.rows.map(r => r.status),
                               ['valid', ARCHIVE_REISSUE_RETRY_REASON, 'valid']);
    });

    it('summarizes the refused seq and the later valid head', async function () {
        const { summary } = await readHeads(db, A());
        assert.strictEqual(summary.refused, 1);
        assert.deepStrictEqual(summary.refusedSeqs, [4]);
        assert.strictEqual(summary.maxValidSeq, 5);
        assert.strictEqual(summary.redrawnAbove, true);
    });

    it('confirms the refused head as a conflict with the earlier valid head', async function () {
        const { conflict } = await readHeads(db, A());
        assert.strictEqual(conflict.refused, 1);
        assert.strictEqual(conflict.confirmed, 1);
        assert.strictEqual(conflict.unexplained, 0);
    });

    it('narrows to seq 5 with fromSeq', async function () {
        const result = await readHeads(db, A({ fromSeq: 5 }));
        assert.deepStrictEqual(result.rows.map(r => Number(r.action_index)), [50]);
    });

    it('cuts the rows at limit', async function () {
        const result = await readHeads(db, A({ limit: 1 }));
        assert.deepStrictEqual(result.rows.map(r => Number(r.action_index)), [40]);
    });

    it('exits 0 when the redraw is expected and present, and 1 once the later head is gone', async function () {
        const present = await readHeads(db, A());
        assert.strictEqual(exitCodeFor(present.summary, { expectRedrawn: true }), 0);

        const conn = await db.getConnection();
        try {
            await conn.query('DELETE FROM anchor_actions WHERE action_index = 50');
            await conn.query('DELETE FROM actions WHERE action_index = 50');
        } finally { await conn.release(); }

        const gone = await readHeads(db, A());
        assert.strictEqual(exitCodeFor(gone.summary, { expectRedrawn: true }), 1);
    });

    it('counts a refused head that the consensus read excludes', async function () {
        const rows = await db.getArchiveHeadsByAuthorAndSeq(AUTHOR_A, 4);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].batch_crc32, 'aaaa');
        assert.strictEqual(Number(rows[0].match_count), 2);
    });
});
