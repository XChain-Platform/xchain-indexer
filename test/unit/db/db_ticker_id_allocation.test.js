'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');

const tickerQueries = require('../../../src/db/index_tables/tickers.js');

const FANOUT = 16;
const SEED_ID = 41;

function barrier(parties){
    let arrivals = 0;
    let release;
    const ready = new Promise(resolve => { release = resolve; });
    return async function arrive(){
        arrivals++;
        if(arrivals === parties)
            release();
        await ready;
    };
}

function mutex(){
    let tail = Promise.resolve();
    return async function acquire(){
        let release;
        const predecessor = tail;
        tail = new Promise(resolve => { release = resolve; });
        await predecessor;
        return release;
    };
}

async function findTicker(args, context, clientState){
    const wanted = String(args[0]).toLowerCase();
    const row = context.rows.find(item => item.tick.toLowerCase() === wanted);
    if(!row && !clientState.initialLookupDone){
        clientState.initialLookupDone = true;
        await context.initialLookupBarrier();
    }
    return row ? [{ id: row.id }] : [];
}

async function readLatestTickerId(sql, context, clientState){
    const locking = /FOR UPDATE\s*$/i.test(sql);
    if(locking)
        clientState.releaseAllocationLock = await context.acquireAllocationLock();
    const snapshot = context.rows.reduce((max, row) => Math.max(max, row.id), 0);
    context.allocationReads.push({ processId: clientState.processId, snapshot, locking });
    if(!locking)
        await context.unlockedReadBarrier();
    return snapshot === 0 ? [] : [{ id: snapshot }];
}

function insertTicker(args, context, clientState){
    const [id, tick, block_index] = args;
    context.attempts.push({ processId: clientState.processId, id, tick, block_index });
    const duplicate = context.rows.some(row => row.id === id || row.tick === tick);
    if(!duplicate)
        context.rows.push({ id, tick, block_index });
    return { affectedRows: duplicate ? 0 : 1 };
}

function queryHandler(context, clientState){
    return async function doQuery(sql, args = []){
        if(/SELECT id FROM index_tickers WHERE LOWER\(tick\)=\? ORDER BY id ASC LIMIT 1/.test(sql))
            return await findTicker(args, context, clientState);
        if(/SELECT id FROM index_tickers ORDER BY id DESC LIMIT 1/.test(sql))
            return await readLatestTickerId(sql, context, clientState);
        if(/INSERT IGNORE INTO index_tickers/.test(sql))
            return insertTicker(args, context, clientState);
        throw new Error('Unexpected query: ' + sql);
    };
}

function transactionClient(processId, context, methods){
    const tick = 'TICK_' + String(processId).padStart(2, '0');
    const clientState = {
        processId,
        initialLookupDone: false,
        releaseAllocationLock: null,
    };
    const db = {
        util: { isNull: value => value === null || value === undefined || value === '' },
        transactionConnection: { processId },
        blockIndex: 901,
        suppressIndexIdCreation: false,
        deterministicIndexingStarted: true,
        _internCache: null,
        doQuery: queryHandler(context, clientState),
    };
    Object.assign(db, methods);

    return {
        async allocate(){
            try {
                return await db.createTicker(tick);
            } finally {
                if(clientState.releaseAllocationLock)
                    clientState.releaseAllocationLock();
            }
        },
    };
}

function harnessContext(){
    return {
        rows: [{ id: SEED_ID, tick: 'SEED', block_index: 900 }],
        attempts: [],
        allocationReads: [],
        initialLookupBarrier: barrier(FANOUT),
        unlockedReadBarrier: barrier(FANOUT),
        acquireAllocationLock: mutex(),
    };
}

// Models independent indexer transactions sharing one seeded index_tickers table.
// Each client has its own transactionConnection, while the locking read is arbitrated
// by the shared server. The initial name-lookup barrier forces every client to observe
// its ticker as missing before any client starts the dense-id allocation read.
function seededConcurrencyHarness(methods = tickerQueries){
    const context = harnessContext();
    const clients = Array.from(
        { length: FANOUT },
        (_, processId) => transactionClient(processId, context, methods));

    return {
        rows: context.rows,
        attempts: context.attempts,
        allocationReads: context.allocationReads,
        async run(){
            return await Promise.all(clients.map(client => client.allocate()));
        },
    };
}

describe('Database ticker id allocation concurrency @unit @regression', function () {
    it('serializes seeded parallel allocations across independent transactions', async function () {
        const harness = seededConcurrencyHarness();
        const ids = await harness.run();

        assert.strictEqual(harness.allocationReads.length, FANOUT);
        assert.ok(harness.allocationReads.every(read => read.locking),
            'every maximum-id read must lock at the database transaction level');
        assert.deepStrictEqual(
            harness.allocationReads.map(read => read.snapshot).sort((a, b) => a - b),
            Array.from({ length: FANOUT }, (_, i) => SEED_ID + i),
            'each waiter must observe the predecessor allocation after acquiring the lock');
        assert.deepStrictEqual(
            ids.slice().sort((a, b) => a - b),
            Array.from({ length: FANOUT }, (_, i) => SEED_ID + i + 1),
            'parallel clients must receive distinct dense ids');
        assert.strictEqual(new Set(harness.attempts.map(row => row.id)).size, FANOUT);
        assert.strictEqual(harness.rows.length, FANOUT + 1);
    });

    it('falsification control reproduces the collision without the locking read', async function () {
        const legacyMethods = {
            ...tickerQueries,
            async getNextTickerId(){
                const results = await this.doQuery(
                    'SELECT id FROM index_tickers ORDER BY id DESC LIMIT 1');
                return (results.length > 0 ? Number(results[0].id) : 0) + 1;
            },
        };
        const harness = seededConcurrencyHarness(legacyMethods);
        const ids = await harness.run();

        assert.ok(harness.allocationReads.every(read => !read.locking));
        assert.deepStrictEqual(
            [...new Set(harness.attempts.map(row => row.id))],
            [SEED_ID + 1],
            'the unlocked fan-out must compute the same successor id in every transaction');
        assert.strictEqual(ids.filter(id => id === null).length, FANOUT - 1,
            'all but one distinct ticker lose their colliding INSERT IGNORE allocation');
        assert.strictEqual(harness.rows.length, 2,
            'the seed and only one fan-out ticker survive the unlocked collision');
    });
});
