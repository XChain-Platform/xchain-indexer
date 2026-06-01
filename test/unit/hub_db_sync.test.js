process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../src/hub_db_sync.js');

// Build a HubDbSync whose enabled flag is true (needs both a hub URL and a hub DB),
// backed by a stubbed doQuery we drive per-test to simulate the local price mirror.
function makeSync(maxReferenceBlock) {
    const doQuery = sinon.stub();
    doQuery.callsFake(async () => [{ h: maxReferenceBlock }]);
    const hubDb = { doQuery };
    const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test' });
    return { sync, hubDb, doQuery };
}

describe('HubDbSync price-sync barrier @regression @tier3', function () {

    it('starts with priceSyncHeight 0 and is enabled when url + db present', function () {
        const { sync } = makeSync(0);
        assert.strictEqual(sync.priceSyncHeight, 0);
        assert.strictEqual(sync.enabled, true);
    });

    it('_refreshPriceSyncHeight adopts MAX(reference_block) from the local mirror', async function () {
        const { sync } = makeSync(123);
        await sync._refreshPriceSyncHeight();
        assert.strictEqual(sync.priceSyncHeight, 123);
    });

    it('_refreshPriceSyncHeight leaves height untouched when the table is not ready', async function () {
        const { sync, doQuery } = makeSync(0);
        sync.priceSyncHeight = 50;
        doQuery.rejects(new Error("Table 'price_snapshots' doesn't exist"));
        await sync._refreshPriceSyncHeight();
        assert.strictEqual(sync.priceSyncHeight, 50, 'height must not reset on query failure');
    });

    it('waitForPriceSyncHeight resolves immediately when already caught up', async function () {
        const { sync } = makeSync(0);
        sync.priceSyncHeight = 200;
        const got = await sync.waitForPriceSyncHeight(150, 1000);
        assert.strictEqual(got, 200);
    });

    it('waitForPriceSyncHeight resolves once a later sync raises the height', async function () {
        const { sync, doQuery } = makeSync(80);
        // Target not yet reached — the promise should stay pending.
        const pending = sync.waitForPriceSyncHeight(100, 2000);
        assert.strictEqual(sync._priceWaiters.length, 1);
        // A subsequent sync delivers a round anchored at/after the target.
        doQuery.callsFake(async () => [{ h: 120 }]);
        await sync._refreshPriceSyncHeight();
        const got = await pending;
        assert.strictEqual(got, 120);
        assert.strictEqual(sync._priceWaiters.length, 0, 'waiter should be cleared on resolve');
    });

    it('waitForPriceSyncHeight rejects on timeout when the mirror stays behind', async function () {
        const { sync } = makeSync(10);
        sync.priceSyncHeight = 10;
        await assert.rejects(
            sync.waitForPriceSyncHeight(100, 50),
            /price sync barrier timed out/
        );
        assert.strictEqual(sync._priceWaiters.length, 0, 'timed-out waiter should be removed');
    });

    it('waitForPriceSyncHeight is a no-op when sync is disabled (single-host)', async function () {
        // No hub URL → enabled false → the local hub DB is the hub itself, always current.
        const sync = new HubDbSync({ doQuery: sinon.stub() }, {});
        assert.strictEqual(sync.enabled, false);
        const got = await sync.waitForPriceSyncHeight(999999, 10);
        assert.strictEqual(got, 0);
    });

    it('waitForPriceSyncHeight resolves for a non-finite target rather than hanging', async function () {
        const { sync } = makeSync(0);
        const got = await sync.waitForPriceSyncHeight(undefined, 10);
        assert.strictEqual(got, sync.priceSyncHeight);
    });
});

// Build a HubDbSync whose enabled flag is true, backed by a stubbed doQuery returning a
// MAX(effective_at) row to simulate the local oracle_prices mirror. maxEffectiveAt === null
// simulates an empty oracle_prices table (a deployment with no FIAT oracles).
function makeOracleSync(maxEffectiveAt) {
    const doQuery = sinon.stub();
    doQuery.callsFake(async () => [{ ts: maxEffectiveAt }]);
    const hubDb = { doQuery };
    const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test' });
    return { sync, hubDb, doQuery };
}

