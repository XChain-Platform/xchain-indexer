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
 **********************************************************************/

// test/unit/db/db.test/reorg_identity.test.js
//
// Covers decoder reorg event identity, cursor persistence, and malformed marker handling.

'use strict';

const { assert, sinon, getTestConfig, Utility, Database } = require('./helpers/db.js');

// ---------------------------------------------------------------------------
// describe: reorg detection by event IDENTITY (not block-height magnitude)
//
// Regression for the consecutive-reorg miss: comparing reorg block heights
// (`lastDecoderReorgBlock < lastIndexerReorgBlock`) silently drops every reorg
// after the first, because block heights increase. Detection must instead match
// the decoder's reorg events.id (identity). These guard the pieces the indexer
// composes: getReorgsSince (every decoder reorg newer than the cursor, id+block),
// createReorg (persists the decoder id), getLastProcessedReorgId (reads it back).
// ---------------------------------------------------------------------------
let db;

function setupDb() {
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    db = {
        config,
        util,
        doQuery: sinon.stub().resolves([]),
        // createReorg writes its marker via doQueryStrict (throw-on-fault) so a swallowed
        // INSERT failure can't leave the processed-reorg cursor un-advanced.
        doQueryStrict: sinon.stub().resolves([]),
        getReorgsSince:         Database.prototype.getReorgsSince,
        getLastProcessedReorgId: Database.prototype.getLastProcessedReorgId,
        createReorg:            Database.prototype.createReorg,
    };
}

describe('Database reorg identity detection @regression @tier1', function () {
    beforeEach(setupDb);
    afterEach(function () {
        sinon.restore();
    });

    it('createReorg persists both block_index and decoder_event_id as JSON', async function () {
        await db.createReorg.call(db, 200, 7);
        // createReorg writes via doQueryStrict (throw-on-fault marker write).
        const args = db.doQueryStrict.firstCall.args[1];
        assert.deepStrictEqual(JSON.parse(args[0]), { block_index: 200, decoder_event_id: 7 });
    });

    it('getLastProcessedReorgId reads back the persisted decoder event id', async function () {
        db.doQueryStrict.resolves([{ data: JSON.stringify({ block_index: 200, decoder_event_id: 7 }) }]);
        assert.strictEqual(await db.getLastProcessedReorgId.call(db), 7);
    });

    it('getLastProcessedReorgId returns null for legacy bare-number rows', async function () {
        db.doQueryStrict.resolves([{ data: '100' }]);
        assert.strictEqual(await db.getLastProcessedReorgId.call(db), null);
    });

    it('getLastProcessedReorgId scans back past a legacy newest row to the newest new-format id (REORG-4)', async function () {
        // Newest marker is legacy (no decoder_event_id); an older marker carries id 7.
        db.doQueryStrict.resolves([
            { data: JSON.stringify({ block_index: 200 }) },
            { data: JSON.stringify({ block_index: 150, decoder_event_id: 7 }) },
            { data: '90' },
        ]);
        assert.strictEqual(await db.getLastProcessedReorgId.call(db), 7,
            'must scan back to the newest new-format marker instead of reporting null (which replays all history)');
    });

    it('getLastProcessedReorgId still returns null when ALL markers are legacy', async function () {
        db.doQueryStrict.resolves([{ data: '200' }, { data: '150' }]);
        assert.strictEqual(await db.getLastProcessedReorgId.call(db), null);
    });

});

