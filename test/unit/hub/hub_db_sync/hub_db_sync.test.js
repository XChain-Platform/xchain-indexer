// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../../../src/hub/hub_db_sync.js');

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

    it('_refreshPriceSyncHeight issues two single-MAX queries, not one statement carrying both MAXes', async function () {
        // The two-MAX-in-one-statement shape defeats MariaDB's index-only min/max
        // optimization and forces a full scan of the unbounded price_snapshots table
        // (ATTEST lane 2026-09-05). Pin the shape directly: exactly two doQuery calls,
        // neither of which asks for both aggregates at once, each independently supplying
        // its own half of the result (so this fails if a "fix" collapses back to one
        // query and just reads both fields off its single row).
        const doQuery = sinon.stub();
        doQuery.onCall(0).resolves([{ h: 321 }]);
        doQuery.onCall(1).resolves([{ ts: 9999 }]);
        const hubDb = { doQuery };
        const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test' });

        await sync._refreshPriceSyncHeight();

        assert.strictEqual(doQuery.callCount, 2, 'expected exactly two doQuery calls, one per MAX');
        for (let call of doQuery.getCalls()) {
            const sql = call.args[0];
            const hasRefBlockMax = /MAX\(\s*reference_block\s*\)/i.test(sql);
            const hasTimestampMax = /MAX\(\s*block_timestamp\s*\)/i.test(sql);
            assert.ok(!(hasRefBlockMax && hasTimestampMax),
                'a single statement must not carry both MAX(reference_block) and MAX(block_timestamp): ' + sql);
        }
        assert.strictEqual(sync.priceSyncHeight, 321, 'height must come from the reference_block query');
        assert.strictEqual(sync.priceSyncMaxTimestamp, 9999, 'max timestamp must come from the block_timestamp query');
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
});

