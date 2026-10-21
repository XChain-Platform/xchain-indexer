/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

// bin/bench_net_balance.js times getNetBalance per hot key and, under --batched,
// the grouped getNetBalances over the same keys. Driven here with an injected
// clock and a stub db whose doQueryStrict answers by SQL substring.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const { getTestConfig } = require('../../fixtures/config');
const Utility = require('../../../src/utility');
const { parseArgs, timeBatch, bench, render } = require('../../../bin/bench_net_balance.js');

const util = new Utility(getTestConfig());

const HOT = [
    { address: 'a1', tick: 'XCHAIN', rows: 9 },
    { address: 'a2', tick: 'XCHAIN', rows: 5 },
    { address: 'a3', tick: 'PEPE',   rows: 2 },
];
const NETS = { 'a1\tXCHAIN': '10', 'a2\tXCHAIN': '2.5', 'a3\tPEPE': '0' };

function stubDb(batchedOverride) {
    const queries = [];
    return {
        util,
        queries,
        batched() { return queries.filter(q => /SELECT 0 AS i/.test(q)); },
        async doQueryStrict(sql, params) {
            queries.push(sql);
            if (/LIMIT \d+/.test(sql)) return HOT.map(h => ({ address: h.address, tick: h.tick, rows: h.rows }));
            if (/SELECT 0 AS i/.test(sql)) {
                const rows = [];
                for (let i = 0; i < params.length / 2; i++) {
                    const id = params[2 * i] + '\t' + params[2 * i + 1];
                    let net = NETS[id];
                    if (batchedOverride && batchedOverride[id] !== undefined) net = batchedOverride[id];
                    rows.push({ i, cr: net, dr: '0' });
                }
                return rows;
            }
            const net = NETS[params[0] + '\t' + params[1]];
            return [{ cr: net, dr: '0' }];
        },
    };
}

// A clock that advances by the next value in `steps` on each call.
function stepClock(steps) {
    let t = 0, i = 0;
    return () => { t += steps[i++ % steps.length]; return t; };
}

describe('bin/bench_net_balance', function () {
    it('parses --batched to true and its absence to false', function () {
        assert.strictEqual(parseArgs(['--batched']).batched, true);
        assert.strictEqual(parseArgs([]).batched, false);
    });

    it('issues no batched query and returns no batch without --batched', async function () {
        const db = stubDb();
        const res = await bench(db, parseArgs(['--keys', '3', '--repeat', '2']), stepClock([1]));
        assert.strictEqual(db.batched().length, 0);
        assert.strictEqual(res.batch, undefined);
        assert.strictEqual(res.timings.length, 3);
    });

    it('times getNetBalances over the same keys under --batched', async function () {
        const db = stubDb();
        // per-key phase: 3 keys x 2 repeats x 2 clock calls = 12 calls of 1 tick.
        // batch phase: read 1 takes 8, read 2 takes 4.
        const steps = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 8, 0, 4];
        let t = 0, i = 0;
        const clock = () => { t += steps[i++]; return t; };
        const res = await bench(db, parseArgs(['--keys', '3', '--repeat', '2', '--batched']), clock);
        assert.strictEqual(db.batched().length, 2);
        assert.deepStrictEqual(res.batch, { keys: 3, coldMs: 8, ms: 4, perKeyMs: 4 / 3, mismatches: 0 });
    });

    it('reports a mismatch when the batched net differs for a key', async function () {
        const db = stubDb({ 'a2\tXCHAIN': '2.6' });
        const timings = [];
        for (const h of HOT) timings.push({ address: h.address, tick: h.tick, rows: h.rows, net: NETS[h.address + '\t' + h.tick] });
        const batch = await timeBatch(db, timings, 2, stepClock([1]));
        assert.strictEqual(batch.mismatches, 1);
    });

    it('returns zeros for no keys', async function () {
        const batch = await timeBatch(stubDb(), [], 2, stepClock([1]));
        assert.strictEqual(batch.keys, 0);
        assert.strictEqual(batch.perKeyMs, 0);
        assert.strictEqual(batch.mismatches, 0);
    });

    it('render prints the batch line only when a batch is present', function () {
        const base = { keys: 1, repeat: 2, timings: [], summary: { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 } };
        assert.ok(!/# batch/.test(render(base, false)));
        const out = render(Object.assign({}, base, {
            batch: { keys: 3, coldMs: 8, ms: 4, perKeyMs: 4 / 3, mismatches: 1 },
        }), false);
        assert.ok(out.split('\n').includes('# batch keys=3 repeat=2 cold=8.00ms best=4.00ms per-key=1.33ms mismatches=1'));
        assert.strictEqual(JSON.parse(render(Object.assign({}, base, { batch: { keys: 3 } }), true)).batch.keys, 3);
    });
});
