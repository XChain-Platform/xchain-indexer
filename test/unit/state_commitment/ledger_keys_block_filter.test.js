// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// ledgerKeysForBlock filters each credits/debits branch by block INSIDE the UNION ALL,
// so the read touches only the block's own ledger rows. A block filter outside the
// derived table cannot be pushed into it and reads the whole ledger history per call.

'use strict';

const assert = require('assert');
const BalanceBench = require('../../../scripts/bench_net_balance.js');
const {
    getHottestLedgerKeys,
    ledgerKeysForBlock,
} = require('../../../src/db/state_commitment/ledger_reads.js');

// Capture the one strict read and answer it with the given rows.
function captureDb(rows) {
    const seen = [];
    return {
        seen,
        doQueryStrict: async (sql, params) => { seen.push({ sql, params }); return rows; },
    };
}

describe('ledgerKeysForBlock per-branch block filter @regression @tier1', function () {
    it('filters both the credits and the debits branch by block inside the derived table', async function () {
        const db = captureDb([]);
        await ledgerKeysForBlock(db, 812);
        assert.strictEqual(db.seen.length, 1);
        const { sql, params } = db.seen[0];
        const derived = sql.slice(sql.indexOf('FROM ('), sql.indexOf(') s'));
        const branches = derived.split('UNION ALL');
        assert.strictEqual(branches.length, 2, 'one credits branch and one debits branch');
        assert.ok(/FROM credits[\s\S]*WHERE a\.block_index = \?/.test(branches[0]), 'credits branch is block-filtered');
        assert.ok(/FROM debits[\s\S]*WHERE a\.block_index = \?/.test(branches[1]), 'debits branch is block-filtered');
        assert.ok(!/block_index/.test(sql.slice(sql.indexOf(') s'))), 'no block filter outside the derived table');
        assert.deepStrictEqual(params, [812, 812]);
    });

    it('returns the distinct non-empty keys as address<TAB>tick', async function () {
        const db = captureDb([{ address: 'a1', tick: 'T' }, { address: 'a2', tick: '' }, { address: null, tick: 'T' }]);
        const keys = await ledgerKeysForBlock(db, 9);
        assert.deepStrictEqual([...keys], ['a1\tT']);
    });
});

describe('getNetBalance benchmark', function(){
    it('parses defaults and validates positive integer options', function(){
        assert.deepStrictEqual(BalanceBench.parseArgs([]),
            { keys: 20, repeat: 3, db: null, json: false });
        assert.deepStrictEqual(BalanceBench.parseArgs(
            ['--keys', '7', '--repeat', '4', '--db', 'venue', '--json']),
            { keys: 7, repeat: 4, db: 'venue', json: true });
        assert.throws(() => BalanceBench.parseArgs(['--keys', '0']), /positive integer/);
        assert.throws(() => BalanceBench.parseArgs(['--repeat']), /positive integer/);
        assert.throws(() => BalanceBench.parseArgs(['--db']), /database name/);
        assert.throws(() => BalanceBench.parseArgs(['--wat']), /unknown argument/);
    });

    it('uses nearest-rank percentiles and renders the measured summary', function(){
        assert.strictEqual(BalanceBench.percentile([9, 1, 5, 3], 50), 3);
        assert.strictEqual(BalanceBench.percentile([9, 1, 5, 3], 95), 9);
        assert.deepStrictEqual(BalanceBench.summarize([{ ms: 4 }, { ms: 6 }]),
            { count: 2, totalMs: 10, p50Ms: 4, p95Ms: 6, maxMs: 6 });
        const text = BalanceBench.render({
            repeat: 2,
            timings: [{ address: 'addr', tick: 'TICK', rows: 11, coldMs: 9, ms: 4 }],
            summary: { count: 1, totalMs: 4, p50Ms: 4, p95Ms: 4, maxMs: 4 }
        }, false);
        assert.match(text, /11\s+9\.00\s+4\.00\s+TICK\s+addr/);
        assert.match(text, /keys=1 repeat=2 p50=4\.00ms p95=4\.00ms max=4\.00ms/);
    });

    it('selects hottest ledger keys with one strict read-only query', async function(){
        const calls = [];
        const db = { doQueryStrict: async (sql, params) => {
            calls.push({ sql, params });
            return [{ address: 'b', tick: 'TWO', rows: '12' },
                    { address: 'a', tick: 'ONE', rows: '8' }];
        } };
        assert.deepStrictEqual(await getHottestLedgerKeys(db, 2), [
            { address: 'b', tick: 'TWO', rows: 12 },
            { address: 'a', tick: 'ONE', rows: 8 }
        ]);
        assert.strictEqual(calls.length, 1);
        assert.match(calls[0].sql, /^SELECT /);
        assert.match(calls[0].sql, /ORDER BY `rows` DESC, a\.address, t\.tick/);
        assert.match(calls[0].sql, /LIMIT 2$/);
        assert.deepStrictEqual(calls[0].params, []);
    });

    it('times repeated getNetBalance reads and keeps cold and best durations', async function(){
        const clock = [0, 9, 10, 14, 20, 27, 30, 36];
        const calls = [];
        const db = {
            util: {
                bcsub: (left, right) => Number(left) - Number(right),
                bcstr: String
            },
            doQueryStrict: async (sql, params) => {
                calls.push({ sql, params });
                if(/SUM\(s\.n\)/.test(sql))
                    return [{ address: 'a', tick: 'ONE', rows: '12' },
                            { address: 'b', tick: 'TWO', rows: '8' }];
                return params[0] === 'a' ? [{ cr: '8', dr: '3' }] : [{ cr: '4', dr: '6' }];
            }
        };
        const result = await BalanceBench.bench(db, { keys: 2, repeat: 2 }, () => clock.shift());
        assert.deepStrictEqual(result, {
            keys: 2,
            repeat: 2,
            timings: [
                { address: 'a', tick: 'ONE', rows: 12, net: '5', coldMs: 9, ms: 4 },
                { address: 'b', tick: 'TWO', rows: 8, net: '-2', coldMs: 7, ms: 6 }
            ],
            summary: { count: 2, totalMs: 10, p50Ms: 4, p95Ms: 6, maxMs: 6 }
        });
        assert.strictEqual(calls.length, 5);
        assert.ok(calls.every(call => /^\s*SELECT\b/.test(call.sql)));
        assert.strictEqual(clock.length, 0);
    });
});
