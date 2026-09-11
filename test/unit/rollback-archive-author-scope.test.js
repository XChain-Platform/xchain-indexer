/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Publisher scoping of the reorg 'invalid_archive' reset, driven against REAL
 * anchor_actions rows in a real SQL engine.
 *
 * MATCH_BATCH_SEQ is not a batch key. Once archive batches are publisher-scoped
 * (archive_batch_author_activation.js) two publishers hold two live batches under
 * one seq, each with its own head and its own chunks stored 'valid'. The reset
 * self-joins head to chunk on the seq alone, so one publisher's orphaned chunk
 * resets the OTHER publisher's head, whose batch survives the reorg intact and
 * whose stamp a from-genesis replay still re-derives.
 *
 * The query under test is the one rollback.js actually builds: it is captured
 * from a Rollback run and then mechanically turned into the matching SELECT
 * (`UPDATE anchor_actions p` -> `SELECT p.action_index FROM anchor_actions p`,
 * `SET p.status_id = us.id` dropped), because sqlite has no multi-table UPDATE.
 * Every JOIN and every WHERE term, which is the whole of what is under test,
 * survives that rewrite untouched and is evaluated by the engine.
 *
 ********************************************************************/
'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const fs     = require('fs');
const path   = require('path');
const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer } = require('../fixtures/mocks');
const { mysqlDdlToSqlite }  = require('../helpers/sqlAnchorDb');
const Rollback = require('../../src/rollback.js');
const {
    ARCHIVE_ROLLBACK_AUTHOR_SCOPE_ACTIVATION,
    ARCHIVE_AUTHOR_SCOPE_JOIN_SQL,
    isArchiveRollbackAuthorScopeActive,
    archiveAuthorScopeJoin,
} = require('../../src/archive_rollback_author_scope_activation.js');
const { ARCHIVE_BATCH_AUTHOR_ACTIVATION } = require('../../src/archive_batch_author_activation.js');

const SQL_DIR = path.join(__dirname, '..', '..', 'src', 'sql');
const BATCH_SEQ = 7;
// The rollback target, and the action index the orphaned range starts at.
const ROLLBACK_BLOCK = 100;
const FIRST_ORPHANED = 250;

// MySQL index names are scoped to their table and sqlite's are database-wide, so
// four real DDL scripts collide on shared names like `block_index`. Prefix each
// index with its table; nothing the joins read is touched.
function qualifyIndexNames(ddl){
    return ddl.replace(/CREATE\s+(UNIQUE\s+)?INDEX\s+(\S+)\s+on\s+(\S+)/gi,
        (m, uniq, name, table) => 'CREATE ' + (uniq || '') + 'INDEX ' + table + '_' + name + ' on ' + table);
}

// An in-memory engine holding the four tables the reset joins, built from the
// project's own DDL so a column rename in src/sql reaches this test.
function makeDb(){
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    for(const file of ['index_statuses.sql', 'anchor_actions.sql', 'actions.sql', 'index_addresses.sql']){
        db.exec(qualifyIndexNames(mysqlDdlToSqlite(fs.readFileSync(path.join(SQL_DIR, file), 'utf8'))));
    }
    const api = {
        status(name){
            db.prepare('INSERT OR IGNORE INTO index_statuses (status) VALUES (?)').run(name);
            return db.prepare('SELECT id FROM index_statuses WHERE status = ?').get(name).id;
        },
        address(addr, id){
            db.prepare('INSERT INTO index_addresses (id, address, block_index) VALUES (?, ?, 1)').run(id, addr);
            return id;
        },
        // An anchor row plus the actions row carrying its authoritative source, or
        // the anchor row alone when `sourceId` is null (a broken action linkage).
        anchor(row, sourceId){
            const cols = Object.keys(row);
            db.prepare('INSERT INTO anchor_actions (' + cols.join(', ') + ') VALUES (' +
                cols.map(() => '?').join(', ') + ')').run(...cols.map(c => row[c]));
            if(sourceId !== null){
                db.prepare('INSERT INTO actions (action_index, block_index, action_id, source_id) VALUES (?, ?, 1, ?)')
                  .run(row.action_index, Number(row.block_index_doge), sourceId);
            }
        },
        // The parent action indexes the captured reset UPDATE would have written.
        resetTargets(sql, args){
            const select = sql
                .replace('UPDATE anchor_actions p', 'SELECT p.action_index FROM anchor_actions p')
                .replace('SET p.status_id = us.id', '');
            return db.prepare(select).all(...args).map(r => Number(r.action_index));
        },
        close(){ db.close(); },
    };
    return api;
}