describe('Database reorg identity detection @regression @tier1', function () {
    beforeEach(setupDb);
    afterEach(function () {
        sinon.restore();
    });

    it('apiView() routes doQuery AND doQueryStrict through _poolQuery, never getConnection (REORG-1)', async function () {
        const poolCalls = [];
        const stub = Object.assign(Object.create(Database.prototype), {
            poolQuery: (q) => { poolCalls.push(q); return Promise.resolve([]); },
            getConnection: () => { throw new Error('apiView must never call getConnection (would adopt a foreign transaction)'); },
        });
        const view = stub.apiView();
        await view.doQuery('SELECT 1');
        await view.doQueryStrict('SELECT 2');
        assert.strictEqual(poolCalls.length, 2, 'both doQuery and doQueryStrict must run pool-direct');
    });

    it('detects a SECOND, higher-block reorg that a magnitude compare would miss', async function () {
        // Indexer already recorded the first reorg (block 100, decoder event id 5).
        const indexerDb = {
            config: db.config, util: db.util,
            doQueryStrict: sinon.stub().resolves([{ data: JSON.stringify({ block_index: 100, decoder_event_id: 5 }) }]),
            getLastProcessedReorgId: Database.prototype.getLastProcessedReorgId,
        };
        // Decoder now reports a newer reorg at the HIGHER block 200 (event id 6).
        const decoderDb = {
            config: db.config, util: db.util,
            doQueryStrict: sinon.stub().resolves([{ id: 6, data: JSON.stringify([{ block_index: 200, block_hash: 'h200' }]) }]),
            getReorgsSince: Database.prototype.getReorgsSince,
        };
        const lastProcessedReorgId = await indexerDb.getLastProcessedReorgId.call(indexerDb);
        const unprocessedReorgs    = await decoderDb.getReorgsSince.call(decoderDb, lastProcessedReorgId);

        // A magnitude compare (200 < 100 === false) would miss it; selecting by id > cursor
        // (6 > 5) surfaces the new reorg even though its block is higher.
        assert.strictEqual(unprocessedReorgs.length, 1, 'identity cursor selects the new higher-block reorg');
        assert.strictEqual(unprocessedReorgs[0].id, 6);
        assert.strictEqual(unprocessedReorgs[0].block_index, 200);
    });

    it('getReorgsSince returns every reorg after the given id, oldest first, each with its lowest block', async function () {
        db.doQueryStrict.resolves([
            { id: 6, data: JSON.stringify([{ block_index: 200, block_hash: 'h200' }]) },
            { id: 7, data: JSON.stringify([{ block_index: 150, block_hash: 'h150' }, { block_index: 152, block_hash: 'h152' }]) },
        ]);
        const result = await db.getReorgsSince.call(db, 5);
        assert.deepStrictEqual(result, [
            { id: 6, block_index: 200 },
            { id: 7, block_index: 150 },
        ]);
        // The main select must filter by id > afterId, not return only the latest. (The reorg witness adds a
        // preceding witness-the-cursor query, so locate the id>? select rather than assuming order.)
        const boundedCall = db.doQueryStrict.getCalls().find(c => /id > \?/.test(c.args[0]));
        assert.ok(boundedCall, 'expected an id > ? select');
        assert.deepStrictEqual(boundedCall.args[1], [5]);
    });

});

