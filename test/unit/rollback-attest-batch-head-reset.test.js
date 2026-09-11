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
 * The reorg reset for an ATTEST v5 batch head an orphaned v6 continuation
 * flipped IN PLACE, driven against REAL attests rows in a real SQL
 * engine.
 *
 * A chunked batch spans blocks. The chunk that completes the coverage stamps the
 * batch's verdict on the HEAD, a row from an earlier block that survives the
 * reorg delete, so a reorg of that chunk leaves the head terminal with nothing on
 * chain to justify it. Worse than stale: getAttestBatchChunks reads status
 * 'valid' only, so the head vanishes from its own chunk set, _canonicalBatchHead
 * resolves nothing on replay, and the window is dead on this node forever.
 *
 * The reset therefore has to restore the head - but only the heads it may. A head
 * that was terminal AT WRITE TIME (a duplicate head for the publisher's window, a
 * foreign NETWORK, a single-chunk head that failed its own quorum) sits in exactly
 * the same join shape, and restoring one revives a head that was never valid. The
 * completion marker is what separates the two, and these cases are here to prove
 * the separation holds in the engine rather than in the comment.
 *
 * The query under test is the one rollback.js actually builds: it is captured from
 * a Rollback run and mechanically turned into the matching SELECT (`UPDATE attests
 * p` -> `SELECT p.action_index FROM attests p`, `SET p.status_id = vs.id`
 * dropped), because sqlite has no multi-table UPDATE. Every JOIN and every WHERE
 * term, which is the whole of what is under test, survives that rewrite untouched
 * and is evaluated by the engine.
 *
 ********************************************************************/
'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'DOGE';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const fs     = require('fs');
const path   = require('path');
const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer } = require('../fixtures/mocks');
const { mysqlDdlToSqlite }  = require('../helpers/sqlAnchorDb');
const Rollback = require('../../src/rollback.js');
const abw      = require('../../src/attest_batch_wire.js');
const { ATTEST_BATCH_COMPLETION_STAMP } = require('../../src/actions/attest.js');

const SQL_DIR = path.join(__dirname, '..', '..', 'src', 'sql');

// The rollback target, and the action index the orphaned range starts at.
const ROLLBACK_BLOCK = 100;
const FIRST_ORPHANED = 250;

// One publisher's window. The key is opaque here: what matters is that head and
// chunk agree on it, which is what makes them one batch.
const BATCH_KEY = 'ab'.repeat(32);
const OTHER_KEY = 'cd'.repeat(32);

// A verdict as _absorbCompletedBatch stamps it, and the same verdict text as a
// head that was already terminal when it was WRITTEN carries it.
const STAMPED   = 'invalid: ATTEST_BATCH (reassembly CRC mismatch)' + ATTEST_BATCH_COMPLETION_STAMP;
const AT_WRITE  = 'invalid: BATCH_KEY (this publisher already has a head for the window)';

// MySQL index names are scoped to their table and sqlite's are database-wide, so
// several real DDL scripts collide on shared names like `action_index`. Prefix
// each index with its table; nothing the joins read is touched.
function qualifyIndexNames(ddl){
    return ddl.replace(/CREATE\s+(UNIQUE\s+)?INDEX\s+(\S+)\s+on\s+(\S+)/gi,
        (m, uniq, name, table) => 'CREATE ' + (uniq || '') + 'INDEX ' + table + '_' + name + ' on ' + table);
}

// attests.sql carries per-column charset/collation decorations sqlite has no grammar
// for. They are dropped here rather than in the shared translator because nothing this
// test joins on is a text column whose collation could matter: the reset matches on
// status text (asserted for its own sake in a case below), ids and integers.
function dropCharsetDecorations(ddl){
    return ddl.replace(/\s+CHARACTER SET [A-Za-z0-9_]+/gi, '')
              .replace(/\s+COLLATE[= ][A-Za-z0-9_]+/gi, '')
              .replace(/\bENUM\s*\([^)]*\)/gi, 'TEXT');
}

// An in-memory engine holding the three tables the reset joins, built from the
// project's own DDL so a column rename in src/sql reaches this test.
function makeDb(){
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    for(const file of ['index_statuses.sql', 'attests.sql', 'actions.sql']){
        db.exec(qualifyIndexNames(mysqlDdlToSqlite(dropCharsetDecorations(
            fs.readFileSync(path.join(SQL_DIR, file), 'utf8')))));
    }
    const api = {
        status(name){
            db.prepare('INSERT OR IGNORE INTO index_statuses (status) VALUES (?)').run(name);
            return db.prepare('SELECT id FROM index_statuses WHERE status = ?').get(name).id;
        },
        // An attests row plus the actions row carrying its authoritative source, or
        // the attests row alone when `sourceId` is null (a broken action linkage).
        attest(row, sourceId){
            const cols = Object.keys(row);
            db.prepare('INSERT INTO attests (' + cols.join(', ') + ') VALUES (' +
                cols.map(() => '?').join(', ') + ')').run(...cols.map(c => row[c]));
            if(sourceId !== null){
                db.prepare('INSERT INTO actions (action_index, block_index, action_id, source_id) VALUES (?, ?, 1, ?)')
                  .run(row.action_index, Number(row.block_index), sourceId);
            }
        },
        // The head action indexes the captured reset UPDATE would have written.
        resetTargets(sql, args){
            const select = sql
                .replace('UPDATE attests p', 'SELECT p.action_index FROM attests p')
                .replace('SET p.status_id = vs.id', '');
            return db.prepare(select).all(...args).map(r => Number(r.action_index)).sort((a, b) => a - b);
        },
        close(){ db.close(); },
    };
    return api;
}

