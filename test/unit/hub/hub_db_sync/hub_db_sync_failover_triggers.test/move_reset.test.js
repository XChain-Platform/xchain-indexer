'use strict';

const assert = require('assert');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');
const { resetForMove } = require('../../../../../src/hub/hub_db_sync/failover/move_reset.js');

const RESET_FIELDS = [
    '_lastHubInstanceId', '_readyMaxIds', '_readyWatermark', '_readyHeights',
    'priceSyncMaxTimestamp', 'oracleSyncTimestamp'
];
const UNTOUCHED_VALUES = {
    streamWatermark: 101,
    _bootstrapDrained: true,
    _wsEpoch: 102,
    priceSyncHeight: 103,
    matchSyncTimestamp: 104,
    callSyncTimestamp: 105,
    heightWatermarks: { policy_snapshots: { DOGE: 106 } }
};

function makeSync(doQuery) {
    return new HubDbSync({ doQuery }, { hubUrl: 'http://hub-a.test' });
}

function assertFreshResetValues(sync, fresh) {
    for (const field of RESET_FIELDS)
        assert.strictEqual(sync[field], fresh[field], field + ' did not return to its fresh value');
    assert.deepStrictEqual(sync._drainPositions, fresh._drainPositions);
}

function assertUntouchedValues(sync) {
    for (const [field, value] of Object.entries(UNTOUCHED_VALUES))
        assert.strictEqual(sync[field], value, field + ' changed during the move reset');
}

describe('HubDbSync failover move reset', function () {
    it('resets only hub-specific state to fresh pinned-mode values and is idempotent', function () {
        const doQuery = async () => [];
        const sync = makeSync(doQuery);
        const fresh = makeSync(doQuery);
        const oldDrainPositions = { state_checkpoints: 44 };

        Object.assign(sync, {
            _drainPositions: oldDrainPositions,
            _lastHubInstanceId: 'old-hub-instance',
            _readyMaxIds: { state_checkpoints: 45 },
            _readyWatermark: 46,
            _readyHeights: { state_checkpoints: { BTC: 47 } },
            priceSyncMaxTimestamp: 48,
            oracleSyncTimestamp: 49
        }, UNTOUCHED_VALUES);

        resetForMove(sync);

        assertFreshResetValues(sync, fresh);
        assert.notStrictEqual(sync._drainPositions, oldDrainPositions);
        assert.strictEqual(Object.getPrototypeOf(sync._drainPositions), null);
        assertUntouchedValues(sync);

        resetForMove(sync);

        assertFreshResetValues(sync, fresh);
        assertUntouchedValues(sync);
    });
});
