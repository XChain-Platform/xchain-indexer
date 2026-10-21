/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

// bin/bench_net_balance.js times getNetBalance per hot key and can time grouped
// reads for those keys or for each recent block's touched keys. Driven here with
// an injected clock and a stub db whose doQueryStrict answers by SQL substring.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const { spawnSync } = require('child_process');

const { getTestConfig } = require('../../fixtures/config');
const Utility = require('../../../src/utility');
const {
    parseArgs,
    recentLedgerBlocksQuery,
    timeBatch,
    timeBlocks,
    bench,
    render,
    exitCodeFor
} = require('../../../bin/bench_net_balance.js');

const util = new Utility(getTestConfig());

const HOT = [
    { address: 'a1', tick: 'XCHAIN', rows: 9 },
    { address: 'a2', tick: 'XCHAIN', rows: 5 },
    { address: 'a3', tick: 'PEPE',   rows: 2 },
];
const NETS = { 'a1\tXCHAIN': '10', 'a2\tXCHAIN': '2.5', 'a3\tPEPE': '0' };

function stubDb(batchedOverride, recentBlocks, blockKeys) {
    const queries = [];
    return {
        util,
        queries,
        batched() { return queries.filter(q => /SELECT 0 AS i/.test(q.sql)); },
        recentBlocks() { return queries.filter(q => /SELECT DISTINCT s\.block_index/.test(q.sql)); },
        blockKeyReads() { return queries.filter(q => /WHERE a\.block_index = \?/.test(q.sql)); },
        async doQueryStrict(sql, params) {
            queries.push({ sql, params });
            if (/SELECT DISTINCT s\.block_index/.test(sql))
                return (recentBlocks || []).map(block_index => ({ block_index }));
            if (/WHERE a\.block_index = \?/.test(sql))
                return ((blockKeys && blockKeys[Number(params[0])]) || [])
                    .map(([address, tick]) => ({ address, tick }));
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

    it('parses --blocks through the positive integer check and defaults it off', function () {
        assert.strictEqual(parseArgs(['--blocks', '5']).blocks, 5);
        assert.strictEqual(parseArgs([]).blocks, 0);
        assert.throws(() => parseArgs(['--blocks', '0']), /needs a positive integer/);
        assert.throws(() => parseArgs(['--blocks', 'x']), /needs a positive integer/);
        const query = recentLedgerBlocksQuery(7);
        assert.deepStrictEqual(query.args, [7]);
        assert.match(query.sql, /^SELECT DISTINCT/);
        assert.match(query.sql, /FROM credits c/);
        assert.match(query.sql, /FROM debits d/);
        assert.strictEqual((query.sql.match(/INNER JOIN actions/g) || []).length, 2);
        assert.match(query.sql, /ORDER BY s\.block_index DESC\s+LIMIT \?$/);
    });

    it('issues no optional queries and returns no optional results without their flags', async function () {
        const db = stubDb();
        const res = await bench(db, parseArgs(['--keys', '3', '--repeat', '2']), stepClock([1]));
        assert.strictEqual(db.batched().length, 0);
        assert.strictEqual(db.recentBlocks().length, 0);
        assert.strictEqual(db.blockKeyReads().length, 0);
        assert.strictEqual(res.batch, undefined);
        assert.strictEqual(res.perBlock, undefined);
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

    it('returns the mismatch exit status for batched bench results', async function () {
        const db = stubDb({ 'a2\tXCHAIN': '2.6' });
        const result = await bench(db, parseArgs(['--keys', '3', '--repeat', '1', '--batched']), stepClock([1]));
        assert.strictEqual(exitCodeFor(result), 1);
    });

    it('maps only batched mismatches to exit status 1', function () {
        assert.strictEqual(exitCodeFor({ batch: { mismatches: 1 } }), 1);
        assert.strictEqual(exitCodeFor({ batch: { mismatches: 0 } }), 0);
        assert.strictEqual(exitCodeFor({}), 0);
    });

    it('exits 2 with its error line on a usage error', function () {
        const script = require.resolve('../../../bin/bench_net_balance.js');
        const child = spawnSync(process.execPath, [script, '--keys', '0'], {
            cwd: __dirname,
            encoding: 'utf8',
        });
        assert.strictEqual(child.status, 2);
        assert.match(child.stderr, /bench_net_balance: --keys needs a positive integer, got "0"/);
    });

    it('returns zeros for no keys', async function () {
        const batch = await timeBatch(stubDb(), [], 2, stepClock([1]));
        assert.strictEqual(batch.keys, 0);
        assert.strictEqual(batch.perKeyMs, 0);
        assert.strictEqual(batch.mismatches, 0);
    });

    it('times each recent block over its touched keys', async function () {
        const db = stubDb(null, ['12', 9], {
            12: [['a1', 'XCHAIN'], ['a2', 'XCHAIN'], ['a3', 'PEPE']],
            9: [['a2', 'XCHAIN']],
        });
        const hotKeySteps = new Array(12).fill(1);
        const blockSteps = [0, 3, 0, 7, 0, 4, 0, 2, 0, 6, 0, 5];
        const result = await bench(
            db,
            parseArgs(['--keys', '3', '--repeat', '2', '--blocks', '2']),
            stepClock(hotKeySteps.concat(blockSteps))
        );

        assert.strictEqual(db.recentBlocks().length, 1);
        assert.deepStrictEqual(db.recentBlocks()[0].params, [2]);
        assert.deepStrictEqual(db.blockKeyReads().map(q => q.params), [[12, 12], [9, 9]]);
        assert.strictEqual(db.batched().length, 4);
        assert.deepStrictEqual(db.batched().map(q => q.params), [
            ['a1', 'XCHAIN', 'a2', 'XCHAIN', 'a3', 'PEPE'],
            ['a1', 'XCHAIN', 'a2', 'XCHAIN', 'a3', 'PEPE'],
            ['a2', 'XCHAIN'],
            ['a2', 'XCHAIN'],
        ]);
        assert.deepStrictEqual(result.perBlock, {
            blocks: [
                { block: 12, keys: 3, keysMs: 3, coldMs: 7, ms: 4 },
                { block: 9, keys: 1, keysMs: 2, coldMs: 6, ms: 5 },
            ],
            summary: { count: 2, maxKeys: 3, p50Ms: 4, p95Ms: 5, maxMs: 5 },
        });
    });

    it('returns a zero per-block summary when the recent-block query is empty', async function () {
        const perBlock = await timeBlocks(stubDb(), 4, 2, stepClock([1]));
        assert.deepStrictEqual(perBlock, {
            blocks: [],
            summary: { count: 0, maxKeys: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
        });
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

    it('render prints per-block detail and summary lines only when present', function () {
        const base = { keys: 1, repeat: 2, timings: [], summary: { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 } };
        assert.ok(!/# block/.test(render(base, false)));
        const perBlock = {
            blocks: [{ block: 12, keys: 3, keysMs: 3, coldMs: 7, ms: 4 }],
            summary: { count: 1, maxKeys: 3, p50Ms: 4, p95Ms: 4, maxMs: 4 },
        };
        const out = render(Object.assign({}, base, { perBlock }), false).split('\n');
        assert.ok(out.includes('# block 12 keys=3 keys-read=3.00ms cold=7.00ms best=4.00ms'));
        assert.ok(out.includes('# per-block blocks=1 max-keys=3 p50=4.00ms p95=4.00ms max=4.00ms'));
        assert.deepStrictEqual(JSON.parse(render(Object.assign({}, base, { perBlock }), true)).perBlock, perBlock);
    });
});
