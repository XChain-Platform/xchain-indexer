/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const assert = require('assert');

const blocksMixin = require('../../../src/db/blocks/index.js');
const {
    parseArgs, vmBlocksQuery, measure, render,
} = require('../../../bin/measure_vm_snapshot_bytes.js');

const SETTLEMENT_SQL = /FROM cross_chain_settlements/;
const XCALLS_SQL = /FROM xcalls/;
const EXECUTIONS_SQL = /FROM contract_executions/;

function makeDb(executionRows){
    const queries = [];
    const settlements = {
        12: [{ a_chain: 'BTC', a_action_index: 7, b_chain: 'DOGE', b_action_index: 9 }],
        8: [],
    };
    const calls = {
        12: [{ call_id: 101, result_status: 'ok', result_payload: null }],
        8: [],
    };
    const doQuery = async (sql, args) => {
        queries.push({ sql, args });
        if(SETTLEMENT_SQL.test(sql)) return settlements[args[0]] || [];
        if(XCALLS_SQL.test(sql)) return calls[args[0]] || [];
        throw new Error('unexpected query: ' + sql);
    };
    const doQueryStrict = async (sql, args) => {
        queries.push({ sql, args });
        if(EXECUTIONS_SQL.test(sql)) return executionRows;
        throw new Error('unexpected strict query: ' + sql);
    };
    return { db: Object.assign({}, blocksMixin, { doQuery, doQueryStrict }), queries };
}

