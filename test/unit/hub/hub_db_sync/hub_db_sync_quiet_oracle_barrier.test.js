'use strict';

const assert = require('assert');
const HubDbSync = require('../../../../src/hub/hub_db_sync.js');

const BLOCK_HEIGHT = 68000000;
const BLOCK_TIME = 1791060000;
const LAST_ORACLE_PRICE = 1790549561;

function makeQuietSync() {
    const sync = new HubDbSync({ doQuery: async () => [] }, {
        hubUrl: 'http://hub.test',
        coin: 'DOGE',
        network: 'testnet'
    });
    sync.priceBootstrapped = true;
    sync.oracleBootstrapped = true;
    sync.matchBootstrapped = true;
    sync.priceSyncMaxTimestamp = LAST_ORACLE_PRICE;
    sync.oracleSyncTimestamp = LAST_ORACLE_PRICE;
    sync.matchSyncTimestamp = LAST_ORACLE_PRICE;
    sync.noteHeights({
        price_snapshots: { DOGE: BLOCK_HEIGHT - 5 },
        oracle_prices: { DOGE: BLOCK_HEIGHT - 2 },
        cross_chain_matches: { DOGE: BLOCK_HEIGHT - 5 }
    });
    return sync;
}

describe('HubDbSync quiet oracle admission barriers @regression @tier1', function () {
    it('accepts a current stream heartbeat when published admission heights are stale', function () {
        const sync = makeQuietSync();

        sync.streamWatermark = BLOCK_TIME + sync.oracleWatermarkGraceS - 1;
        assert.strictEqual(sync.oracleSyncSatisfied(BLOCK_TIME, BLOCK_HEIGHT), false);
        assert.strictEqual(sync.matchSyncSatisfied(BLOCK_TIME, BLOCK_HEIGHT), false);

        sync.streamWatermark = BLOCK_TIME + sync.oracleWatermarkGraceS;
        assert.strictEqual(sync.oracleSyncSatisfied(BLOCK_TIME, BLOCK_HEIGHT), true);
        assert.strictEqual(sync.matchSyncSatisfied(BLOCK_TIME, BLOCK_HEIGHT), true);

        sync.streamWatermark = BLOCK_TIME + sync.priceWatermarkGraceS - 1;
        assert.strictEqual(sync.priceTimeSyncSatisfied(BLOCK_TIME, BLOCK_HEIGHT), false);
        sync.streamWatermark++;
        assert.strictEqual(sync.priceTimeSyncSatisfied(BLOCK_TIME, BLOCK_HEIGHT), true);
        assert.deepStrictEqual(sync._heightShortfalls, {},
            'a barrier released by the stream must not report a height stall');
    });

    it('releases in-flight waiters on a heartbeat without receiving a new row', async function () {
        const sync = makeQuietSync();
        sync.streamWatermark = 0;

        const waiting = [
            sync.waitForOracleSyncTimestamp(BLOCK_TIME, 2000, BLOCK_HEIGHT),
            sync.waitForPriceSyncTime(BLOCK_TIME, 2000, BLOCK_HEIGHT),
            sync.waitForMatchSync(BLOCK_TIME, 2000, BLOCK_HEIGHT)
        ];
        assert.strictEqual(sync._oracleWaiters.length, 1);
        assert.strictEqual(sync._priceTimeWaiters.length, 1);
        assert.strictEqual(sync._matchWaiters.length, 1);

        sync.advanceWatermark(BLOCK_TIME + sync.priceWatermarkGraceS);
        await Promise.all(waiting);
        assert.strictEqual(sync._oracleWaiters.length, 0);
        assert.strictEqual(sync._priceTimeWaiters.length, 0);
        assert.strictEqual(sync._matchWaiters.length, 0);
    });

    it('keeps admission-era barriers closed when the hub published no height evidence', function () {
        const sync = makeQuietSync();
        sync.heightWatermarks = {};
        sync.streamWatermark = BLOCK_TIME + sync.priceWatermarkGraceS;

        assert.strictEqual(sync.oracleSyncSatisfied(BLOCK_TIME, BLOCK_HEIGHT), false);
        assert.strictEqual(sync.priceTimeSyncSatisfied(BLOCK_TIME, BLOCK_HEIGHT), false);
        assert.strictEqual(sync.matchSyncSatisfied(BLOCK_TIME, BLOCK_HEIGHT), false);
    });
});