describe('HubDbSync price-sync barrier @regression @tier3', function () {
    it('waitForPriceSyncHeight resolves once a later sync raises the height', async function () {
        const { sync, doQuery } = makeSync(80);
        // Target not yet reached; the promise should stay pending.
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

    it('waitForPriceSyncHeight self-heals on timeout when the DB caught up but in-memory height was stale (2026-06-13 regression)', async function () {
        // In-memory priceSyncHeight only advances when a stream/bootstrap event drives
        // _refreshPriceSyncHeight; a missed refresh on a stream/reconnect edge can leave
        // it frozen behind a local mirror DB that is actually current. Before this fix,
        // every tip block then deferred the full timeout even though the data was present
        // (BTC mainnet: in-memory stuck at the restart block while price_snapshots had
        // caught up; cleared only by a second process restart). The timeout path now
        // re-reads the DB and resolves instead of rejecting when the mirror has caught up.
        const { sync, doQuery } = makeSync(10);
        sync.priceSyncHeight = 10;                          // in-memory frozen behind the target
        doQuery.callsFake(async () => [{ h: 150 }]);        // but the local mirror DB is past it
        const got = await sync.waitForPriceSyncHeight(100, 50);
        assert.strictEqual(got, 150, 'should adopt the caught-up DB height instead of timing out');
        assert.strictEqual(sync._priceWaiters.length, 0, 'self-healed waiter should be cleared');
    });

    it('reconnect edge: _refreshAllSyncHeights clears a price waiter from the current mirror without the timeout (v2)', async function () {
        // The reconnect path now proactively re-reads the local mirror BEFORE re-bootstrap.
        // A block deferred only because the in-memory height froze behind a mirror that is
        // actually current clears immediately, instead of each block waiting out the 60s
        // self-heal timeout (the earlier 5d465fa fix). Long timeout here proves the resolve
        // comes from the proactive refresh, not the timeout.
        const { sync, doQuery } = makeSync(10);
        sync.priceSyncHeight = 10;                          // in-memory frozen behind the target
        const pending = sync.waitForPriceSyncHeight(100, 60000);
        assert.strictEqual(sync._priceWaiters.length, 1);
        doQuery.callsFake(async () => [{ h: 150 }]);        // local mirror is actually current
        await sync.refreshAllSyncHeights();               // simulate the reconnect-edge refresh
        const got = await pending;
        assert.strictEqual(got, 150, 'waiter resolves from the mirror on reconnect, not the timeout');
        assert.strictEqual(sync._priceWaiters.length, 0, 'waiter cleared proactively');
    });
});

describe('HubDbSync price-sync barrier @regression @tier3', function () {
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

    it('_refreshOracleSyncTimestamp adopts MAX(effective_at) and marks bootstrapped on the drain path', async function () {
        const { sync } = makeOracleSync(1700000000);
        await sync.refreshOracleSyncTimestamp(true);   // armBootstrap=true = the full-drain path
        assert.strictEqual(sync.oracleSyncTimestamp, 1700000000);
        assert.strictEqual(sync.oracleBootstrapped, true);
    });

    it('_refreshOracleSyncTimestamp records an empty mirror as null but still bootstrapped on the drain path', async function () {
        const { sync } = makeOracleSync(null);     // MAX over an empty table → null
        await sync.refreshOracleSyncTimestamp(true);
        assert.strictEqual(sync.oracleSyncTimestamp, null);
        assert.strictEqual(sync.oracleBootstrapped, true);
    });

    it('_refreshOracleSyncTimestamp does NOT arm when the bootstrap has not drained (#1788)', async function () {
        // Default armBootstrap = this._bootstrapDrained (false here): a reconnect
        // (refreshAllSyncHeights before re-bootstrap) or a single live row mid-partial-
        // bootstrap updates the scalar but must NOT arm the empty-mirror fast path.
        const { sync } = makeOracleSync(null);
        assert.strictEqual(sync._bootstrapDrained, false);
        await sync.refreshOracleSyncTimestamp();       // no arg = the reconnect/live-row default
        assert.strictEqual(sync.oracleSyncTimestamp, null, 'scalar still refreshed');
        assert.strictEqual(sync.oracleBootstrapped, false, 'flag withheld until a full drain');
    });

    it('_refreshOracleSyncTimestamp leaves state untouched when the table is not ready', async function () {
        const { sync, doQuery } = makeOracleSync(0);
        sync.oracleSyncTimestamp = 1234;
        sync.oracleBootstrapped  = true;
        doQuery.rejects(new Error("Table 'oracle_prices' doesn't exist"));
        await sync.refreshOracleSyncTimestamp();
        assert.strictEqual(sync.oracleSyncTimestamp, 1234, 'timestamp must not reset on query failure');
    });

    it('waitForOracleSyncTimestamp blocks before bootstrap, then resolves once caught up', async function () {
        const { sync, doQuery } = makeOracleSync(1000);
        // Not yet bootstrapped → must NOT resolve early even though target looks small.
        const pending = sync.waitForOracleSyncTimestamp(1500, 2000);
        assert.strictEqual(sync._oracleWaiters.length, 1);
        // A sync delivers prices effective at/after the target block time.
        doQuery.callsFake(async () => [{ ts: 1600 }]);
        await sync.refreshOracleSyncTimestamp();
        const got = await pending;
        assert.strictEqual(got, 1600);
        assert.strictEqual(sync._oracleWaiters.length, 0, 'waiter should be cleared on resolve');
    });
});

describe('HubDbSync oracle-sync barrier @regression @tier3', function () {
    it('waitForOracleSyncTimestamp resolves immediately when already caught up', async function () {
        const { sync } = makeOracleSync(0);
        sync.oracleBootstrapped  = true;
        sync.oracleSyncTimestamp = 2000;
        const got = await sync.waitForOracleSyncTimestamp(1500, 1000);
        assert.strictEqual(got, 2000);
    });

    it('waitForOracleSyncTimestamp is a no-op once the mirror is known to be empty (no FIAT oracles)', async function () {
        const { sync } = makeOracleSync(null);
        await sync.refreshOracleSyncTimestamp(true);  // full-drain path: empty table → bootstrapped, timestamp null
        // Must resolve immediately for any block time, otherwise non-oracle deployments stall.
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

function makeWatermarkSync() {
    const doQuery = sinon.stub().callsFake(async () => [{ h: 0 }]);
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
    sync.priceWatermarkGraceS  = 60;
    sync.oracleWatermarkGraceS = 60;
    sync.matchWatermarkGraceS  = 30;
    return sync;
}

describe('HubDbSync stream-position watermark @regression @tier3', function () {
    it('_advanceWatermark is monotonic and ignores junk', function () {
        const sync = makeWatermarkSync();
        sync.advanceWatermark(100);
        assert.strictEqual(sync.streamWatermark, 100);
        sync.advanceWatermark(50);                       // regression must not rewind
        assert.strictEqual(sync.streamWatermark, 100);
        sync.advanceWatermark('not-a-number');
        assert.strictEqual(sync.streamWatermark, 100);
        sync.advanceWatermark(150);
        assert.strictEqual(sync.streamWatermark, 150);
    });

    it('price barrier passes on an EMPTY mirror once the watermark clears blockTime+grace (#1986 bootstrap deadlock)', function () {
        const sync = makeWatermarkSync();
        sync.priceBootstrapped = true;
        sync.priceSyncHeight   = 0;                       // no rounds exist anywhere
        sync.streamWatermark   = 1000 + 60;
        assert.strictEqual(sync._priceSyncSatisfied(5, 1000), true);
    });

    it('price barrier still defers while the watermark is short of grace', function () {
        const sync = makeWatermarkSync();
        sync.priceBootstrapped = true;
        sync.streamWatermark   = 1000 + 59;
        assert.strictEqual(sync._priceSyncSatisfied(5, 1000), false);
    });

    it('price barrier ignores the watermark for legacy callers that pass no blockTime', function () {
        const sync = makeWatermarkSync();
        sync.priceBootstrapped = true;
        sync.streamWatermark   = 10_000_000;
        assert.strictEqual(sync._priceSyncSatisfied(5, undefined), false, 'row path only without blockTime');
        sync.priceSyncHeight = 5;
        assert.strictEqual(sync._priceSyncSatisfied(5, undefined), true);
    });

    it('oracle barrier releases a stale armed row via the watermark (#1984 deadlock)', function () {
        const sync = makeWatermarkSync();
        sync.oracleBootstrapped   = true;
        sync.oracleSyncTimestamp  = 500;                  // armed: newest row far behind the tip
        sync.streamWatermark      = 1000 + 60;
        assert.strictEqual(sync.oracleSyncSatisfied(1000), true);
        sync.streamWatermark      = 1000 + 59;
        assert.strictEqual(sync.oracleSyncSatisfied(1000), false, 'must defer until grace is covered');
    });

    it('match barrier releases a stale armed match via the watermark (#1984, not coin-scoped)', function () {
        const sync = makeWatermarkSync();
        sync.matchBootstrapped  = true;
        sync.matchSyncTimestamp = 500;
        sync.streamWatermark    = 1000 + 30;
        assert.strictEqual(sync.matchSyncSatisfied(1000), true);
        sync.streamWatermark    = 1000 + 29;
        assert.strictEqual(sync.matchSyncSatisfied(1000), false);
    });
});

describe('HubDbSync stream-position watermark @regression @tier3', function () {
    it('a watermark advance releases an in-flight oracle waiter without a new row', async function () {
        const sync = makeWatermarkSync();
        sync.oracleBootstrapped  = true;
        sync.oracleSyncTimestamp = 500;                   // armed
        const pending = sync.waitForOracleSyncTimestamp(1000, 5000);
        assert.strictEqual(sync._oracleWaiters.length, 1);
        sync.advanceWatermark(1000 + 60);                // heartbeat lands
        await pending;
        assert.strictEqual(sync._oracleWaiters.length, 0, 'waiter released by watermark, not by a row');
    });

    it('_bootstrapAll opens the heartbeat gate and adopts the OLDEST per-table watermark only when every table drains', async function () {
        const sync = makeWatermarkSync();
        const marks = { price_snapshots: 900, oracle_prices: 880, cross_chain_matches: 910, cross_chain_calls: 915, capability_snapshots: 905, state_checkpoints: 920, anchor_reward_attestations: 925, attestation_responses: 930, bridge_transfers: 935, policy_snapshots: 940 };
        sinon.stub(sync, '_bootstrapTable').callsFake(async (table) => marks[table]);
        await sync.bootstrapAll();
        assert.strictEqual(sync._bootstrapDrained, true);
        assert.strictEqual(sync.streamWatermark, 880, 'min across tables; no table may be certified past its own drain');
    });

    it('_bootstrapAll keeps the gate closed when any table fails to drain', async function () {
        const sync = makeWatermarkSync();
        sinon.stub(sync, '_bootstrapTable').callsFake(async (table) =>
            table === 'oracle_prices' ? null : 900);      // partial page / apply error
        await sync.bootstrapAll();
        assert.strictEqual(sync._bootstrapDrained, false);
        assert.strictEqual(sync.streamWatermark, 0, 'watermark must not advance on a partial drain');
    });

    it('_bootstrapAll drains price_snapshots LAST so every per-block barrier arms before the heavy table', async function () {
        // Regression for the cold-start stall: the heavy price_snapshots table must bootstrap
        // last so the empty-mirror fast paths for ALL per-block barriers that gate processing
        // (oracle, cross-chain match, cross-chain call, capability snapshot) arm in ~1s instead
        // of waiting out a multi-minute price_snapshots drain. Each barrier's no-op-on-empty
        // path needs its own <x>Bootstrapped flag, which only flips after that table drains;
        // serialized behind price_snapshots they all stay false and the indexer defers every
        // block 60s on the first unarmed barrier. Ordering price_snapshots merely after
        // oracle_prices only relocated the stall to the match barrier, so assert it is LAST.
        const sync = makeWatermarkSync();
        const order = [];
        sinon.stub(sync, '_bootstrapTable').callsFake(async (table) => { order.push(table); return 900; });
        await sync.bootstrapAll();
        const pi = order.indexOf('price_snapshots');
        assert.ok(pi !== -1, 'price_snapshots bootstrapped');
        assert.strictEqual(pi, order.length - 1, 'price_snapshots must bootstrap LAST (got ' + order.join(',') + ')');
        // The barrier-critical tables must all precede it (oracle + both cross-chain mirrors).
        for (const t of ['oracle_prices', 'cross_chain_matches', 'cross_chain_calls']) {
            const ti = order.indexOf(t);
            assert.ok(ti !== -1 && ti < pi, t + ' must bootstrap before price_snapshots (got ' + order.join(',') + ')');
        }
    });
});