describe('HubDbSync oracle-sync barrier @regression @tier3', function () {

    it('starts with oracleSyncTimestamp null and oracleBootstrapped false', function () {
        const { sync } = makeOracleSync(0);
        assert.strictEqual(sync.oracleSyncTimestamp, null);
        assert.strictEqual(sync.oracleBootstrapped, false);
    });

    it('_refreshOracleSyncTimestamp adopts MAX(effective_at) and marks bootstrapped', async function () {
        const { sync } = makeOracleSync(1700000000);
        await sync._refreshOracleSyncTimestamp();
        assert.strictEqual(sync.oracleSyncTimestamp, 1700000000);
        assert.strictEqual(sync.oracleBootstrapped, true);
    });

    it('_refreshOracleSyncTimestamp records an empty mirror as null but still bootstrapped', async function () {
        const { sync } = makeOracleSync(null);     // MAX over an empty table → null
        await sync._refreshOracleSyncTimestamp();
        assert.strictEqual(sync.oracleSyncTimestamp, null);
        assert.strictEqual(sync.oracleBootstrapped, true);
    });

    it('_refreshOracleSyncTimestamp leaves state untouched when the table is not ready', async function () {
        const { sync, doQuery } = makeOracleSync(0);
        sync.oracleSyncTimestamp = 1234;
        sync.oracleBootstrapped  = true;
        doQuery.rejects(new Error("Table 'oracle_prices' doesn't exist"));
        await sync._refreshOracleSyncTimestamp();
        assert.strictEqual(sync.oracleSyncTimestamp, 1234, 'timestamp must not reset on query failure');
    });

    it('waitForOracleSyncTimestamp blocks before bootstrap, then resolves once caught up', async function () {
        const { sync, doQuery } = makeOracleSync(1000);
        // Not yet bootstrapped → must NOT resolve early even though target looks small.
        const pending = sync.waitForOracleSyncTimestamp(1500, 2000);
        assert.strictEqual(sync._oracleWaiters.length, 1);
        // A sync delivers prices effective at/after the target block time.
        doQuery.callsFake(async () => [{ ts: 1600 }]);
        await sync._refreshOracleSyncTimestamp();
        const got = await pending;
        assert.strictEqual(got, 1600);
        assert.strictEqual(sync._oracleWaiters.length, 0, 'waiter should be cleared on resolve');
    });

    it('waitForOracleSyncTimestamp resolves immediately when already caught up', async function () {
        const { sync } = makeOracleSync(0);
        sync.oracleBootstrapped  = true;
        sync.oracleSyncTimestamp = 2000;
        const got = await sync.waitForOracleSyncTimestamp(1500, 1000);
        assert.strictEqual(got, 2000);
    });

    it('waitForOracleSyncTimestamp is a no-op once the mirror is known to be empty (no FIAT oracles)', async function () {
        const { sync } = makeOracleSync(null);
        await sync._refreshOracleSyncTimestamp();      // empty table → bootstrapped, timestamp null
        // Must resolve immediately for any block time — otherwise non-oracle deployments stall.
        const got = await sync.waitForOracleSyncTimestamp(9999999999, 50);
        assert.strictEqual(got, null);
    });

    it('waitForOracleSyncTimestamp rejects on timeout when the mirror stays behind', async function () {
        const { sync } = makeOracleSync(0);
        sync.oracleBootstrapped  = true;
        sync.oracleSyncTimestamp = 1000;
        await assert.rejects(
            sync.waitForOracleSyncTimestamp(5000, 50),
            /oracle sync barrier timed out/
        );
        assert.strictEqual(sync._oracleWaiters.length, 0, 'timed-out waiter should be removed');
    });

    it('waitForOracleSyncTimestamp is a no-op when sync is disabled (single-host)', async function () {
        const sync = new HubDbSync({ doQuery: sinon.stub() }, {});
        assert.strictEqual(sync.enabled, false);
        const got = await sync.waitForOracleSyncTimestamp(999999, 10);
        assert.strictEqual(got, null);
    });

    it('waitForOracleSyncTimestamp resolves for a non-finite target rather than hanging', async function () {
        const { sync } = makeOracleSync(0);
        const got = await sync.waitForOracleSyncTimestamp(undefined, 10);
        assert.strictEqual(got, sync.oracleSyncTimestamp);
    });
});
