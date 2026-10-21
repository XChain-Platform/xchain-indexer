/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

// bin/compare_credit_debit_sum.js runs the JS bcadd fold and the SQL GROUP BY sum
// per (address, tick) and reports keys where they differ. Driven here with a
// stub db whose doQueryStrict answers by table, so no database is touched.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const { getTestConfig } = require('../../fixtures/config');
const Utility = require('../../../src/utility');
const {
    parseArgs, foldInJs, sumInSql, diffMaps, compare, render,
} = require('../../../bin/compare_credit_debit_sum.js');

const util = new Utility(getTestConfig());

/** Rows are {address, tick, amount}; the SQL side is computed with exact BigInt at 18 dp. */
function fakeDb(credits, debits, sqlOverride) {
    const toUnits = (s) => {
        const [i, f = ''] = String(s).split('.');
        return BigInt(i + f.padEnd(18, '0').slice(0, 18));
    };
    const fmt = (n) => {
        const neg = n < 0n; const a = (neg ? -n : n).toString().padStart(19, '0');
        const s = a.slice(0, -18) + '.' + a.slice(-18);
        return (neg ? '-' : '') + s;
    };
    const queries = [];
    return {
        queries,
        async doQueryStrict(sql) {
            queries.push(sql);
            const table = /FROM (credits|debits)/.exec(sql)[1];
            const rows = table === 'credits' ? credits : debits;
            if (!/GROUP BY/.test(sql)) return rows;
            const sums = new Map();
            for (const r of rows) {
                const k = r.address + '\t' + r.tick;
                sums.set(k, (sums.get(k) || { address: r.address, tick: r.tick, t: 0n }));
                sums.get(k).t += toUnits(r.amount);
            }
            const out = [...sums.values()].map(e => ({ address: e.address, tick: e.tick, total: fmt(e.t) }));
            return sqlOverride ? sqlOverride(table, out) : out;
        },
    };
}

describe('bin/compare_credit_debit_sum', function () {
    const credits = [
        { address: 'a1', tick: 'XCHAIN', amount: '1.5' },
        { address: 'a1', tick: 'XCHAIN', amount: '0.00000003' },
        { address: 'a2', tick: 'XCHAIN', amount: '2' },
    ];
    const debits = [
        { address: 'a1', tick: 'XCHAIN', amount: '0.5' },
        { address: 'a3', tick: 'FOO', amount: '4.25' },
    ];

    it('parseArgs reads --db and --json and rejects anything else', function () {
        assert.deepStrictEqual(parseArgs([]), { db: null, json: false });
        assert.deepStrictEqual(parseArgs(['--db', 'x', '--json']), { db: 'x', json: true });
        assert.throws(() => parseArgs(['--db']), /--db needs/);
        assert.throws(() => parseArgs(['--nope']), /unknown argument/);
    });

    it('folds credits and debits per key without exponential notation', async function () {
        const m = await foldInJs(fakeDb(credits, debits), util);
        const a1 = m.get('a1\tXCHAIN');
        assert.strictEqual(a1.credit, '1.50000003');
        assert.strictEqual(a1.debit, '0.5');
        assert.strictEqual(a1.net, '1.00000003');
        assert.strictEqual(m.get('a3\tFOO').net, '-4.25');
    });

    it('reports no difference when the fold and the SQL sum agree', async function () {
        const r = await compare(fakeDb(credits, debits), util);
        assert.strictEqual(r.keys, 3);
        assert.strictEqual(r.differences, 0);
        assert.match(render(r, false), /# keys=3 differences=0$/);
    });

    it('reports a key whose SQL sum drifted, with both values', async function () {
        const db = fakeDb(credits, debits, (table, out) =>
            table === 'credits' ? out.map(o => o.address === 'a2' ? { ...o, total: '2.000000000000000001' } : o) : out);
        const r = await compare(db, util);
        assert.strictEqual(r.differences, 1);
        assert.strictEqual(r.diffs[0].address, 'a2');
        assert.strictEqual(r.diffs[0].jsNet, '2');
        assert.strictEqual(r.diffs[0].sqlNet, '2.000000000000000001');
        assert.match(render(r, false), /^DIFF XCHAIN  a2 /);
        assert.strictEqual(JSON.parse(render(r, true)).differences, 1);
    });

    it('treats a key present on one side only as a difference against zero', function () {
        const js = new Map([['a\tT', { address: 'a', tick: 'T', credit: '1', debit: '0', net: '1' }]]);
        const d = diffMaps(js, new Map());
        assert.strictEqual(d.length, 1);
        assert.strictEqual(d[0].sqlNet, '0');
    });

    it('issues SELECT statements only', async function () {
        const db = fakeDb(credits, debits);
        await compare(db, util);
        assert.ok(db.queries.length >= 4);
        for (const q of db.queries) assert.match(q.trim(), /^SELECT/);
    });
});
