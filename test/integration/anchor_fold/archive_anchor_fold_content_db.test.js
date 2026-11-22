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
 * test/integration/anchor_fold/archive_anchor_fold_content_db.test.js
 *
 * A folded v3 ANCHOR stores its archive in two halves of one action: the
 * wrapper section's row carries the checkpoint identity plus MATCH_COUNT and
 * BATCH_CRC32, and a chain-null row carries the batch seq and chunk geometry.
 * The hub recognises its own earlier folded send by asking getarchiveanchor
 * for the wrapper checkpoint plus the batch content key, so the content read
 * has to join those halves. The unit suites pin the SQL text only; this file
 * seeds a fold through the real recordFoldAction and createAnchorAction and
 * runs getArchiveAnchorByContent against a throwaway MariaDB.
 *
 * Self-skips when TEST_DB_PASS is unset, matching the other DB-backed files.
 * Run it with bin/run-db-tiers.sh, or point TEST_DB_* at any throwaway
 * MariaDB reachable over TCP.
 */

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');

const { getTestConfig } = require('../../fixtures/config');
const Utility  = require('../../../src/utility');
const Database = require('../../../src/db');
const { recordFoldAction } = require('../../../src/actions/anchor/v3/v3_record.js');
const {
    buildArchiveAnchorResponse, validateArchiveAnchorParams
} = require('../../../src/actions/anchor/anchor_action_query/archive_query.js');

const DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.TEST_DB_PORT) || 3306;
const DB_USER = process.env.TEST_DB_USER || 'root';
const DB_PASS = process.env.TEST_DB_PASS;            // undefined => self-skip
const DB_NAME = process.env.TEST_ARCHIVE_FOLD_CONTENT_DB || 'xchain_archive_fold_content';

const SQL_DIR = path.join(__dirname, '../../../src/sql');
const stripSqlLineComments = Database.prototype.stripSqlLineComments;
const SCHEMA = ['index_statuses.sql', 'index_transactions.sql', 'index_addresses.sql',
                'transactions.sql', 'actions.sql', 'anchor_actions.sql']
    .map(f => stripSqlLineComments(fs.readFileSync(path.join(SQL_DIR, f), 'utf8')))
    .join('\n');

const AUTHOR = 'DFoldPublisherAddr1';
const OTHER_AUTHOR = 'DSomeoneElseAddr22';
const TXID = 'ab'.repeat(32);
const CRC = '0a1b2c3d';
const ACTION_INDEX = 100;
const DOGE_HEIGHT = 5000;
const WRAPPER = { chain: 'BTC', network: 'regtest', block_index: 1, checkpoint_seq: 2 };

let db = null;

function makeDb() {
    return new Database(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS,
        { config: getTestConfig(), util: new Utility() });
}

async function withConn(fn) {
    const c = await db.getConnection();
    try { return await fn(c); } finally { await c.release(); }
}

// The action row, its transaction and its source address, so the content read can
// resolve the head's author and txid the way it does on a live node.
async function seedActionLinkage(actionIndex, author, txid) {
    await withConn(async c => {
        await c.query('INSERT IGNORE INTO index_addresses (address) VALUES (?)', [author]);
        const adr = await c.query('SELECT id FROM index_addresses WHERE address = ?', [author]);
        await c.query('INSERT IGNORE INTO index_transactions (hash) VALUES (?)', [txid]);
        const tx = await c.query('SELECT id FROM index_transactions WHERE hash = ?', [txid]);
        await c.query('INSERT INTO transactions (tx_index, block_index, tx_hash_id) VALUES (?, ?, ?)',
            [actionIndex, DOGE_HEIGHT, Number(tx[0].id)]);
        await c.query(`INSERT INTO actions (action_index, block_index, tx_index, action_id, action_format, source_id)
                       VALUES (?, ?, ?, 1, 3, ?)`, [actionIndex, DOGE_HEIGHT, actionIndex, Number(adr[0].id)]);
    });
}