// Two publishers, one seq: A heads the batch whose chunk survives the reorg, B
// heads a second batch under the same seq whose chunk is orphaned. Both heads
// carry the wedged stamp, so only the author term can tell their resets apart.
function seedTwoPublishers(db){
    const validId   = db.status('valid');
    const invalidId = db.status('invalid_archive');
    db.status('unverified');
    const addrA = db.address('addressPublisherA', 11);
    const addrB = db.address('addressPublisherB', 22);
    db.anchor({ action_index: 100, version: 1, chain: 'BTC', network: 'regtest',
                match_batch_seq: BATCH_SEQ, total_chunks: 2, batch_crc32: 'deadbeef',
                status_id: invalidId, block_index_doge: 10 }, addrA);
    db.anchor({ action_index: 110, version: 1, chain: 'BTC', network: 'regtest',
                match_batch_seq: BATCH_SEQ, total_chunks: 2, batch_crc32: 'feedface',
                status_id: invalidId, block_index_doge: 11 }, addrB);
    db.anchor({ action_index: 200, version: 2, match_batch_seq: BATCH_SEQ, chunk_index: 1,
                total_chunks: 2, archive_b64: 'AAAA', status_id: validId, block_index_doge: 20 }, addrA);
    db.anchor({ action_index: 300, version: 2, match_batch_seq: BATCH_SEQ, chunk_index: 1,
                total_chunks: 2, archive_b64: 'BBBB', status_id: validId, block_index_doge: 30 }, addrB);
    return { headA: 100, headB: 110 };
}

// One publisher, one seq: the shape every honest batch has.
function seedOnePublisher(db){
    const validId   = db.status('valid');
    const invalidId = db.status('invalid_archive');
    db.status('unverified');
    const addrA = db.address('addressPublisherA', 11);
    db.anchor({ action_index: 100, version: 1, chain: 'BTC', network: 'regtest',
                match_batch_seq: BATCH_SEQ, total_chunks: 2, batch_crc32: 'deadbeef',
                status_id: invalidId, block_index_doge: 10 }, addrA);
    db.anchor({ action_index: 300, version: 2, match_batch_seq: BATCH_SEQ, chunk_index: 1,
                total_chunks: 2, archive_b64: 'AAAA', status_id: validId, block_index_doge: 30 }, addrA);
    return { headA: 100 };
}

// Run a rollback against a mock indexer and hand back the reset UPDATE it issued.
async function captureResetQuery(){
    const indexer = createMockIndexer();
    indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: FIRST_ORPHANED }]);
    indexer.indexerDb.doQuery.resolves([]);
    indexer.indexerDb.createStatus = sinon.stub().resolves(1);
    await new Rollback(indexer).rollback(ROLLBACK_BLOCK);
    const call = indexer.indexerDb.doQuery.getCalls().find(c =>
        /UPDATE anchor_actions p/.test(c.args[0]) && /status = 'invalid_archive'/.test(c.args[0]));
    assert.ok(call, 'expected the anchor invalid_archive reset UPDATE');
    return { sql: call.args[0], args: call.args[1] };
}

// Force the regtest threshold around a body, always restoring it.
async function withRegtestHeight(height, fn){
    const prev = ARCHIVE_ROLLBACK_AUTHOR_SCOPE_ACTIVATION.regtest;
    ARCHIVE_ROLLBACK_AUTHOR_SCOPE_ACTIVATION.regtest = height;
    try { return await fn(); } finally { ARCHIVE_ROLLBACK_AUTHOR_SCOPE_ACTIVATION.regtest = prev; }
}