// A v5 head row. `statusId` is what the head currently carries.
function head(db, actionIndex, statusId, sourceId, opts){
    opts = opts || {};
    db.attest({
        action_index:      actionIndex,
        version:           abw.ATTEST_BATCH_HEAD_VERSION,
        provider_id:       '',
        request_id:        opts.key || BATCH_KEY,
        batch_chunk_index: (opts.chunkIndex === undefined ? 0 : opts.chunkIndex),
        batch_total_chunks: 2,
        status_id:         statusId,
        block_index:       10,
    }, sourceId === undefined ? 11 : sourceId);
    return actionIndex;
}

// A v6 continuation row.
function chunk(db, actionIndex, statusId, sourceId, opts){
    opts = opts || {};
    db.attest({
        action_index:      actionIndex,
        version:           abw.ATTEST_BATCH_CONTINUATION_VERSION,
        provider_id:       '',
        request_id:        opts.key || BATCH_KEY,
        batch_chunk_index: (opts.chunkIndex === undefined ? 1 : opts.chunkIndex),
        batch_total_chunks: 2,
        status_id:         statusId,
        block_index:       30,
    }, sourceId === undefined ? 11 : sourceId);
    return actionIndex;
}

// Run a rollback against a mock indexer and hand back the reset UPDATE it issued.
async function captureResetQuery(){
    const indexer = createMockIndexer();
    indexer.indexerDb.doQuery.onFirstCall().resolves([{ action_index: FIRST_ORPHANED }]);
    indexer.indexerDb.doQuery.resolves([]);
    indexer.indexerDb.createStatus = sinon.stub().resolves(1);
    await new Rollback(indexer).rollback(ROLLBACK_BLOCK);
    const call = indexer.indexerDb.doQuery.getCalls().find(c => /UPDATE attests p/.test(c.args[0]));
    assert.ok(call, 'expected the ATTEST batch-head reset UPDATE');
    return { sql: call.args[0], args: call.args[1], indexer };
}

