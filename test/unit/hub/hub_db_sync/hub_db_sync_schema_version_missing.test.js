'use strict';

const assert = require('assert');
const sinon = require('sinon');
const { HUB_SCHEMA_VERSION } = require('../../../../src/hub/hub_schema_version.js');
const HubDbSync = require('../../../../src/hub/hub_db_sync.js');
const liveEvents = require('../../../../src/hub/hub_db_sync/live_events.js');
const drain = require('../../../../src/hub/hub_db_sync/bootstrap/drain.js');
const verdict = require('../../../../src/hub/hub_db_sync/bootstrap/verdict.js');

const CHAIN_NEW = '1a2b3c4d5e6f' + '0'.repeat(52);
const CHAIN_OLD = '9f8e7d6c5b4a' + 'f'.repeat(52);
const MATCH_COLUMNS = ['id', 'match_id', 'network', 'a_chain', 'b_chain', 'effective_time',
                       'status', 'anchor_txid', 'btc_chain_id'];

function asyncSpy(result) {
    const spy = async function () {
        spy.callCount++;
        return result;
    };
    spy.callCount = 0;
    return spy;
}

function matchRow(id, chainId) {
    return {
        id: id, match_id: 'm' + id, network: 'regtest', a_chain: 'BTC', b_chain: 'DOGE',
        effective_time: 1000 + id, status: 'finalized', anchor_txid: null, btc_chain_id: chainId,
    };
}

function versionedRelicDrain() {
    const seen = [];
    const doQuery = sinon.stub().callsFake(async (sql, args) => {
        seen.push({ sql: sql, args: args });
        if (/^DELETE FROM /.test(sql)) return { affectedRows: 0 };
        if (/^SELECT MAX\(id\)/.test(sql)) return [{ max_id: null }];
        if (/^SELECT MAX\(effective_time\)/.test(sql)) return [{ ts: null }];
        return [];
    });
    const sync = new HubDbSync({ doQuery }, {
        hubUrl: 'http://hub.test', network: 'regtest', coin: 'BTC',
    });
    sinon.stub(sync, 'localColumns').resolves(new Set(MATCH_COLUMNS));
    sinon.stub(sync, 'httpGet').resolves({
        rows: [matchRow(1, CHAIN_OLD), matchRow(2, CHAIN_OLD),
               matchRow(3, null), matchRow(4, CHAIN_NEW)],
        btc_chain_id: CHAIN_NEW,
        watermark: 4242,
        schema_version: HUB_SCHEMA_VERSION,
    });
    return { sync, seen };
}

describe('HubDbSync schema-version lockstep', function () {
    afterEach(function () { sinon.restore(); });

    it('refuses a live row event that carries no schema_version', async function () {
        const sync = {
            _schemaMismatchSeen: false,
            handleInsertedRowEvent: asyncSpy(),
        };

        await liveEvents.handleRowEvent.call(sync, {
            type: 'row:inserted', table: 'oracle_prices', row: { id: 1 },
        });

        assert.strictEqual(sync._schemaMismatchSeen, true);
        assert.strictEqual(sync.handleInsertedRowEvent.callCount, 0);
    });

    it('refuses a snapshot page that carries no schema_version', async function () {
        const sync = { setExpectedBtcChainId: asyncSpy() };

        assert.strictEqual(await drain.acceptSnapshotPage.call(sync, 'oracle_prices', { rows: [] }), false);
        assert.strictEqual(sync.setExpectedBtcChainId.callCount, 0);
    });

    it('refuses a catch-up page that carries no schema_version', async function () {
        const sync = { applyPendingRow: asyncSpy(true) };
        const accounting = { table: 'oracle_prices', applyErrors: 0 };

        await verdict.applyCatchUpPage.call(sync, accounting, { rows: [{ id: 1 }] });

        assert.strictEqual(accounting.applyErrors, 1);
        assert.strictEqual(sync.applyPendingRow.callCount, 0);
    });

    it('admits all three reader payloads when they carry the expected schema_version', async function () {
        const live = {
            _schemaMismatchSeen: false,
            handleInsertedRowEvent: asyncSpy(),
        };
        await liveEvents.handleRowEvent.call(live, {
            type: 'row:inserted', table: 'oracle_prices', schema_version: HUB_SCHEMA_VERSION, row: { id: 1 },
        });

        const snapshot = { setExpectedBtcChainId: asyncSpy() };
        const catchUp = { applyPendingRow: asyncSpy(true) };
        const accounting = { table: 'oracle_prices', applyErrors: 0 };
        assert.strictEqual(await drain.acceptSnapshotPage.call(snapshot, 'oracle_prices', {
            rows: [], schema_version: HUB_SCHEMA_VERSION,
        }), true);
        await verdict.applyCatchUpPage.call(catchUp, accounting, {
            rows: [{ id: 1 }], schema_version: HUB_SCHEMA_VERSION,
        });

        assert.strictEqual(live.handleInsertedRowEvent.callCount, 1);
        assert.strictEqual(live._schemaMismatchSeen, false);
        assert.strictEqual(catchUp.applyPendingRow.callCount, 1);
        assert.strictEqual(accounting.applyErrors, 0);
    });

    it('preserves relic-row refusal after a versioned snapshot passes the shared check', async function () {
        const warn = sinon.stub(console, 'warn');
        const log = sinon.stub(console, 'log');
        const { sync, seen } = versionedRelicDrain();
        await sync.setExpectedBtcChainId(CHAIN_NEW, 'local');

        assert.strictEqual(await sync.bootstrapTable('cross_chain_matches'), 4242);
        const inserts = seen.filter((query) => /^INSERT /.test(query.sql));
        assert.strictEqual(inserts.length, 2);
        assert.ok(inserts.every((query) => !query.args.includes(CHAIN_OLD)));
        assert.strictEqual(warn.getCalls().filter((call) =>
            /refused 2 cross_chain_matches row/.test(call.args.map(String).join(' '))).length, 1);
        assert.ok(log.getCalls().some((call) =>
            /bootstrapped 2 rows into cross_chain_matches/.test(call.args.map(String).join(' '))));
    });
});
