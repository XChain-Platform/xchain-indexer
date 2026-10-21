/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

// bin/count_u64_above_2p53.js lists the BIGINT columns and counts the rows above
// 2^53 per column. Driven here with a stub db whose doQueryStrict answers the
// column list and each per-column count, so no database is touched.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const {
    parseArgs, bigintColumnsSql, columnCountSql, scan, render,
} = require('../../../bin/count_u64_above_2p53.js');

const BT = String.fromCharCode(96);

function fakeDb(columns, counts) {
    const queries = [];
    return {
        dbName: 'indexer_test',
        queries,
        async doQueryStrict(sql) {
            queries.push(sql);
            if (/information_schema/i.test(sql)) return columns;
            const m = /FROM `([A-Za-z0-9_]+)`/.exec(sql);
            const c = /CAST\(MAX\(`([A-Za-z0-9_]+)`\)/.exec(sql);
            return [counts[m[1] + '.' + c[1]]];
        },
    };
}

describe('bin/count_u64_above_2p53', function () {
    const columns = [
        { table_name: 'orders', column_name: 'expiration' },
        { table_name: 'blocks', column_name: 'block_index' },
    ];
    const counts = {
        'orders.expiration':  { above: '0', max_value: '1200' },
        'blocks.block_index': { above: '2', max_value: '18446744073709551615' },
    };
    const wire = { EXPIRATION: '18446744073709551615' };

    it('parseArgs reads --db and --json and rejects anything else', function () {
        assert.deepStrictEqual(parseArgs([]), { db: null, json: false });
        assert.deepStrictEqual(parseArgs(['--db', 'x', '--json']), { db: 'x', json: true });
        assert.throws(() => parseArgs(['--db']), /--db needs/);
        assert.throws(() => parseArgs(['--nope']), /unknown argument/);
    });

    it('lists the BIGINT columns from information_schema.COLUMNS', function () {
        const sql = bigintColumnsSql();
        assert.ok(/information_schema[.]COLUMNS/i.test(sql));
        assert.ok(/DATA_TYPE\s*=\s*'bigint'/i.test(sql));
        assert.ok(/TABLE_SCHEMA\s*=\s*DATABASE\(\)/i.test(sql));
    });

    it('counts above 2^53 and reads the maximum as CAST(MAX(col) AS CHAR)', function () {
        const sql = columnCountSql('orders', 'expiration');
        assert.ok(sql.includes('9007199254740991'));
        assert.ok(sql.includes('CAST(MAX(' + BT + 'expiration' + BT + ') AS CHAR)'));
        assert.ok(sql.includes('FROM ' + BT + 'orders' + BT));
        assert.ok(/^\s*SELECT\b/i.test(sql));
    });

    it('columnCountSql throws on a name holding a back-quote or a space', function () {
        assert.throws(() => columnCountSql('orders', 'a' + BT + 'b'), /unsafe identifier/);
        assert.throws(() => columnCountSql('orders', 'a b'), /unsafe identifier/);
        assert.throws(() => columnCountSql('or ders', 'a'), /unsafe identifier/);
    });

    it('scan keeps a wire column at zero and a non-wire column at two with the exact maximum', async function () {
        const db = fakeDb(columns, counts);
        const r = await scan(db, wire);
        assert.strictEqual(r.database, 'indexer_test');
        assert.strictEqual(r.scanned, 2);
        assert.strictEqual(r.wire, 1);
        assert.strictEqual(r.above, 1);
        const exp = r.columns.find(c => c.column === 'expiration');
        assert.deepStrictEqual(exp, { table: 'orders', column: 'expiration', wire: true, count: 0, max: '1200' });
        const idx = r.columns.find(c => c.column === 'block_index');
        assert.strictEqual(idx.wire, false);
        assert.strictEqual(idx.count, 2);
        assert.strictEqual(idx.max, '18446744073709551615');
        assert.strictEqual(typeof idx.max, 'string');
    });

    it('scan issues SELECT statements only', async function () {
        const db = fakeDb(columns, counts);
        await scan(db, wire);
        assert.strictEqual(db.queries.length, 3);
        for (const q of db.queries) assert.ok(/^\s*SELECT\b/i.test(q), q);
    });

    it('the exit verdict is 1 only when a count is non-zero', async function () {
        const verdict = async (cs) => (await scan(fakeDb(columns, cs), wire)).above ? 1 : 0;
        assert.strictEqual(await verdict(counts), 1);
        assert.strictEqual(await verdict({
            'orders.expiration':  { above: '0', max_value: '1200' },
            'blocks.block_index': { above: '0', max_value: '77' },
        }), 0);
    });

    it('render prints one line per wire or non-zero column and a summary, or JSON', async function () {
        const r = await scan(fakeDb(columns, counts), wire);
        const lines = render(r, false).split('\n');
        assert.strictEqual(lines.length, 3);
        assert.ok(lines[0].includes('orders.expiration') && lines[0].includes('wire'));
        assert.ok(lines[1].includes('blocks.block_index') && lines[1].includes('max=18446744073709551615'));
        assert.strictEqual(lines[2], '# database=indexer_test scanned=2 wire=1 above=1');
        assert.deepStrictEqual(JSON.parse(render(r, true)), r);
    });

    it('render omits a non-wire column with count zero', async function () {
        const r = await scan(fakeDb(columns, {
            'orders.expiration':  { above: '0', max_value: null },
            'blocks.block_index': { above: '0', max_value: '5' },
        }), wire);
        const lines = render(r, false).split('\n');
        assert.strictEqual(lines.length, 2);
        assert.ok(!lines.join('\n').includes('block_index'));
    });
});
