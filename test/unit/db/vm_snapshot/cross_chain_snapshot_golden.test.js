'use strict';

/*
 * test/unit/db/vm_snapshot/cross_chain_snapshot_golden.test.js
 *
 * Golden bytes for the cross-chain VM snapshot. buildCrossChainDataForVM and
 * getCrossChainDataForVM run on a stub with no _vmSnapshotMemo, so the getter
 * builds fresh on every call, and the JSON.stringify of each snapshot is compared
 * against a literal string so key order is pinned along with the values.
 */

const assert = require('assert');

const blocks = require('../../../../src/db/blocks/index.js');

const SETTLEMENT_SQL = /FROM cross_chain_settlements/;
const XCALLS_SQL = /FROM xcalls/;

function makeStub(settlementRows, callRows){
    const queries = [];
    const doQuery = async (sql, params) => {
        queries.push({ sql, params });
        if(SETTLEMENT_SQL.test(sql)) return settlementRows;
        if(XCALLS_SQL.test(sql)) return callRows;
        throw new Error('unexpected query: ' + sql);
    };
    const stub = Object.assign({}, blocks, { doQuery });
    return { stub, queries };
}

const SETTLEMENTS = [
    { a_chain: 'BTC', a_action_index: 7, b_chain: 'DOGE', b_action_index: 12 }
];
const CALLS = [
    { call_id: 102, result_status: 'timeout', result_payload: 'late' },
    { call_id: 101, result_status: 'ok', result_payload: null }
];

const GOLDEN_FULL = '{"attestations":{},"settled":{"BTC:7":true,"DOGE:12":true},'
    + '"calls":{"101":{"status":"ok","payload":""},"102":{"status":"timeout","payload":"late"}}}';
const GOLDEN_EMPTY = '{"attestations":{},"settled":{},"calls":{}}';

describe('cross-chain VM snapshot golden bytes', function () {
    it('builds both CHAIN:action_index keys from one settlement and keys numeric ids as strings', async function () {
        const { stub } = makeStub(SETTLEMENTS, CALLS);
        const snapshot = await stub.buildCrossChainDataForVM(25);

        assert.strictEqual(JSON.stringify(snapshot), GOLDEN_FULL);
    });

    it('turns a null result_payload on a completed xcall into the empty string and keeps an expired payload', async function () {
        const { stub } = makeStub([], CALLS);
        const snapshot = await stub.buildCrossChainDataForVM(25);

        assert.strictEqual(snapshot.calls['101'].payload, '');
        assert.strictEqual(snapshot.calls['102'].payload, 'late');
        assert.strictEqual(JSON.stringify(snapshot),
            '{"attestations":{},"settled":{},'
            + '"calls":{"101":{"status":"ok","payload":""},"102":{"status":"timeout","payload":"late"}}}');
    });

    it('serializes the empty case as empty attestations, settled and calls maps', async function () {
        const { stub } = makeStub([], []);
        const snapshot = await stub.buildCrossChainDataForVM(25);

        assert.strictEqual(JSON.stringify(snapshot), GOLDEN_EMPTY);
    });

    it('passes [bound] to both reads, coercing a string block_index to a Number', async function () {
        const { stub, queries } = makeStub(SETTLEMENTS, CALLS);
        await stub.getCrossChainDataForVM('25');

        assert.strictEqual(queries.length, 2);
        assert.ok(SETTLEMENT_SQL.test(queries[0].sql));
        assert.ok(XCALLS_SQL.test(queries[1].sql));
        for(const q of queries){
            assert.deepStrictEqual(q.params, [25]);
            assert.strictEqual(typeof q.params[0], 'number');
        }
    });

    it('getCrossChainDataForVM returns the same bytes as the builder', async function () {
        const built = makeStub(SETTLEMENTS, CALLS);
        const got = makeStub(SETTLEMENTS, CALLS);
        const fromBuilder = await built.stub.buildCrossChainDataForVM(25);
        const fromGetter = await got.stub.getCrossChainDataForVM('25');

        assert.strictEqual(JSON.stringify(fromGetter), JSON.stringify(fromBuilder));
        assert.strictEqual(JSON.stringify(fromGetter), GOLDEN_FULL);
    });

    it('getCrossChainDataForVM returns the empty bytes when both reads are empty', async function () {
        const { stub } = makeStub([], []);
        const snapshot = await stub.getCrossChainDataForVM(0);

        assert.strictEqual(JSON.stringify(snapshot), GOLDEN_EMPTY);
    });
});
