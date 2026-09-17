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
const tokenQueries  = require('../../../src/db/tokens/index.js');

function deferred(){
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

function makeHarness({ pauseMaxReads = false } = {}){
    const rows = [{ id: 41, tick: 'SEED', block_index: 900 }];
    const insertAttempts = [];
    const maxSnapshots = [];
    let pendingMaxReads = [];
    let releaseScheduled = false;

    const db = {
        util: { isNull: value => value === null || value === undefined || value === '' },
        transactionConnection: {},
        blockIndex: 901,
        suppressIndexIdCreation: false,
        deterministicIndexingStarted: true,
        _internCache: null,
        assignments: [],

        async doQuery(sql, args = []){
            if(/SELECT id FROM index_tickers WHERE LOWER\(tick\)=\? LIMIT 1/.test(sql)){
                const wanted = String(args[0]).toLowerCase();
                const row = rows.find(item => item.tick.toLowerCase() === wanted);
                return row ? [{ id: row.id }] : [];
            }

            if(/SELECT id FROM index_tickers ORDER BY id DESC LIMIT 1/.test(sql)){
                const snapshot = rows.reduce((max, row) => Math.max(max, row.id), 0);
                maxSnapshots.push(snapshot);
                if(!pauseMaxReads)
                    return snapshot === 0 ? [] : [{ id: snapshot }];

                const wait = deferred();
                pendingMaxReads.push({ snapshot, resolve: wait.resolve });
                if(!releaseScheduled){
                    releaseScheduled = true;
                    setImmediate(() => {
                        const reads = pendingMaxReads;
                        pendingMaxReads = [];
                        releaseScheduled = false;
                        for(const read of reads)
                            read.resolve(read.snapshot === 0 ? [] : [{ id: read.snapshot }]);
                    });
                }
                return await wait.promise;
            }

            if(/INSERT IGNORE INTO index_tickers/.test(sql)){
                const [id, tick, block_index] = args;
                insertAttempts.push({ id, tick, block_index });
                const idTaken = rows.some(row => row.id === id);
                const tickTaken = rows.some(row => row.tick === tick);
                if(!idTaken && !tickTaken)
                    rows.push({ id, tick, block_index });
                return { affectedRows: idTaken || tickTaken ? 0 : 1 };
            }

            throw new Error('Unexpected query: ' + sql);
        },
    };

    Object.assign(db, tickerQueries, tokenQueries);
    db.updateTokenInfo = async tick => {
        const id = await db.createTicker(tick);
        db.assignments.push([tick, id]);
        return id;
    };

    return { db, rows, insertAttempts, maxSnapshots };
}

describe('Database.updateTokens dense ticker id concurrency @unit @regression', function () {
    it('does not let parallel new-ticker updates reserve the same next id', async function () {
        const harness = makeHarness({ pauseMaxReads: true });

        await harness.db.updateTokens(['ALPHA', 'BETA'], false);

        assert.deepStrictEqual(harness.insertAttempts.map(row => [row.tick, row.id]), [
            ['ALPHA', 42],
            ['BETA', 43],
        ], 'each new ticker must reserve a distinct dense id');
        assert.deepStrictEqual(harness.maxSnapshots, [41, 42],
            'the second update must read the maximum after the first ticker is inserted');
        assert.deepStrictEqual(harness.db.assignments, [
            ['ALPHA', 42],
            ['BETA', 43],
        ]);
    });

    it('preserves the existing sequential dense ids in caller order', async function () {
        const harness = makeHarness();
        const alphaDone = deferred();
        const betaDone = deferred();
        const predecessor = {
            ALPHA: Promise.resolve(),
            BETA: alphaDone.promise,
            GAMMA: betaDone.promise,
        };
        const completed = { ALPHA: alphaDone, BETA: betaDone };

        harness.db.updateTokenInfo = async tick => {
            await predecessor[tick];
            const id = await harness.db.createTicker(tick);
            harness.db.assignments.push([tick, id]);
            if(completed[tick])
                completed[tick].resolve();
            return id;
        };

        await harness.db.updateTokens(['ALPHA', 'BETA', 'GAMMA'], false);

        assert.deepStrictEqual(harness.db.assignments, [
            ['ALPHA', 42],
            ['BETA', 43],
            ['GAMMA', 44],
        ]);
        assert.deepStrictEqual(harness.insertAttempts.map(row => [row.tick, row.id]),
            harness.db.assignments);
    });
});