describe('Database reorg identity detection @regression @tier1', function () {
    beforeEach(setupDb);
    afterEach(function () {
        sinon.restore();
    });

    it('getReorgsSince(null) returns all reorg events (no afterId filter)', async function () {
        db.doQueryStrict.resolves([{ id: 1, data: JSON.stringify([{ block_index: 10, block_hash: 'h10' }]) }]);
        const result = await db.getReorgsSince.call(db, null);
        assert.deepStrictEqual(result, [{ id: 1, block_index: 10 }]);
        assert.doesNotMatch(db.doQueryStrict.firstCall.args[0], /id > \?/);
    });

    it('skips a malformed leading element without poisoning the batch target', async function () {
        // A leading element that is an object with no numeric block_index unwraps to
        // `undefined`; it must be skipped (not seed the target as `undefined`, which
        // would slip past the null guard and drop later valid elements / the whole event).
        db.doQueryStrict.resolves([
            { id: 6, data: JSON.stringify([{ block_hash: 'hbad' }, { block_index: 150, block_hash: 'h150' }]) },
            { id: 7, data: JSON.stringify([{ block_hash: 'honly' }]) },
        ]);
        const result = await db.getReorgsSince.call(db, 5);
        // Event 6 recovers to its one valid element; event 7 is all-malformed and is dropped.
        assert.deepStrictEqual(result, [{ id: 6, block_index: 150 }]);
    });

    it('exposes the DEEPEST block across two unprocessed reorgs when the newer one is shallower', async function () {
        // The bug a single-newest-event reader caused: it surfaces only event 7 (block 200);
        // rolling back to 200 leaves orphaned rows from event 6's deeper reorg at block 100.
        // getReorgsSince surfaces both so the caller can roll back to the minimum (deepest) block.
        db.doQueryStrict.resolves([
            { id: 6, data: JSON.stringify([{ block_index: 100, block_hash: 'h100' }]) },
            { id: 7, data: JSON.stringify([{ block_index: 200, block_hash: 'h200' }]) },
        ]);
        const reorgs = await db.getReorgsSince.call(db, 5);
        const minBlock = reorgs.reduce((m, r) => (m === null || r.block_index < m ? r.block_index : m), null);
        assert.strictEqual(minBlock, 100, 'deepest block across all unprocessed reorgs');
        const maxId = reorgs.reduce((m, r) => Math.max(m, r.id), 0);
        assert.strictEqual(maxId, 7, 'cursor advances to the newest decoder event id');
    });

});

// ── Guarded / malformed payload handling (hardening: skip, never null-index) ──

describe('Database reorg identity detection @regression @tier1', function () {
    beforeEach(setupDb);
    afterEach(function () {
        sinon.restore();
    });

    it('getReorgsSince skips a row whose data is non-JSON garbage instead of throwing', async function () {
        db.doQueryStrict.resolves([
            { id: 6, data: 'not-json{' },
            { id: 7, data: JSON.stringify([{ block_index: 150, block_hash: 'h150' }]) },
        ]);
        const result = await db.getReorgsSince.call(db, 5);
        // The garbage row must be dropped, not turned into { id: 6, block_index: null }.
        assert.deepStrictEqual(result, [{ id: 7, block_index: 150 }]);
        assert.ok(result.every(r => r.block_index !== null), 'no entry may carry a null block_index');
    });

    it('getReorgsSince skips a row whose payload yields no numeric block_index', async function () {
        db.doQueryStrict.resolves([
            { id: 6, data: JSON.stringify([]) },                    // empty array: no block found
            { id: 7, data: JSON.stringify([{ block_index: 150 }]) },
        ]);
        const result = await db.getReorgsSince.call(db, 5);
        assert.deepStrictEqual(result, [{ id: 7, block_index: 150 }]);
        assert.ok(result.every(r => r.block_index !== null), 'no entry may carry a null block_index');
    });

    it('getReorgsSince skips a row whose data parses to null', async function () {
        db.doQueryStrict.resolves([
            { id: 6, data: 'null' },
            { id: 7, data: JSON.stringify([{ block_index: 150 }]) },
        ]);
        const result = await db.getReorgsSince.call(db, 5);
        assert.deepStrictEqual(result, [{ id: 7, block_index: 150 }]);
    });

    // The skip is deliberate (above), but it must not be SILENT: getLastProcessedReorgId can
    // later advance the cursor past a dropped id via a newer well-formed marker, permanently
    // missing that rollback. The drop must page the operator with a LOUD error naming the id.
    it('getReorgsSince logs a LOUD error when it drops a malformed row, never silently', async function () {
        const errSpy = sinon.stub(console, 'error');
        db.doQueryStrict.resolves([
            { id: 6, data: 'not-json{' },
            { id: 7, data: JSON.stringify([{ block_index: 150, block_hash: 'h150' }]) },
        ]);
        const result = await db.getReorgsSince.call(db, 5);
        assert.deepStrictEqual(result, [{ id: 7, block_index: 150 }]);
        assert.ok(errSpy.calledWithMatch(/DROPPING malformed REORG event id=6/),
            'a dropped malformed REORG row must be logged LOUD, not skipped silently');
    });
});