describe('ATTEST v5 batch head: the reorg reset for an orphaned completion stamp @regression', function(){

    afterEach(function(){ sinon.restore(); });

    describe('the query the rollback issues', function(){

        it('runs before the purge, interning valid first so the target JOIN can never be empty', async function(){
            const { indexer } = await captureResetQuery();
            const calls  = indexer.indexerDb.doQuery.getCalls().map(c => String(c.args[0]));
            const reset  = calls.findIndex(q => /UPDATE attests p/.test(q));
            const purge  = calls.findIndex(q => /DELETE FROM attests WHERE action_index >= \?/.test(q));
            assert.ok(reset !== -1 && purge !== -1, 'both the reset and the attests purge must run');
            assert.ok(reset < purge,
                'the reset reads the orphaned chunk, so it has to run while that chunk is still there');
            assert.ok(indexer.indexerDb.createStatus.getCalls().some(c => c.args[0] === 'valid'),
                "'valid' must be interned before the UPDATE resolves its target id through it");
        });

        it('bounds both sides on the lowest rolled-back action and matches only the marked stamp', async function(){
            const { sql, args } = await captureResetQuery();
            assert.deepStrictEqual(args, ['%' + ATTEST_BATCH_COMPLETION_STAMP, FIRST_ORPHANED, FIRST_ORPHANED]);
            assert.match(sql, /c\.action_index >= \?/, 'the orphaned range is tested on the CHUNK row');
            assert.match(sql, /p\.action_index < \?/,  'a head inside the range is deleted, never reset');
            assert.match(sql, /ca\.source_id\s+= pa\.source_id/,
                'a batch is (key, author): a foreign publisher\'s chunk must authenticate nothing');
        });

        // The marker is a SQL LIKE pattern, so a wildcard in it would silently widen the
        // match to heads the reset must never touch.
        it('carries a marker with no LIKE wildcard, byte-identical in both files', function(){
            assert.strictEqual(/[%_]/.test(ATTEST_BATCH_COMPLETION_STAMP), false,
                "the marker is spliced into a LIKE pattern: '%' or '_' in it widens the match");
            const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'rollback.js'), 'utf8');
            const copy   = source.match(/const ATTEST_BATCH_COMPLETION_STAMP = '([^']*)';/);
            assert.ok(copy, 'rollback.js must hold its own copy of the marker');
            assert.strictEqual(copy[1], ATTEST_BATCH_COMPLETION_STAMP,
                'the rollback copy of the marker has drifted from the one attest.js stamps');
        });
    });

    describe('against a real SQL engine', function(){
        let db, validId;
        beforeEach(function(){ db = makeDb(); validId = db.status('valid'); });
        afterEach(function(){ db.close(); });

        it('restores the head an orphaned continuation stamped', async function(){
            const stampedId = db.status(STAMPED);
            const h = head(db, 100, stampedId);
            chunk(db, 300, validId);
            const { sql, args } = await captureResetQuery();
            assert.deepStrictEqual(db.resetTargets(sql, args), [h],
                'the chunk that justified the stamp is gone, so the stamp goes with it');
        });

        // The defect the marker exists to prevent. Same join shape, same publisher, same
        // orphaned chunk: only the marker tells the two heads apart.
        it('never restores a head that was already terminal when it was written', async function(){
            const atWriteId = db.status(AT_WRITE);
            head(db, 100, atWriteId);
            chunk(db, 300, validId);
            const { sql, args } = await captureResetQuery();
            assert.deepStrictEqual(db.resetTargets(sql, args), [],
                'a duplicate/foreign-network head was never valid; reviving it gives one window two heads');
        });

        it('restores the marked head and leaves the write-time one alone in the same reorg', async function(){
            const stampedId = db.status(STAMPED);
            const atWriteId = db.status(AT_WRITE);
            const marked    = head(db, 100, stampedId);
            head(db, 110, atWriteId, 11, { key: OTHER_KEY });
            chunk(db, 300, validId);
            chunk(db, 310, validId, 11, { key: OTHER_KEY });
            const { sql, args } = await captureResetQuery();
            assert.deepStrictEqual(db.resetTargets(sql, args), [marked]);
        });

        it('a second publisher\'s orphaned chunk restores nothing of this publisher\'s batch', async function(){
            const stampedId = db.status(STAMPED);
            head(db, 100, stampedId, 11);
            chunk(db, 300, validId, 22);
            const { sql, args } = await captureResetQuery();
            assert.deepStrictEqual(db.resetTargets(sql, args), [],
                'a foreign chunk is a chunk of its own batch and governs no head but its own');
        });

        it('a chunk with no resolvable author restores nothing', async function(){
            const stampedId = db.status(STAMPED);
            head(db, 100, stampedId, 11);
            chunk(db, 300, validId, null);
            const { sql, args } = await captureResetQuery();
            assert.deepStrictEqual(db.resetTargets(sql, args), [],
                'an unresolvable author fails closed, exactly as _authoredBy does');
        });

        it('a REJECTED orphaned chunk restores nothing', async function(){
            const stampedId = db.status(STAMPED);
            const dupId     = db.status('invalid: CHUNK_INDEX (duplicate)');
            head(db, 100, stampedId);
            chunk(db, 300, dupId);
            const { sql, args } = await captureResetQuery();
            assert.deepStrictEqual(db.resetTargets(sql, args), [],
                'a rejected chunk never joined the reassembly, so it never justified the stamp');
        });

        it('a surviving chunk below the orphaned range restores nothing', async function(){
            const stampedId = db.status(STAMPED);
            head(db, 100, stampedId);
            chunk(db, FIRST_ORPHANED - 1, validId);
            const { sql, args } = await captureResetQuery();
            assert.deepStrictEqual(db.resetTargets(sql, args), [],
                'the batch survives the reorg intact, so the stamp is still re-derivable');
        });

        it('a head inside the orphaned range is left to the purge', async function(){
            const stampedId = db.status(STAMPED);
            head(db, FIRST_ORPHANED + 5, stampedId);
            chunk(db, FIRST_ORPHANED + 9, validId);
            const { sql, args } = await captureResetQuery();
            assert.deepStrictEqual(db.resetTargets(sql, args), [],
                'that head is deleted a moment later; resetting it first is wasted work at best');
        });

        it('a v6 row squatting slot 0 is not a head and is never restored', async function(){
            const stampedId = db.status(STAMPED);
            // Same key, same author, the marker on it - but the continuation version.
            chunk(db, 100, stampedId, 11, { chunkIndex: 0 });
            chunk(db, 300, validId);
            const { sql, args } = await captureResetQuery();
            assert.deepStrictEqual(db.resetTargets(sql, args), [],
                'only the v5 slot-0 row owns the batch verdict');
        });

        it('a chunk of a DIFFERENT batch key restores nothing', async function(){
            const stampedId = db.status(STAMPED);
            head(db, 100, stampedId);
            chunk(db, 300, validId, 11, { key: OTHER_KEY });
            const { sql, args } = await captureResetQuery();
            assert.deepStrictEqual(db.resetTargets(sql, args), []);
        });
    });
});