describe('bin/measure_vm_snapshot_bytes', function () {
    it('parses bounds, limit, database, cached and JSON modes', function () {
        assert.deepStrictEqual(parseArgs([]), {
            from: null, to: null, limit: 50, db: null, cached: false, json: false,
        });
        assert.deepStrictEqual(parseArgs([
            '--from', '0', '--to', '12', '--limit', '5', '--db', 'indexer', '--cached', '--json',
        ]), { from: 0, to: 12, limit: 5, db: 'indexer', cached: true, json: true });
    });

    it('rejects unknown flags and invalid numeric arguments', function () {
        assert.throws(() => parseArgs(['--unknown']), /unknown argument/);
        assert.throws(() => parseArgs(['--limit']), /positive integer/);
        assert.throws(() => parseArgs(['--limit', '0']), /positive integer/);
        assert.throws(() => parseArgs(['--from', '-1']), /non-negative integer/);
        assert.throws(() => parseArgs(['--to', '1.5']), /non-negative integer/);
    });

    it('builds newest-first grouped SQL with optional bounds and a final limit argument', function () {
        const unbounded = vmBlocksQuery({ from: null, to: null, limit: 50 });
        assert.match(unbounded.sql, /^SELECT block_index, COUNT\(\*\) AS executions/m);
        assert.match(unbounded.sql, /FROM contract_executions/);
        assert.match(unbounded.sql, /GROUP BY block_index/);
        assert.match(unbounded.sql, /ORDER BY block_index DESC/);
        assert.deepStrictEqual(unbounded.args, [50]);

        const bounded = vmBlocksQuery({ from: 4, to: 20, limit: 7 });
        assert.match(bounded.sql, /WHERE block_index >= \? AND block_index <= \?/);
        assert.deepStrictEqual(bounded.args, [4, 20, 7]);
    });

    it('measures real builder bytes and transfer totals for each execution block', async function () {
        const { db, queries } = makeDb([
            { block_index: '12', executions: '3' },
            { block_index: '8', executions: '1' },
        ]);
        const realBuilder = db.buildCrossChainDataForVM;
        const buildBounds = [];
        db.buildCrossChainDataForVM = async function (bound){
            buildBounds.push(bound);
            return realBuilder.call(this, bound);
        };
        db.getCrossChainDataForVM = async () => {
            throw new Error('cached getter must not be used');
        };
        const ticks = [100, 104, 104, 106, 200, 207, 207, 210];
        const result = await measure(db, { from: 5, to: 12, limit: 2 }, () => ticks.shift());
        const expected = [];
        for(const blockIndex of [12, 8]){
            const snapshot = await db.buildCrossChainDataForVM(blockIndex);
            expected.push(Buffer.byteLength(JSON.stringify(snapshot)));
        }

        assert.deepStrictEqual(result.blocks.map(block => block.blockIndex), [12, 8]);
        assert.deepStrictEqual(buildBounds.slice(0, 2), [12, 8]);
        assert.deepStrictEqual(result.blocks.map(block => block.bytes), expected);
        assert.deepStrictEqual(result.blocks.map(block => block.executions), [3, 1]);
        assert.deepStrictEqual(result.blocks.map(block => block.buildMs), [4, 7]);
        assert.deepStrictEqual(result.blocks.map(block => block.serializeMs), [2, 3]);
        assert.deepStrictEqual(result.blocks.map(block => block.sentBefore), [expected[0] * 3, expected[1]]);
        assert.deepStrictEqual(result.blocks.map(block => block.sentAfter), expected);
        assert.strictEqual(result.scanned, 2);
        assert.strictEqual(result.maxBytes, Math.max(...expected));
        assert.strictEqual(result.maxBuildMs, 7);
        assert.strictEqual(result.sentBeforeBytes, expected[0] * 3 + expected[1]);
        assert.strictEqual(result.sentAfterBytes, expected[0] + expected[1]);
        assert.strictEqual(result.cache, undefined);

        const builderQueries = queries.filter(query => SETTLEMENT_SQL.test(query.sql) || XCALLS_SQL.test(query.sql));
        assert.deepStrictEqual(builderQueries.slice(0, 4).map(query => query.args), [[12], [12], [8], [8]]);
        assert.ok(builderQueries.slice(0, 4).every(query => typeof query.args[0] === 'number'));
        assert.deepStrictEqual(queries[0].args, [5, 12, 2]);
    });

    it('reports one miss then hits in oldest-first cached mode and restores database state', async function () {
        const snapshot = { attestations: {}, settled: {}, calls: {} };
        const originalBuilder = async () => snapshot;
        const db = {
            blockIndex: 7,
            _vmSnapshotMemo: null,
            doQueryStrict: async () => [
                { block_index: '12', executions: 2 },
                { block_index: '11', executions: 1 },
                { block_index: '10', executions: 1 },
            ],
            buildCrossChainDataForVM: originalBuilder,
            async getCrossChainDataForVM(blockIndex){
                if(!this.cachedSnapshot)
                    this.cachedSnapshot = await this.buildCrossChainDataForVM(blockIndex);
                return this.cachedSnapshot;
            },
        };
        let tick = 0;
        const result = await measure(db, { from: null, to: null, limit: 5, cached: true }, () => tick++);

        assert.deepStrictEqual(result.cache, {
            hits: 2,
            misses: 1,
            maxHitMs: 1,
            maxMissMs: 1,
            blocks: [
                { blockIndex: 10, hit: false, ms: 1 },
                { blockIndex: 11, hit: true, ms: 1 },
                { blockIndex: 12, hit: true, ms: 1 },
            ],
        });
        assert.strictEqual(db.buildCrossChainDataForVM, originalBuilder);
        assert.strictEqual(db.blockIndex, 7);
        assert.strictEqual(db._vmSnapshotMemo, null);
        assert.match(render(result, false), /\n# cache blocks=3 hits=2 misses=1 max-hit=1ms max-miss=1ms$/);
        assert.deepStrictEqual(JSON.parse(render(result, true)).cache, result.cache);
    });

    it('restores the original builder and database state when cached measurement throws', async function () {
        const snapshot = { attestations: {}, settled: {}, calls: {} };
        let calls = 0;
        const originalBuilder = async () => {
            if(++calls === 2) throw new Error('builder failed');
            return snapshot;
        };
        const db = {
            blockIndex: 44,
            _vmSnapshotMemo: null,
            doQueryStrict: async () => [{ block_index: '12', executions: 1 }],
            buildCrossChainDataForVM: originalBuilder,
            async getCrossChainDataForVM(blockIndex){
                return this.buildCrossChainDataForVM(blockIndex);
            },
        };

        await assert.rejects(
            measure(db, { from: null, to: null, limit: 1, cached: true }, () => 0),
            /builder failed/);
        assert.strictEqual(db.buildCrossChainDataForVM, originalBuilder);
        assert.strictEqual(db.blockIndex, 44);
        assert.strictEqual(db._vmSnapshotMemo, null);
    });

    it('measures cached mode with getCrossChainDataForVM from src/db/blocks', async function () {
        const { db } = makeDb([
            { block_index: '12', executions: '1' },
            { block_index: '8', executions: '1' },
        ]);
        db.blockIndex = 20;
        db._vmSnapshotMemo = null;
        const result = await measure(
            db, { from: null, to: null, limit: 2, cached: true }, () => 0);

        assert.deepStrictEqual(result.cache.blocks.map(block => block.blockIndex), [8, 12]);
        assert.strictEqual(result.cache.blocks[0].hit, false);
        assert.strictEqual(result.cache.hits + result.cache.misses, result.scanned);
        assert.strictEqual(db.blockIndex, 20);
        assert.strictEqual(db._vmSnapshotMemo, null);
    });

    it('times one serialization per block with a counter clock and prices both send shapes', async function () {
        const snapshot = { attestations: {}, settled: { 'BTC:7': true }, calls: {} };
        const db = {
            doQueryStrict: async () => [{ block_index: '12', executions: 3 }],
            buildCrossChainDataForVM: async () => snapshot,
        };
        let reads = 0;
        const result = await measure(db, { from: null, to: null, limit: 5 }, () => reads++);
        const bytes = Buffer.byteLength(JSON.stringify(snapshot));

        assert.strictEqual(reads, 4);
        assert.strictEqual(result.blocks[0].buildMs, 1);
        assert.strictEqual(result.blocks[0].serializeMs, 1);
        assert.strictEqual(result.blocks[0].sentBeforeMs, 3);
        assert.strictEqual(result.blocks[0].sentAfterMs, 1);
        assert.strictEqual(result.maxSerializeMs, 1);
        assert.strictEqual(result.sentBeforeMs, 3);
        assert.strictEqual(result.sentAfterMs, 1);
        assert.strictEqual(result.sentBeforeBytes, bytes * 3);
        assert.strictEqual(result.sentAfterBytes, bytes);
        assert.deepStrictEqual(render(result, false).split('\n').map(line => line.replace(/^.* (serialize=|max-serialize=)/, '$1')), [
            'serialize=1ms sent-before-ms=3 sent-after-ms=1',
            'max-serialize=1ms sent-before-ms=3 sent-after-ms=1',
        ]);
    });

    it('returns a zero summary when no execution blocks match', async function () {
        const { db } = makeDb([]);
        const result = await measure(db, { from: null, to: null, limit: 50 });

        assert.deepStrictEqual(result, {
            blocks: [], scanned: 0, maxBytes: 0, maxBuildMs: 0,
            maxSerializeMs: 0, sentBeforeMs: 0, sentAfterMs: 0,
            sentBeforeBytes: 0, sentAfterBytes: 0,
        });
    });

    it('renders block lines, the summary line and JSON', function () {
        const result = {
            blocks: [{
                blockIndex: 12, executions: 3, bytes: 80, buildMs: 4,
                serializeMs: 1, sentBeforeMs: 3, sentAfterMs: 1,
                sentBefore: 240, sentAfter: 80,
            }],
            scanned: 1, maxBytes: 80, maxBuildMs: 4,
            maxSerializeMs: 1, sentBeforeMs: 3, sentAfterMs: 1,
            sentBeforeBytes: 240, sentAfterBytes: 80,
        };

        assert.strictEqual(render(result, false),
            'block=12 executions=3 bytes=80 build=4ms sent-before=240 sent-after=80'
            + ' serialize=1ms sent-before-ms=3 sent-after-ms=1\n'
            + '# blocks=1 max-bytes=80 max-build=4ms sent-before=240 sent-after=80'
            + ' max-serialize=1ms sent-before-ms=3 sent-after-ms=1');
        assert.deepStrictEqual(JSON.parse(render(result, true)), result);
    });

    it('issues SELECT statements only', async function () {
        const { db, queries } = makeDb([{ block_index: '12', executions: 1 }]);
        await measure(db, { from: null, to: null, limit: 1 }, () => 0);

        assert.strictEqual(queries.length, 3);
        for(const query of queries) assert.match(query.sql.trim(), /^SELECT/);
    });
});
