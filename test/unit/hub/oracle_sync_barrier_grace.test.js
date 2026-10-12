'use strict';

const assert = require('assert');
const HubDbSync = require('../../../src/hub/hub_db_sync.js');
const { HUB_SYNC_WATERMARK_GRACE_S } = require('../../../src/hub/hub_db_sync/watermark_config.js');

const BLOCK_HEIGHT = 68000000;
const BLOCK_TIME = 1791060000;
const LAST_ORACLE_PRICE = 1790549561;

function makeSync(network) {
    const sync = new HubDbSync({ doQuery: async () => [] }, {
        hubUrl: 'http://hub.test',
        coin: 'DOGE',
        network
    });
    sync.oracleBootstrapped = true;
    sync.oracleSyncTimestamp = LAST_ORACLE_PRICE;
    return sync;
}

describe('oracle sync barrier grace @regression @tier1', function () {
    it('pins the frozen oracle grace to ordinary stream lag', function () {
        assert.strictEqual(HUB_SYNC_WATERMARK_GRACE_S.oracle, 120);
        assert.ok(HUB_SYNC_WATERMARK_GRACE_S.oracle < 600);
        assert.strictEqual(makeSync('testnet').oracleWatermarkGraceS, 120);
    });

    it('holds a block with no covering oracle row until the stream passes block_time + 120', function () {
        const sync = makeSync('testnet');
        assert.ok(!sync.admissionActiveAt(null), 'pre-admission path under test');

        sync.streamWatermark = BLOCK_TIME + 119;
        assert.strictEqual(sync.oracleSyncSatisfied(BLOCK_TIME), false);

        sync.streamWatermark = BLOCK_TIME + 120;
        assert.strictEqual(sync.oracleSyncSatisfied(BLOCK_TIME), true);
    });

    it('does not keep waiting through the former 600 second margin', function () {
        const sync = makeSync('testnet');
        sync.streamWatermark = BLOCK_TIME + 121;
        assert.strictEqual(sync.oracleSyncSatisfied(BLOCK_TIME), true);
        sync.streamWatermark = BLOCK_TIME + 599;
        assert.strictEqual(sync.oracleSyncSatisfied(BLOCK_TIME), true);
    });

    it('still waits on an unbootstrapped mirror regardless of stream time', function () {
        const sync = makeSync('testnet');
        sync.oracleBootstrapped = false;
        sync.streamWatermark = BLOCK_TIME + 10000;
        assert.strictEqual(sync.oracleSyncSatisfied(BLOCK_TIME), false);
    });
});