describe('archive invalid_archive reset: publisher scoping @regression', function(){

    describe('the flag day is armed on mainnet and testnet (2026-09-09 ruling)', function(){
        it('carries the ruled heights, and splices the author term exactly at each one', function(){
            assert.deepStrictEqual(ARCHIVE_ROLLBACK_AUTHOR_SCOPE_ACTIVATION,
                { mainnet: 0, testnet: 67915000, regtest: 9999999999 },
                'a silent revert to the inert sentinel puts the whole fleet back on the unscoped reset');
            // Mainnet is scoped from genesis: it holds 0 archive chunks (measured 2026-09-09),
            // so the author term narrows an empty join and the reset is unchanged in effect.
            assert.strictEqual(isArchiveRollbackAuthorScopeActive(0, 'mainnet'), true);
            assert.ok(archiveAuthorScopeJoin(0, 'mainnet').includes('cadr.address = padr.address'),
                'mainnet must splice the author term from genesis');
            // Testnet has live history, so the term appears only at the flag day, not below it.
            assert.strictEqual(isArchiveRollbackAuthorScopeActive(67914999, 'testnet'), false);
            assert.strictEqual(archiveAuthorScopeJoin(67914999, 'testnet'), '',
                'a testnet block below the flag day must keep the deployed unscoped reset');
            assert.strictEqual(isArchiveRollbackAuthorScopeActive(67915000, 'testnet'), true);
            assert.ok(archiveAuthorScopeJoin(67915000, 'testnet').includes('cadr.address = padr.address'));
            // regtest keeps the sentinel so the flag-day-off control path below stays drivable.
            assert.strictEqual(isArchiveRollbackAuthorScopeActive(1000000000, 'regtest'), false);
            assert.strictEqual(archiveAuthorScopeJoin(1000000000, 'regtest'), '');
        });

        it('reads inactive for an unknown or omitted network and an unparseable height', function(){
            assert.strictEqual(isArchiveRollbackAuthorScopeActive(0, undefined), false);
            assert.strictEqual(isArchiveRollbackAuthorScopeActive(0, null), false);
            assert.strictEqual(isArchiveRollbackAuthorScopeActive(0, 'signet'), false);
            assert.strictEqual(isArchiveRollbackAuthorScopeActive('not-a-height', 'regtest'), false);
        });

        // Author equality is the exact batch key only where anchor.js scopes a chunk set to
        // the head's OWN author. Below that height the set is scoped to the CANONICAL head's
        // author, so the term would suppress a reset that is genuinely owed.
        it('never arms a network below its own ARCHIVE_BATCH_AUTHOR height', function(){
            for(const network of Object.keys(ARCHIVE_ROLLBACK_AUTHOR_SCOPE_ACTIVATION)){
                const batchAuthor = ARCHIVE_BATCH_AUTHOR_ACTIVATION[network];
                assert.strictEqual(typeof batchAuthor, 'number',
                    network + ' has no ARCHIVE_BATCH_AUTHOR height to order against');
                assert.ok(ARCHIVE_ROLLBACK_AUTHOR_SCOPE_ACTIVATION[network] >= batchAuthor,
                    network + ': the rollback author scope must never arm below ARCHIVE_BATCH_AUTHOR (' +
                    batchAuthor + '), or a head stamped by the head-side gate loses a reset it is owed');
            }
        });
    });

    describe('against a real SQL engine', function(){
        let db;
        beforeEach(function(){ db = makeDb(); });
        afterEach(function(){ db.close(); });

        // The control. Below the threshold the reset keeps its deployed unscoped shape,
        // and that shape resets BOTH heads: publisher A's stamp is cleared by publisher
        // B's orphaned chunk even though A's own chunk survives the reorg.
        it('unscoped, one publisher\'s orphaned chunk resets the other publisher\'s surviving head', async function(){
            const { headA, headB } = seedTwoPublishers(db);
            const { sql, args } = await captureResetQuery();
            assert.ok(!sql.includes('cadr.address = padr.address'),
                'the deployed reset must carry no author term while the flag day is inert');
            assert.deepStrictEqual(db.resetTargets(sql, args).sort((a, b) => a - b), [headA, headB],
                'the unscoped self-join resets every head carrying the seq, which is the defect');
        });

        it('scoped, the orphaned chunk resets only its own publisher\'s head', async function(){
            const { headA, headB } = seedTwoPublishers(db);
            const { sql, args } = await withRegtestHeight(0, captureResetQuery);
            assert.ok(sql.includes(ARCHIVE_AUTHOR_SCOPE_JOIN_SQL.trim()),
                'the armed reset must splice the shared author-scope joins');
            assert.deepStrictEqual(db.resetTargets(sql, args), [headB],
                'only the head authored by the orphaned chunk\'s publisher may be reset');
            assert.ok(!db.resetTargets(sql, args).includes(headA),
                'a head whose own batch survives the reorg intact must keep its stamp');
        });

        // The property that makes arming safe: on the shape every honest batch has, the
        // author term changes nothing at all.
        it('changes nothing for a single-publisher batch, scoped or not', async function(){
            const { headA } = seedOnePublisher(db);
            const unscoped = await captureResetQuery();
            const scoped   = await withRegtestHeight(0, captureResetQuery);
            assert.deepStrictEqual(db.resetTargets(unscoped.sql, unscoped.args), [headA]);
            assert.deepStrictEqual(db.resetTargets(scoped.sql, scoped.args), [headA],
                'the author term must be a no-op wherever one publisher owns the seq');
        });

        // Inner joins throughout, so an unresolvable author excludes the row rather than
        // waving the reset through unauthenticated.
        it('scoped, a chunk with no resolvable author resets nothing', async function(){
            const validId   = db.status('valid');
            const invalidId = db.status('invalid_archive');
            db.status('unverified');
            const addrA = db.address('addressPublisherA', 11);
            db.anchor({ action_index: 100, version: 1, chain: 'BTC', network: 'regtest',
                        match_batch_seq: BATCH_SEQ, total_chunks: 2, batch_crc32: 'deadbeef',
                        status_id: invalidId, block_index_doge: 10 }, addrA);
            db.anchor({ action_index: 300, version: 2, match_batch_seq: BATCH_SEQ, chunk_index: 1,
                        total_chunks: 2, archive_b64: 'AAAA', status_id: validId, block_index_doge: 30 }, null);
            const { sql, args } = await withRegtestHeight(0, captureResetQuery);
            assert.deepStrictEqual(db.resetTargets(sql, args), [],
                'an orphaned chunk whose action linkage is missing must authenticate nothing');
        });

        // The chunk must still be inside the orphaned range and still be 'valid'; the
        // author term narrows the join, it never widens it.
        it('scoped, a surviving chunk below the orphaned range still resets nothing', async function(){
            const validId   = db.status('valid');
            const invalidId = db.status('invalid_archive');
            db.status('unverified');
            const addrA = db.address('addressPublisherA', 11);
            db.anchor({ action_index: 100, version: 1, chain: 'BTC', network: 'regtest',
                        match_batch_seq: BATCH_SEQ, total_chunks: 2, batch_crc32: 'deadbeef',
                        status_id: invalidId, block_index_doge: 10 }, addrA);
            db.anchor({ action_index: 200, version: 2, match_batch_seq: BATCH_SEQ, chunk_index: 1,
                        total_chunks: 2, archive_b64: 'AAAA', status_id: validId, block_index_doge: 20 }, addrA);
            const { sql, args } = await withRegtestHeight(0, captureResetQuery);
            assert.deepStrictEqual(db.resetTargets(sql, args), [],
                'a chunk that survives the reorg leaves the stamp re-derivable');
        });
    });
});
