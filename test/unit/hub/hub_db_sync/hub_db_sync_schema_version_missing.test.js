'use strict';

const assert = require('assert');
const { HUB_SCHEMA_VERSION } = require('../../../../src/hub/hub_schema_version.js');
const liveEvents = require('../../../../src/hub/hub_db_sync/live_events.js');
const drain = require('../../../../src/hub/hub_db_sync/bootstrap/drain.js');
const verdict = require('../../../../src/hub/hub_db_sync/bootstrap/verdict.js');

function asyncSpy(result) {
    const spy = async function () {
        spy.callCount++;
        return result;
    };
    spy.callCount = 0;
    return spy;
}

describe('HubDbSync schema-version lockstep', function () {
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
});