// Records one folded action exactly as the v3 handler does: an LTC section, the BTC
// wrapper section that carries the archive, and the chain-null archive row.
async function seedFold(actionIndex, totalChunks) {
    const data = { ACTION_INDEX: actionIndex, FORMAT: 3, NETWORK: 'regtest', STATUS: 'valid',
                   BLOCK_INDEX: DOGE_HEIGHT, SNAPSHOT_BLOCK: 9 };
    const sections = [
        { CHAIN: 'LTC', BLOCK_INDEX_CHECKPOINTED: 11, CHECKPOINT_SEQ: 4, SNAPSHOT_BLOCK: 9, SIGS: [{ p: 'l' }] },
        { CHAIN: WRAPPER.chain, BLOCK_INDEX_CHECKPOINTED: WRAPPER.block_index,
          CHECKPOINT_SEQ: WRAPPER.checkpoint_seq, SNAPSHOT_BLOCK: 9, SIGS: [{ p: 'w' }] }
    ];
    const archive = { WRAPPER_SECTION_INDEX: 1, MATCH_BATCH_SEQ: 7, MATCH_COUNT: 5,
                      BATCH_CRC32: CRC.toUpperCase(), TOTAL_CHUNKS: totalChunks, ARCHIVE_B64: 'eA==' };
    await recordFoldAction({ indexerDb: db }, data, sections, archive, [], null);
}

async function lookup(key, author) {
    const k = Object.assign({}, WRAPPER, { batch_crc32: CRC, match_count: 5 }, key);
    const v = validateArchiveAnchorParams(Object.assign({}, k, { author }));
    assert.strictEqual(v.ok, true);
    assert.ok(!v.author_only, 'a content-key request must not route to the publisher-sequence read');
    const found = await db.getArchiveAnchorByContent(k.chain, k.network, v.block_index,
        v.checkpoint_seq, v.batch_crc32, v.match_count, v.author);
    return buildArchiveAnchorResponse({ COIN: 'DOGE', NETWORK: 'regtest' }, DOGE_HEIGHT + 3, found.head, found.chunks);
}

describe('folded archive content lookup against a real MariaDB @tier3', function () {
    this.timeout(60000);

    before(async function () {
        if (!DB_PASS) this.skip();
        const admin = await mariadb.createConnection({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, multipleStatements: true });
        await admin.query('DROP DATABASE IF EXISTS ' + DB_NAME + '; CREATE DATABASE ' + DB_NAME + ';');
        await admin.query('USE ' + DB_NAME + '; ' + SCHEMA);
        await admin.end();
        db = makeDb();
        await seedActionLinkage(ACTION_INDEX, AUTHOR, TXID);
        await seedFold(ACTION_INDEX, 2);
    });

    after(async function () {
        if (db && db.pool) await db.pool.end();
        db = null;
    });

    it('answers the wrapper checkpoint plus content key with the folded head, its seq, author and txid', async function () {
        const r = await lookup({}, AUTHOR);
        assert.strictEqual(r.exists, true);
        assert.strictEqual(r.txid, TXID);
        assert.strictEqual(r.author, AUTHOR);
        assert.strictEqual(Number(r.match_batch_seq), 7);
        assert.strictEqual(Number(r.version), 3);
        assert.strictEqual(r.checkpoint_chain, WRAPPER.chain);
        assert.strictEqual(r.checkpoint_network, WRAPPER.network);
        assert.strictEqual(Number(r.block_index), WRAPPER.block_index);
        assert.strictEqual(Number(r.checkpoint_seq), WRAPPER.checkpoint_seq);
        assert.strictEqual(String(r.batch_crc32).toLowerCase(), CRC);
        assert.strictEqual(Number(r.match_count), 5);
        assert.strictEqual(Number(r.total_chunks), 2);
    });

    it('reads absent for a folded head under another author, a non-wrapper section or a different batch', async function () {
        assert.strictEqual((await lookup({}, OTHER_AUTHOR)).exists, false);
        assert.strictEqual((await lookup({ chain: 'LTC', block_index: 11, checkpoint_seq: 4 }, AUTHOR)).exists, false);
        assert.strictEqual((await lookup({ batch_crc32: 'ffffffff' }, AUTHOR)).exists, false);
        assert.strictEqual((await lookup({ match_count: 6 }, AUTHOR)).exists, false);
    });
});
