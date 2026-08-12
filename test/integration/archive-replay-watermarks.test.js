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
 * test/integration/archive-replay-watermarks.test.js
 *
 * Runs db.getArchiveReplayWatermarks() against a REAL MariaDB.
 *
 * Its unit sibling (test/unit/db.getArchiveReplayWatermarks.test.js) stubs
 * doQuery and asserts the query's SHAPE: one statement, the shared version
 * constant, both statuses. That is the right guard for those properties and it
 * cannot catch the one thing that matters most here, because the SQL never
 * executes: a wrong column name, a bad join, or a MAX() over the wrong table
 * would pass every unit assertion and then fail closed on a live node, where
 * the failure mode is not an error but a CONSENSUS VERDICT (the v1/v6 archive
 * replay guard in actions/anchor.js reads these two watermarks and rejects an
 * anchor as a stale replay).
 *
 * So this file exercises the semantics, not the shape:
 *   - version filter: v0 and v2 rows must NOT move either watermark
 *   - status filter: an `invalid: ...` row must NOT move either watermark
 *   - both watermarks come from the SAME row set, so a v0 row with a huge
 *     checkpoint_seq cannot raise checkpointSeq while batchSeq stays behind
 *   - empty table => both null, which is what makes the guard inert
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

const DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.TEST_DB_PORT) || 3306;
const DB_USER = process.env.TEST_DB_USER || 'root';
const DB_PASS = process.env.TEST_DB_PASS;            // undefined => self-skip
const DB_NAME = 'xchain_archive_watermarks';

const SQL_DIR = path.join(__dirname, '../../src/sql');
// Strip `--` line comments with the PRODUCT's own stripper, for the reason
// recovery-id-determinism.test.js documents: the licence banner starts `--***`
// with no whitespace, which MySQL does not treat as a comment, so a verbatim
// send is errno 1064 on the first line.
const stripSqlLineComments = Database.prototype.stripSqlLineComments;
const SCHEMA = ['index_statuses.sql', 'anchor_actions.sql']
    .map(f => stripSqlLineComments(fs.readFileSync(path.join(SQL_DIR, f), 'utf8')))
    .join('\n');

function makeDb() {
    const config = getTestConfig();
    const util   = new Utility();
    return new Database(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS, { config, util });
}

// One anchor row. Only the columns this watermark reads are meaningful; the rest
// exist so the insert is a realistic row rather than a two-column stub.
function anchorRow(o) {
    return [o.action_index, o.version, o.chain || 'BTC', o.network || 'regtest',
            o.block_index || 500, o.checkpoint_seq, o.snapshot_block || o.checkpoint_seq,
            (o.match_batch_seq === undefined ? null : o.match_batch_seq),
            o.block_index_doge || 6240000, o.status_id];
}

const INSERT = `INSERT INTO anchor_actions
    (action_index, version, chain, network, block_index, checkpoint_seq, snapshot_block,
     match_batch_seq, block_index_doge, status_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

describe('getArchiveReplayWatermarks() against a real MariaDB @tier3', function () {
    this.timeout(60000);

    let db, status;

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
            for (const s of ['valid', 'unverified', 'invalid: CHECKPOINT_SEQ (stale; replay of an older checkpoint)'])
                await conn.query('INSERT INTO index_statuses (status) VALUES (?)', [s]);
            const rows = await conn.query('SELECT id, status FROM index_statuses');
            status = {};
            for (const r of rows) status[String(r.status).split(':')[0]] = Number(r.id);
        } finally { await conn.release(); }
    });

    async function insert(rows) {
        const conn = await db.getConnection();
        try {
            await conn.query('DELETE FROM anchor_actions');
            for (const r of rows) await conn.query(INSERT, anchorRow(r));
        } finally { await conn.release(); }
    }

    it('an empty table yields both watermarks null, which is what leaves the guard inert', async function () {
        await insert([]);
        assert.deepStrictEqual(await db.getArchiveReplayWatermarks(),
                               { batchSeq: null, checkpointSeq: null });
    });

    it('reads batch and checkpoint seq off the archive-head rows', async function () {
        await insert([
            { action_index: 1, version: 1, checkpoint_seq: 100, match_batch_seq: 5, status_id: status.valid },
            { action_index: 2, version: 6, checkpoint_seq: 200, match_batch_seq: 7, status_id: status.unverified },
        ]);
        assert.deepStrictEqual(await db.getArchiveReplayWatermarks(),
                               { batchSeq: 7, checkpointSeq: 200 });
    });

    it('ignores non-archive versions, so a v0 checkpoint cannot raise the archive watermark', async function () {
        // The load-bearing case for reading both from ONE row set. A v0 anchor carries a
        // checkpoint_seq and NO batch seq; if checkpointSeq came from a wider row set than
        // batchSeq, this v0 row would raise the checkpoint watermark above every real
        // archive and the guard would start rejecting legitimate post-rebase batches.
        await insert([
            { action_index: 1, version: 1, checkpoint_seq: 100, match_batch_seq: 5, status_id: status.valid },
            { action_index: 2, version: 0, checkpoint_seq: 999999, status_id: status.valid },
            { action_index: 3, version: 2, checkpoint_seq: 888888, match_batch_seq: 99, status_id: status.valid },
        ]);
        assert.deepStrictEqual(await db.getArchiveReplayWatermarks(),
                               { batchSeq: 5, checkpointSeq: 100 });
    });

    it('ignores rows the parse rejected, so a junk anchor cannot move either watermark', async function () {
        await insert([
            { action_index: 1, version: 1, checkpoint_seq: 100, match_batch_seq: 5, status_id: status.valid },
            { action_index: 2, version: 6, checkpoint_seq: 777777, match_batch_seq: 4242, status_id: status.invalid },
        ]);
        assert.deepStrictEqual(await db.getArchiveReplayWatermarks(),
                               { batchSeq: 5, checkpointSeq: 100 });
    });

    it('counts an unverified row, because an unmirrored node stores every well-formed ANCHOR that way', async function () {
        await insert([
            { action_index: 1, version: 6, checkpoint_seq: 300, match_batch_seq: 11, status_id: status.unverified },
        ]);
        assert.deepStrictEqual(await db.getArchiveReplayWatermarks(),
                               { batchSeq: 11, checkpointSeq: 300 });
    });

    it('a NULL batch seq on an archive row does not defeat the batch watermark', async function () {
        // Defensive: match_batch_seq is nullable, and MAX() skips NULLs rather than
        // returning NULL, so one malformed-but-valid row must not blank the watermark.
        await insert([
            { action_index: 1, version: 1, checkpoint_seq: 100, match_batch_seq: null, status_id: status.valid },
            { action_index: 2, version: 1, checkpoint_seq: 150, match_batch_seq: 3,    status_id: status.valid },
        ]);
        assert.deepStrictEqual(await db.getArchiveReplayWatermarks(),
                               { batchSeq: 3, checkpointSeq: 150 });
    });
});
