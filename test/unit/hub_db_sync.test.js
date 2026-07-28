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
        await sync._refreshAllSyncHeights();               // simulate the reconnect-edge refresh
        const got = await pending;
        assert.strictEqual(got, 150, 'waiter resolves from the mirror on reconnect, not the timeout');
        assert.strictEqual(sync._priceWaiters.length, 0, 'waiter cleared proactively');
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

    it('_refreshOracleSyncTimestamp adopts MAX(effective_at) and marks bootstrapped on the drain path', async function () {
        const { sync } = makeOracleSync(1700000000);
        await sync._refreshOracleSyncTimestamp(true);   // armBootstrap=true = the full-drain path
        assert.strictEqual(sync.oracleSyncTimestamp, 1700000000);
        assert.strictEqual(sync.oracleBootstrapped, true);
    });

    it('_refreshOracleSyncTimestamp records an empty mirror as null but still bootstrapped on the drain path', async function () {
        const { sync } = makeOracleSync(null);     // MAX over an empty table → null
        await sync._refreshOracleSyncTimestamp(true);
        assert.strictEqual(sync.oracleSyncTimestamp, null);
        assert.strictEqual(sync.oracleBootstrapped, true);
    });

    it('_refreshOracleSyncTimestamp does NOT arm when the bootstrap has not drained (#1788)', async function () {
        // Default armBootstrap = this._bootstrapDrained (false here): a reconnect
        // (_refreshAllSyncHeights before re-bootstrap) or a single live row mid-partial-
        // bootstrap updates the scalar but must NOT arm the empty-mirror fast path.
        const { sync } = makeOracleSync(null);
        assert.strictEqual(sync._bootstrapDrained, false);
        await sync._refreshOracleSyncTimestamp();       // no arg = the reconnect/live-row default
        assert.strictEqual(sync.oracleSyncTimestamp, null, 'scalar still refreshed');
        assert.strictEqual(sync.oracleBootstrapped, false, 'flag withheld until a full drain');
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
        await sync._refreshOracleSyncTimestamp(true);  // full-drain path: empty table → bootstrapped, timestamp null
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

describe('HubDbSync stream-position watermark @regression @tier3', function () {

    function makeWatermarkSync() {
        const doQuery = sinon.stub().callsFake(async () => [{ h: 0 }]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sync.priceWatermarkGraceS  = 60;
        sync.oracleWatermarkGraceS = 60;
        sync.matchWatermarkGraceS  = 30;
        return sync;
    }

    it('_advanceWatermark is monotonic and ignores junk', function () {
        const sync = makeWatermarkSync();
        sync._advanceWatermark(100);
        assert.strictEqual(sync.streamWatermark, 100);
        sync._advanceWatermark(50);                       // regression must not rewind
        assert.strictEqual(sync.streamWatermark, 100);
        sync._advanceWatermark('not-a-number');
        assert.strictEqual(sync.streamWatermark, 100);
        sync._advanceWatermark(150);
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
        assert.strictEqual(sync._oracleSyncSatisfied(1000), true);
        sync.streamWatermark      = 1000 + 59;
        assert.strictEqual(sync._oracleSyncSatisfied(1000), false, 'must defer until grace is covered');
    });

    it('match barrier releases a stale armed match via the watermark (#1984, not coin-scoped)', function () {
        const sync = makeWatermarkSync();
        sync.matchBootstrapped  = true;
        sync.matchSyncTimestamp = 500;
        sync.streamWatermark    = 1000 + 30;
        assert.strictEqual(sync._matchSyncSatisfied(1000), true);
        sync.streamWatermark    = 1000 + 29;
        assert.strictEqual(sync._matchSyncSatisfied(1000), false);
    });

    it('a watermark advance releases an in-flight oracle waiter without a new row', async function () {
        const sync = makeWatermarkSync();
        sync.oracleBootstrapped  = true;
        sync.oracleSyncTimestamp = 500;                   // armed
        const pending = sync.waitForOracleSyncTimestamp(1000, 5000);
        assert.strictEqual(sync._oracleWaiters.length, 1);
        sync._advanceWatermark(1000 + 60);                // heartbeat lands
        await pending;
        assert.strictEqual(sync._oracleWaiters.length, 0, 'waiter released by watermark, not by a row');
    });

    it('_bootstrapAll opens the heartbeat gate and adopts the OLDEST per-table watermark only when every table drains', async function () {
        const sync = makeWatermarkSync();
        const marks = { price_snapshots: 900, oracle_prices: 880, cross_chain_matches: 910, cross_chain_calls: 915, capability_snapshots: 905, state_checkpoints: 920, anchor_reward_attestations: 925 };
        sinon.stub(sync, '_bootstrapTable').callsFake(async (table) => marks[table]);
        await sync._bootstrapAll();
        assert.strictEqual(sync._bootstrapDrained, true);
        assert.strictEqual(sync.streamWatermark, 880, 'min across tables; no table may be certified past its own drain');
    });

    it('_bootstrapAll keeps the gate closed when any table fails to drain', async function () {
        const sync = makeWatermarkSync();
        sinon.stub(sync, '_bootstrapTable').callsFake(async (table) =>
            table === 'oracle_prices' ? null : 900);      // partial page / apply error
        await sync._bootstrapAll();
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
        await sync._bootstrapAll();
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

describe('HubDbSync bootstrap pagination + retry @regression @tier2', function () {

    // Regression (prod incident 2026-06-11): _bootstrapTable fetched ONE page and
    // treated a full page as "not drained", so a hub table larger than PAGE_LIMIT
    // (prod price_snapshots: 13k+ rows) could never drain; the heartbeat gate
    // never opened, the stream watermark froze at 0, and the BTC mainnet indexer
    // deferred every tip block in 60s loops (the watermark valve exists precisely
    // to break the indexer↔oracle-anchor deadlock at the tip). And in WS mode no
    // poll loop exists, so a partial bootstrap was never re-attempted either.

    const PAGE = 10000;

    function makeBootstrapSync() {
        const doQuery = sinon.stub().resolves([{ max_id: null }]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', pollInterval: 50 });
        sinon.stub(sync, '_applyRow').resolves();
        sinon.stub(sync, '_refreshPriceSyncHeight').resolves();
        sinon.stub(sync, '_refreshOracleSyncTimestamp').resolves();
        sinon.stub(sync, '_refreshMatchSyncTimestamp').resolves();
        sinon.stub(sync, '_releaseSnapshotWaiters').resolves();
        return sync;
    }

    function fullPage(startId) {
        return Array.from({ length: PAGE }, (_, i) => ({ id: startId + i }));
    }

    it('paginates past a full page and drains with the last page watermark', async function () {
        const sync = makeBootstrapSync();
        const httpGet = sinon.stub(sync, '_httpGet');
        httpGet.onCall(0).resolves({ rows: fullPage(1),        watermark: 111 });
        httpGet.onCall(1).resolves({ rows: [{ id: PAGE + 1 }], watermark: 222 });

        const mark = await sync._bootstrapTable('price_snapshots');
        assert.strictEqual(mark, 222, 'must drain and return the LAST page watermark');
        assert.strictEqual(httpGet.callCount, 2);
        assert.ok(httpGet.secondCall.args[0].includes('since_id=' + PAGE),
            'second page must resume from the first page cursor: ' + httpGet.secondCall.args[0]);
        assert.strictEqual(sync._applyRow.callCount, PAGE + 1, 'every row from every page applied');
    });

    it('a single short page still drains in one fetch', async function () {
        const sync = makeBootstrapSync();
        sinon.stub(sync, '_httpGet').resolves({ rows: [{ id: 1 }, { id: 2 }], watermark: 99 });
        assert.strictEqual(await sync._bootstrapTable('oracle_prices'), 99);
    });

    // #2270: capability_snapshots is a natural-key mirror. Local ids are locally
    // assigned (recovery rebuilds id-less; hub ids are hub-local), so seeding the
    // cursor from local MAX(id) silently skips hub rows, and applying a wire id
    // collides with a local PK where INSERT IGNORE drops the row.
    it('capability_snapshots bootstraps from since_id=0 regardless of local MAX(id) (#2270)', async function () {
        const sync = makeBootstrapSync();
        sinon.stub(sync, '_localColumns').resolves(new Set(['id', 'snapshot_block']));
        sync.hubDb.doQuery = sinon.stub().resolves([{ max_id: 500 }]);   // local rows exist
        const httpGet = sinon.stub(sync, '_httpGet').resolves({ rows: [{ id: 3 }], watermark: 7 });
        assert.strictEqual(await sync._bootstrapTable('capability_snapshots'), 7);
        assert.ok(httpGet.firstCall.args[0].includes('since_id=0'),
            'must page from 0, not local MAX(id): ' + httpGet.firstCall.args[0]);
    });

    // #2491: the three in-place-UPGRADED tables must ALSO bootstrap from since_id=0, so a row
    // upgraded on the hub under its unchanged id (price_snapshots skipped->finalized,
    // cross_chain_calls re-finalized, cross_chain_matches anchor_txid) while this mirror was
    // disconnected is re-delivered and converged by its idempotent _applyRow ODKU. A
    // since_id=MAX(local id) cursor is INSERT-shaped and would strand the pre-upgrade row.
    ['price_snapshots', 'cross_chain_calls', 'cross_chain_matches'].forEach((table) => {
        it(`${table} bootstraps from since_id=0 regardless of local MAX(id) to re-fetch in-place upgrades (#2491)`, async function () {
            const sync = makeBootstrapSync();
            sinon.stub(sync, '_localColumns').resolves(new Set(['id', 'status']));
            sync.hubDb.doQuery = sinon.stub().resolves([{ max_id: 500 }]);   // local rows already present
            const httpGet = sinon.stub(sync, '_httpGet').resolves({ rows: [{ id: 3 }], watermark: 7 });
            await sync._bootstrapTable(table);
            assert.ok(httpGet.firstCall.args[0].includes('since_id=0'),
                `${table} must page from 0, not local MAX(id): ` + httpGet.firstCall.args[0]);
        });
    });

    // #3211, the half no ODKU can reach: the hub's snapshot endpoint filters
    // `status <> 'retracted'`, so a match retracted while this mirror was disconnected is
    // ABSENT from every bootstrap page. There is no row to converge against, and the stale
    // local copy keeps settling a match the hub retracted. After a COMPLETE re-page, a local
    // finalized row at or below the highest served id whose match_id was never served can
    // only be such a retraction (hub-parity ascending ids; the hub never deletes a match).
    describe('cross_chain_matches missed-retraction reconciliation (#3211)', function () {

        // hubDb stub: local finalized rows for the reconciliation read, capturing UPDATEs.
        function makeReconcileSync(localRows) {
            const sync = makeBootstrapSync();
            const updates = [];
            sync.hubDb.doQuery = sinon.stub().callsFake(async (sql, args) => {
                if (/^SELECT id, match_id FROM cross_chain_matches/.test(sql)) {
                    return localRows.filter(r => Number(r.id) <= Number(args[0]));
                }
                if (/^UPDATE cross_chain_matches SET status = 'retracted'/.test(sql)) { updates.push(args); return []; }
                return [{ max_id: null }];
            });
            return { sync, updates };
        }

        it('marks a local finalized row the hub no longer serves as retracted', async function () {
            const { sync, updates } = makeReconcileSync([{ id: 1, match_id: 'M1' }, { id: 2, match_id: 'GONE' }, { id: 3, match_id: 'M3' }]);
            sinon.stub(sync, '_httpGet').resolves({ rows: [{ id: 1, match_id: 'M1' }, { id: 3, match_id: 'M3' }], watermark: 7 });
            await sync._bootstrapTable('cross_chain_matches');
            assert.deepStrictEqual(updates, [[2]], 'only the unserved row converges');
        });

        it('never touches a row ABOVE the highest served id (it may just be newer than the snapshot)', async function () {
            const { sync, updates } = makeReconcileSync([{ id: 3, match_id: 'M3' }, { id: 9, match_id: 'NEWER' }]);
            sinon.stub(sync, '_httpGet').resolves({ rows: [{ id: 3, match_id: 'M3' }], watermark: 7 });
            await sync._bootstrapTable('cross_chain_matches');
            assert.deepStrictEqual(updates, [], 'a row past the served ceiling is exempt');
        });

        it('does NOT reconcile on a partial drain (an unfetched page is not evidence of a retraction)', async function () {
            const { sync, updates } = makeReconcileSync([{ id: 1, match_id: 'M1' }, { id: 2, match_id: 'UNSEEN' }]);
            // A full page means more rows remain; the loop stops on the apply hole below.
            sync._applyRow.onSecondCall().rejects(new Error('ER_SOMETHING'));
            sinon.stub(sync, '_httpGet').resolves({ rows: [{ id: 1, match_id: 'M1' }, { id: 2, match_id: 'X' }], watermark: 7 });
            await sync._bootstrapTable('cross_chain_matches');
            assert.deepStrictEqual(updates, [], 'a holed/partial drain must never reconcile');
        });

        it('is a no-op when the hub served nothing at all (empty mirror, no ceiling to judge against)', async function () {
            const { sync, updates } = makeReconcileSync([{ id: 1, match_id: 'M1' }]);
            sinon.stub(sync, '_httpGet').resolves({ rows: [], watermark: 7 });
            await sync._bootstrapTable('cross_chain_matches');
            assert.deepStrictEqual(updates, []);
        });

        it('runs for cross_chain_matches only, never for a sibling mirror table', async function () {
            for (const table of ['cross_chain_calls', 'price_snapshots', 'capability_snapshots']) {
                const { sync, updates } = makeReconcileSync([{ id: 2, match_id: 'GONE' }]);
                sinon.stub(sync, '_httpGet').resolves({ rows: [{ id: 1 }, { id: 3 }], watermark: 7 });
                await sync._bootstrapTable(table);
                assert.deepStrictEqual(updates, [], table + ' must not run the match reconciliation');
            }
        });
    });

    it('_applyRow strips the wire id for capability_snapshots so a local PK can never collide (#2270)', async function () {
        const doQuery = sinon.stub().resolves([]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sinon.stub(sync, '_localColumns').resolves(
            new Set(['id', 'snapshot_block', 'capability', 'signing_pubkey', 'amount', 'source']));
        await sync._applyRow('capability_snapshots',
            { id: 42, snapshot_block: 1, capability: 'cross_chain', signing_pubkey: 'aa', amount: '10', source: 's1' });
        const [query, args] = doQuery.firstCall.args;
        const colList = query.slice(query.indexOf('(') + 1, query.indexOf(')'));
        assert.ok(!colList.split(',').map(c => c.trim()).includes('id'),
            'id must not be inserted: ' + query);
        assert.ok(!args.includes(42), 'wire id must not ride the args');
    });

    it('returns null (gate closed) when any row fails to apply, even after paging', async function () {
        const sync = makeBootstrapSync();
        sync._applyRow.onFirstCall().rejects(new Error('ER_SOMETHING'));
        const httpGet = sinon.stub(sync, '_httpGet');
        httpGet.onCall(0).resolves({ rows: fullPage(1),        watermark: 111 });
        httpGet.onCall(1).resolves({ rows: [{ id: PAGE + 1 }], watermark: 222 });
        assert.strictEqual(await sync._bootstrapTable('price_snapshots'), null);
    });

    it('a partial bootstrap schedules a retry (WS mode has no poll loop)', async function () {
        const clock = sinon.useFakeTimers();
        try {
            const sync = makeBootstrapSync();
            sync.running = true;
            const bootstrapTable = sinon.stub(sync, '_bootstrapTable');
            bootstrapTable.onCall(0).resolves(null);    // price_snapshots fails round 1
            bootstrapTable.resolves(123);               // everything drains afterwards

            await sync._bootstrapAll();
            assert.strictEqual(sync._bootstrapDrained, false, 'gate closed after partial drain');

            await clock.tickAsync(sync.pollIntervalMs + 1);
            assert.strictEqual(sync._bootstrapDrained, true, 'retry must re-attempt and open the gate');
            assert.strictEqual(sync.streamWatermark, 123);
        } finally {
            clock.restore();
        }
    });

    it('does not schedule retries once drained or when stopped', async function () {
        const clock = sinon.useFakeTimers();
        try {
            const sync = makeBootstrapSync();
            sync.running = false;                       // stopped: no retry even on failure
            const bootstrapTable = sinon.stub(sync, '_bootstrapTable').resolves(null);
            await sync._bootstrapAll();
            await clock.tickAsync(sync.pollIntervalMs * 3);
            assert.strictEqual(bootstrapTable.callCount, 7, 'one pass over the 7 mirrored tables, no retries');
        } finally {
            clock.restore();
        }
    });
});

describe('HubDbSync _applyRow column filtering @regression @tier2', function () {

    // Regression (fleet incident 2026-06-11): the hub's state_checkpoints gained
    // the anchor_txid audit column (ANCHOR rollout) which the indexer-side mirror
    // schema deliberately omits; the unfiltered INSERT turned every mirrored
    // checkpoint into ER_BAD_FIELD_ERROR and silently killed the mirror fleet-wide.
    // _applyRow must drop hub-served columns the local table does not carry.

    function makeApplySync(localCols) {
        const doQuery = sinon.stub();
        doQuery.withArgs(sinon.match(/^SHOW COLUMNS/)).resolves(localCols.map(f => ({ Field: f })));
        doQuery.resolves([]); // default for the INSERT
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        return { sync, doQuery };
    }

    it('drops hub-only columns (anchor_txid) instead of erroring', async function () {
        const { sync, doQuery } = makeApplySync(['id', 'chain', 'block_index']);
        await sync._applyRow('state_checkpoints', { id: 1, chain: 'LTC', block_index: 5, anchor_txid: 'ff' });
        const insert = doQuery.getCalls().find(c => /^INSERT IGNORE/.test(c.args[0]));
        assert.ok(insert, 'INSERT must still run');
        assert.ok(!insert.args[0].includes('anchor_txid'), 'hub-only column must be filtered out');
        assert.deepStrictEqual(insert.args[1], [1, 'LTC', 5]);
    });

    it('passes through rows whose columns all exist locally', async function () {
        const { sync, doQuery } = makeApplySync(['id', 'chain']);
        await sync._applyRow('state_checkpoints', { id: 2, chain: 'BTC' });
        const insert = doQuery.getCalls().find(c => /^INSERT IGNORE/.test(c.args[0]));
        assert.ok(insert.args[0].includes('(id, chain)'));
    });

    it('no-ops when nothing intersects the local schema', async function () {
        const { sync, doQuery } = makeApplySync(['id']);
        await sync._applyRow('state_checkpoints', { mystery: 'x' });
        assert.ok(!doQuery.getCalls().some(c => /^INSERT/.test(c.args[0])), 'no INSERT for an empty column set');
    });

    it('caches the local column set per table (one SHOW COLUMNS per table)', async function () {
        const { sync, doQuery } = makeApplySync(['id']);
        await sync._applyRow('state_checkpoints', { id: 1 });
        await sync._applyRow('state_checkpoints', { id: 2 });
        const shows = doQuery.getCalls().filter(c => /^SHOW COLUMNS/.test(c.args[0]));
        assert.strictEqual(shows.length, 1);
    });
});

describe('HubDbSync _applyRow price_snapshots skipped→finalized upgrade @regression @tier2', function () {

    // The hub upserts a 'skipped' placeholder round to 'finalized' when a peer
    // chain salvages it (PriceAggregator.receiveValidatedRound) and broadcasts the
    // row. A plain INSERT IGNORE on the mirror would drop that upgrade and strand
    // the replica at price=NULL. _applyRow must upgrade in place, keyed on the
    // INCOMING status, and never clobber an already-finalized local row.

    const PS_COLS = ['id', 'round_number', 'coin_pair', 'price', 'reference_block',
                     'reference_chain', 'block_timestamp', 'validator_count',
                     'consensus_round', 'consensus_proof', 'status', 'source_chain',
                     'source_action_index', 'created_at'];

    function makeApplySync(localCols) {
        const doQuery = sinon.stub();
        doQuery.withArgs(sinon.match(/^SHOW COLUMNS/)).resolves(localCols.map(f => ({ Field: f })));
        doQuery.resolves([]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        return { sync, doQuery };
    }

    function finalizedRow() {
        return { id: 100, round_number: 5, coin_pair: 'BTC/USD', price: '50000',
                 reference_block: 800000, reference_chain: 'BTC', block_timestamp: 1700000000,
                 validator_count: 3, consensus_round: 1, consensus_proof: '[]',
                 status: 'finalized', source_chain: 'DOGE', source_action_index: 42,
                 created_at: '2026-06-14 00:00:00' };
    }

    it('uses an ON DUPLICATE KEY UPDATE upsert (not INSERT IGNORE) for price_snapshots', async function () {
        const { sync, doQuery } = makeApplySync(PS_COLS);
        await sync._applyRow('price_snapshots', finalizedRow());
        const insert = doQuery.getCalls().find(c => /price_snapshots/.test(c.args[0]) && /INSERT/.test(c.args[0]));
        assert.ok(insert, 'an INSERT must run');
        assert.ok(/ON DUPLICATE KEY UPDATE/.test(insert.args[0]), 'must be an upsert');
        assert.ok(!/^INSERT IGNORE/.test(insert.args[0]), 'must NOT be a plain INSERT IGNORE');
    });

    it('guards every column on VALUES(status)=finalized and never reassigns the unique-key columns', async function () {
        const { sync, doQuery } = makeApplySync(PS_COLS);
        await sync._applyRow('price_snapshots', finalizedRow());
        const sql = doQuery.getCalls().find(c => /ON DUPLICATE KEY UPDATE/.test(c.args[0])).args[0];
        // price upgrades only when the incoming row is finalized
        assert.ok(/`price` = IF\(VALUES\(status\) = 'finalized', VALUES\(`price`\), `price`\)/.test(sql));
        // status flips to finalized only for an incoming finalized row
        assert.ok(/status = IF\(VALUES\(status\) = 'finalized', 'finalized', status\)/.test(sql));
        // the unique key + PK are never reassigned in the UPDATE clause
        const updateClause = sql.split('ON DUPLICATE KEY UPDATE')[1];
        assert.ok(!/`round_number` =/.test(updateClause));
        assert.ok(!/`coin_pair` =/.test(updateClause));
        assert.ok(!/`id` =/.test(updateClause));
    });

    it('still filters hub-only columns the local mirror does not carry', async function () {
        const { sync, doQuery } = makeApplySync(['round_number', 'coin_pair', 'price', 'status']);
        let row = finalizedRow();
        row.hub_only_audit = 'xyz';
        await sync._applyRow('price_snapshots', row);
        const sql = doQuery.getCalls().find(c => /INSERT/.test(c.args[0])).args[0];
        assert.ok(!sql.includes('hub_only_audit'), 'unknown column dropped');
        assert.ok(/ON DUPLICATE KEY UPDATE/.test(sql));
    });

    it('falls back to INSERT IGNORE if the row carries no status column', async function () {
        const { sync, doQuery } = makeApplySync(['round_number', 'coin_pair']);
        await sync._applyRow('price_snapshots', { round_number: 5, coin_pair: 'BTC/USD' });
        const insert = doQuery.getCalls().find(c => /INSERT/.test(c.args[0]));
        assert.ok(/^INSERT IGNORE/.test(insert.args[0]), 'no status → plain idempotent insert');
    });
});

describe('HubDbSync _applyRow oracle_prices generation upgrade @regression @tier2', function () {

    // A source-chain reorg re-mines a PRICE at a RECYCLED action_index (getNextActionIndex
    // assigns MAX+1 over survivors) and re-publishes it with a BUMPED push_generation. A
    // plain INSERT IGNORE on the mirror would no-op against the stale lower-generation row,
    // leaving push_generation old, so the generation-fenced retraction (push_generation <=
    // pre-bump) then deletes the freshly re-published row and the price goes permanently
    // missing on this replica. _applyRow must upgrade in place keyed on push_generation,
    // mirroring the price_snapshots / cross_chain_calls upgrade paths.

    const OP_COLS = ['id', 'source_chain', 'action_index', 'coin', 'tick', 'fiat',
                     'value', 'push_generation', 'created_at'];

    function makeApplySync(localCols) {
        const doQuery = sinon.stub();
        doQuery.withArgs(sinon.match(/^SHOW COLUMNS/)).resolves(localCols.map(f => ({ Field: f })));
        doQuery.resolves([]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        return { sync, doQuery };
    }

    function oracleRow(gen) {
        return { id: 7, source_chain: 'LTC', action_index: 42, coin: 'LTC', tick: 'XCP',
                 fiat: 'USD', value: '1.23', push_generation: gen, created_at: '2026-06-25 00:00:00' };
    }

    it('uses an ON DUPLICATE KEY UPDATE upsert (not INSERT IGNORE) for oracle_prices', async function () {
        const { sync, doQuery } = makeApplySync(OP_COLS);
        await sync._applyRow('oracle_prices', oracleRow(1));
        const insert = doQuery.getCalls().find(c => /oracle_prices/.test(c.args[0]) && /INSERT/.test(c.args[0]));
        assert.ok(insert, 'an INSERT must run');
        assert.ok(/ON DUPLICATE KEY UPDATE/.test(insert.args[0]), 'must be an upsert');
        assert.ok(!/^INSERT IGNORE/.test(insert.args[0]), 'must NOT be a plain INSERT IGNORE');
    });

    it('guards every column on VALUES(push_generation) >= push_generation and never reassigns the unique-key columns', async function () {
        const { sync, doQuery } = makeApplySync(OP_COLS);
        await sync._applyRow('oracle_prices', oracleRow(1));
        const sql = doQuery.getCalls().find(c => /ON DUPLICATE KEY UPDATE/.test(c.args[0])).args[0];
        // a payload column upgrades only when the incoming generation wins
        assert.ok(/`value` = IF\(VALUES\(`push_generation`\) >= `push_generation`, VALUES\(`value`\), `value`\)/.test(sql));
        // push_generation itself is lifted on the same condition
        assert.ok(/push_generation = IF\(VALUES\(`push_generation`\) >= `push_generation`, VALUES\(`push_generation`\), `push_generation`\)/.test(sql));
        // the unique key (source_chain, action_index) + PK id are never reassigned
        const updateClause = sql.split('ON DUPLICATE KEY UPDATE')[1];
        assert.ok(!/`source_chain` =/.test(updateClause));
        assert.ok(!/`action_index` =/.test(updateClause));
        assert.ok(!/`id` =/.test(updateClause));
    });

    it('still filters hub-only columns the local mirror does not carry', async function () {
        const { sync, doQuery } = makeApplySync(['source_chain', 'action_index', 'value', 'push_generation']);
        let row = oracleRow(2);
        row.hub_only_audit = 'xyz';
        await sync._applyRow('oracle_prices', row);
        const sql = doQuery.getCalls().find(c => /INSERT/.test(c.args[0])).args[0];
        assert.ok(!sql.includes('hub_only_audit'), 'unknown column dropped');
        assert.ok(/ON DUPLICATE KEY UPDATE/.test(sql));
    });

    it('falls back to INSERT IGNORE if the row carries no push_generation column', async function () {
        const { sync, doQuery } = makeApplySync(['source_chain', 'action_index', 'value']);
        await sync._applyRow('oracle_prices', { source_chain: 'LTC', action_index: 42, value: '1.23' });
        const insert = doQuery.getCalls().find(c => /INSERT/.test(c.args[0]));
        assert.ok(/^INSERT IGNORE/.test(insert.args[0]), 'no push_generation → plain idempotent insert');
    });
});

describe('HubDbSync _applyRow cross_chain_matches convergence upgrade @regression @tier2', function () {

    // Two mutations reach a mirrored match after its first delivery:
    //  1. anchor_txid, stamped later by the ANCHOR v1 archive
    //     (StateAnchorPublisher._backfillBatch) and re-broadcast. A plain INSERT IGNORE
    //     would no-op and leave anchor_txid NULL on streamed mirrors while a fresh REST
    //     bootstrap serves the stamp (divergent mirrors). First-stamp-wins COALESCE.
    //  2. RETRACT -> REVIVE (#3211): a source-chain reorg retracts the crossing (mirrored
    //     as a DELETE); the same crossing re-forms at the same snapshot_block, so
    //     _deriveMatchId yields the identical match_id and the hub revives the row with a
    //     NEW effective_time / finalizing_view / validator_signatures. A mirror that missed
    //     the deletion (disconnected, or the / guards refused the event) kept
    //     the pre-reorg row, and an anchor_txid-only ODKU could never converge it - not on
    //     the live re-broadcast and not on the FULL_REPAGE bootstrap, which re-delivers
    //     through this same path. effective_time GATES the settlement block, so the mirror
    //     stayed permanently, money-bearingly divergent from a mirror-fed peer.
    // The upgrade must be ORDERING-INDEPENDENT: judged per row against the local version
    // (effective_time, then finalized-before-retracted at a tie), so a late/duplicate/
    // out-of-order delivery is a no-op instead of a regression.

    const CM_COLS = ['id', 'match_id', 'snapshot_block', 'network', 'a_chain', 'a_amount',
                     'b_chain', 'b_amount', 'effective_time', 'finalizing_view', 'status',
                     'validator_signatures', 'batch_root', 'anchor_txid',
                     'a_push_generation', 'b_push_generation', 'created_at'];

    function makeApplySync(localCols) {
        const doQuery = sinon.stub();
        doQuery.withArgs(sinon.match(/^SHOW COLUMNS/)).resolves(localCols.map(f => ({ Field: f })));
        doQuery.resolves([]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        return { sync, doQuery };
    }

    function matchRow(txid) {
        return { id: 12, match_id: 'a'.repeat(64), snapshot_block: 900, network: 'regtest',
                 a_chain: 'BTC', a_amount: '1', b_chain: 'DOGE', b_amount: '2',
                 effective_time: 1700000000, finalizing_view: 0,
                 status: 'finalized', validator_signatures: '[]',
                 batch_root: null, anchor_txid: txid,
                 a_push_generation: 3, b_push_generation: 4, created_at: '2026-07-06 00:00:00' };
    }

    const updateClauseOf = (doQuery) =>
        doQuery.getCalls().find(c => /ON DUPLICATE KEY UPDATE/.test(c.args[0])).args[0].split('ON DUPLICATE KEY UPDATE')[1];

    it('uses an ON DUPLICATE KEY UPDATE upsert (not INSERT IGNORE) for cross_chain_matches', async function () {
        const { sync, doQuery } = makeApplySync(CM_COLS);
        await sync._applyRow('cross_chain_matches', matchRow('d0ge'.repeat(16)));
        const insert = doQuery.getCalls().find(c => /cross_chain_matches/.test(c.args[0]) && /INSERT/.test(c.args[0]));
        assert.ok(insert, 'an INSERT must run');
        assert.ok(/ON DUPLICATE KEY UPDATE/.test(insert.args[0]), 'must be an upsert');
        assert.ok(!/^INSERT IGNORE/.test(insert.args[0]), 'must NOT be a plain INSERT IGNORE');
    });

    it('converges the revive content on a version gate, so a missed retract/revive cannot strand the mirror (#3211)', async function () {
        const { sync, doQuery } = makeApplySync(CM_COLS);
        await sync._applyRow('cross_chain_matches', matchRow('d0ge'.repeat(16)));
        const clause = updateClauseOf(doQuery);
        // The gate: strictly newer effective_time wins; at a tie the non-finalized
        // (retracted) version wins, because a retraction leaves effective_time untouched
        // while a revive always stamps a later one. `>=` keeps re-delivery idempotent.
        const gate = /VALUES\(`effective_time`\) > `effective_time` OR \(VALUES\(`effective_time`\) = `effective_time` AND IF\(VALUES\(`status`\) = 'finalized', 0, 1\) >= IF\(`status` = 'finalized', 0, 1\)\)/;
        assert.ok(gate.test(clause), 'ordering-independent version gate missing:\n' + clause);
        // The money-bearing columns move under that gate, and ONLY under it.
        for (const col of ['effective_time', 'finalizing_view', 'validator_signatures', 'status']) {
            assert.ok(new RegExp('`' + col + '` = IF\\(\\(VALUES').test(clause), col + ' must upgrade under the version gate');
        }
    });

    it('assigns status then effective_time LAST, because MariaDB evaluates the SET list left to right', async function () {
        // Load-bearing, and caught only by running it: MariaDB reads the ALREADY-UPDATED
        // value in a later ODKU assignment. With effective_time assigned in plain column
        // order, a strictly-newer REVIVE lifted it first, every later column then saw a tie
        // against itself, and status stayed 'retracted' while the content moved - a
        // half-applied row. Assigning the two gate columns last (status, then effective_time)
        // makes every assignment agree on one verdict. Verified end-to-end against MariaDB.
        const { sync, doQuery } = makeApplySync(CM_COLS);
        await sync._applyRow('cross_chain_matches', matchRow('d0ge'.repeat(16)));
        const clause = updateClauseOf(doQuery);
        const gatedOrder = CM_COLS.filter(c => new RegExp('`' + c + '` = IF\\(\\(VALUES').test(clause))
            .sort((a, b) => clause.indexOf('`' + a + '` = IF((VALUES') - clause.indexOf('`' + b + '` = IF((VALUES'));
        assert.deepStrictEqual(gatedOrder.slice(-2), ['status', 'effective_time'],
            'the two columns the version gate READS must be the last two gated assignments, in this order');
    });

    it('never reassigns the row key or the hub id, and keeps anchor_txid first-stamp-wins', async function () {
        const { sync, doQuery } = makeApplySync(CM_COLS);
        await sync._applyRow('cross_chain_matches', matchRow('d0ge'.repeat(16)));
        const clause = updateClauseOf(doQuery);
        assert.ok(/anchor_txid = COALESCE\(anchor_txid, VALUES\(anchor_txid\)\)/.test(clause),
            'anchor_txid stays first-stamp-wins, outside the version gate');
        // match_id is the unique key and id is the hub-parity PK: reassigning either would
        // move the row, not upgrade it.
        assert.ok(!/`match_id` =/.test(clause), 'match_id must not be reassigned');
        assert.ok(!/`id` =/.test(clause), 'id must not be reassigned');
        // anchor_txid must not ALSO ride the version gate (that would let a later revive
        // clear an already-stamped txid back to NULL).
        assert.ok(!/`anchor_txid` = IF\(/.test(clause), 'anchor_txid must not ride the version gate');
    });

    it('the per-leg reorg fences only ever move UP (a lowered fence would invite a stale delete)', async function () {
        const { sync, doQuery } = makeApplySync(CM_COLS);
        await sync._applyRow('cross_chain_matches', matchRow(null));
        const clause = updateClauseOf(doQuery);
        for (const col of ['a_push_generation', 'b_push_generation']) {
            assert.ok(new RegExp('`' + col + '` = GREATEST\\(COALESCE\\(`' + col + '`, 0\\), COALESCE\\(VALUES\\(`' + col + '`\\), 0\\)\\)').test(clause),
                col + ' must be monotonic (GREATEST), not gated');
            assert.ok(!new RegExp('`' + col + '` = IF\\(').test(clause), col + ' must not ride the version gate');
        }
    });

    it('re-delivery of an unstamped row is a no-op against a stamped local row', async function () {
        const { sync, doQuery } = makeApplySync(CM_COLS);
        await sync._applyRow('cross_chain_matches', matchRow(null));
        const sql = doQuery.getCalls().find(c => /ON DUPLICATE KEY UPDATE/.test(c.args[0])).args[0];
        // COALESCE(anchor_txid, VALUES(anchor_txid)): local non-NULL wins, and a NULL
        // incoming value cannot regress it; the branch itself is what guarantees this,
        // the SQL shape is asserted here.
        assert.ok(/COALESCE\(anchor_txid, VALUES\(anchor_txid\)\)/.test(sql));
    });

    it('still filters hub-only columns the local mirror does not carry', async function () {
        const { sync, doQuery } = makeApplySync(['match_id', 'effective_time', 'status', 'anchor_txid']);
        let row = matchRow('ff00'.repeat(16));
        row.batch_seq = 7;             // hub-side-only archive bookkeeping
        row.archived_status = 'finalized';
        await sync._applyRow('cross_chain_matches', row);
        const sql = doQuery.getCalls().find(c => /INSERT/.test(c.args[0])).args[0];
        assert.ok(!sql.includes('batch_seq'), 'hub-only column dropped');
        assert.ok(!sql.includes('archived_status'), 'hub-only column dropped');
        assert.ok(/ON DUPLICATE KEY UPDATE/.test(sql));
    });

    it('falls back to the anchor-stamp-only upgrade when the row carries no version columns (older hub)', async function () {
        const { sync, doQuery } = makeApplySync(['match_id', 'status', 'anchor_txid']);
        await sync._applyRow('cross_chain_matches', { match_id: 'b'.repeat(64), status: 'finalized', anchor_txid: 'ab'.repeat(32) });
        const clause = updateClauseOf(doQuery);
        // With no effective_time there is no version to compare, so never guess: keep the
        // narrow stamp upgrade rather than clobbering content on an unordered feed.
        assert.strictEqual(clause.trim(), 'anchor_txid = COALESCE(anchor_txid, VALUES(anchor_txid))');
    });

    it('falls back to INSERT IGNORE if the row carries no anchor_txid column', async function () {
        const { sync, doQuery } = makeApplySync(['match_id', 'status']);
        await sync._applyRow('cross_chain_matches', { match_id: 'b'.repeat(64), status: 'finalized' });
        const insert = doQuery.getCalls().find(c => /INSERT/.test(c.args[0]));
        assert.ok(/^INSERT IGNORE/.test(insert.args[0]), 'no anchor_txid → plain idempotent insert');
    });
});

describe('HubDbSync _applyRow datetime coercion @regression @tier2', function () {

    // Regression (fleet incident 2026-06-16): the hub serves rows as JSON, so a
    // DATETIME column (price_snapshots.created_at) arrives as an ISO-8601 string
    // ('2026-06-16T10:33:01.000Z'). MariaDB strict mode rejects the 'T'/'Z' form
    // for a DATETIME column (ER_TRUNCATED_WRONG_VALUE, 22007) and silently kills
    // the mirror; BTC indexers stalled at 'price mirror at 0' once the oracle
    // resumed finalizing rounds. _applyRow must reformat ISO datetimes to MySQL
    // 'YYYY-MM-DD HH:MM:SS' (UTC) and leave every other value untouched.

    function makeApplySync(localCols) {
        const doQuery = sinon.stub();
        doQuery.withArgs(sinon.match(/^SHOW COLUMNS/)).resolves(localCols.map(f => ({ Field: f })));
        doQuery.resolves([]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        return { sync, doQuery };
    }

    function argFor(doQuery, table, col, cols) {
        const insert = doQuery.getCalls().find(c => /INSERT/.test(c.args[0]) && c.args[0].includes(table));
        return insert.args[1][cols.indexOf(col)];
    }

    it('reformats an ISO-8601 created_at (T/Z) to MySQL DATETIME', async function () {
        const cols = ['round_number', 'coin_pair', 'status', 'created_at'];
        const { sync, doQuery } = makeApplySync(cols);
        await sync._applyRow('price_snapshots',
            { round_number: 5, coin_pair: 'BTC/USD', status: 'finalized', created_at: '2026-06-16T10:33:01.000Z' });
        assert.strictEqual(argFor(doQuery, 'price_snapshots', 'created_at', cols), '2026-06-16 10:33:01');
    });

    it('normalizes a non-UTC offset to UTC wall-clock', async function () {
        const cols = ['id', 'created_at'];
        const { sync, doQuery } = makeApplySync(cols);
        await sync._applyRow('oracle_prices', { id: 1, created_at: '2026-06-16T12:33:01+02:00' });
        assert.strictEqual(argFor(doQuery, 'oracle_prices', 'created_at', cols), '2026-06-16 10:33:01');
    });

    it('leaves an already-MySQL-format datetime untouched', async function () {
        const cols = ['id', 'created_at'];
        const { sync, doQuery } = makeApplySync(cols);
        await sync._applyRow('oracle_prices', { id: 1, created_at: '2026-06-14 00:00:00' });
        assert.strictEqual(argFor(doQuery, 'oracle_prices', 'created_at', cols), '2026-06-14 00:00:00');
    });

    it('does not mangle non-datetime string columns (hashes, ticks)', async function () {
        const cols = ['coin_pair', 'consensus_proof'];
        const { sync, doQuery } = makeApplySync(cols);
        const proof = '[{"pubkey":"4a523cf4ae4f","sig":"deadbeef"}]';
        await sync._applyRow('oracle_prices', { coin_pair: 'BTC/USD', consensus_proof: proof });
        assert.strictEqual(argFor(doQuery, 'oracle_prices', 'coin_pair', cols), 'BTC/USD');
        assert.strictEqual(argFor(doQuery, 'oracle_prices', 'consensus_proof', cols), proof);
    });

    it('passes numeric and null values through unchanged', async function () {
        const cols = ['reference_block', 'price'];
        const { sync, doQuery } = makeApplySync(cols);
        await sync._applyRow('oracle_prices', { reference_block: 800000, price: null });
        assert.strictEqual(argFor(doQuery, 'oracle_prices', 'reference_block', cols), 800000);
        assert.strictEqual(argFor(doQuery, 'oracle_prices', 'price', cols), null);
    });
});

describe('HubDbSync mirror-table cold-start (missing table) @regression @tier2', function () {

    // Prod rollout abort 2026-06-17: on a fresh `reset`, hub_db_sync began
    // bootstrapping before the indexer's verifyTables() had created price_snapshots.
    // doQuery swallows the 1146 (missing table) for non-transactional reads and
    // returns [], so _localColumns cached an EMPTY column set for the whole process
    // lifetime; every _applyRow then filtered to zero columns and silently no-op'd
    // (while still counting the row as "applied", hence "bootstrapped 44614 rows"),
    // the mirror stayed at 0, and the BTC-only price barrier deferred every block
    // until a process restart. The fix: never cache an empty/failed column lookup,
    // and bail-to-retry instead of poisoning the mirror.

    it('_localColumns refuses to cache an empty column set and throws (table not ready)', async function () {
        const doQuery = sinon.stub().resolves([]);              // SHOW COLUMNS on a missing table
        const sync = new HubDbSync({ doQuery }, {});
        await assert.rejects(() => sync._localColumns('price_snapshots'), /not available yet/);
        assert.ok(!sync._localColumnCache || !sync._localColumnCache['price_snapshots'],
            'an empty/failed lookup must NOT be cached (else it poisons the mirror until restart)');
    });

    it('_bootstrapTable bails to retry (returns null) when the mirror table is absent', async function () {
        const doQuery = sinon.stub().resolves([]);              // table missing -> empty SHOW COLUMNS
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        const httpGet = sinon.stub(sync, '_httpGet');
        assert.strictEqual(await sync._bootstrapTable('price_snapshots'), null,
            'an absent table must report not-drained so _bootstrapAll schedules a retry');
        assert.strictEqual(httpGet.callCount, 0,
            'must not fetch from the hub at all when the local table is absent');
    });

    it('recovers WITHOUT a restart once the table exists (cache was never poisoned)', async function () {
        const doQuery = sinon.stub();
        doQuery.onCall(0).resolves([]);                                       // round 1 SHOW COLUMNS: absent
        doQuery.onCall(1).resolves([{ Field: 'id' }, { Field: 'status' }]);  // round 2 SHOW COLUMNS: present
        doQuery.resolves([{ max_id: null }]);                                // subsequent MAX(id)
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sinon.stub(sync, '_applyRow').resolves();
        sinon.stub(sync, '_refreshPriceSyncHeight').resolves();
        sinon.stub(sync, '_httpGet').resolves({ rows: [{ id: 1 }], watermark: 77 });

        assert.strictEqual(await sync._bootstrapTable('price_snapshots'), null,
            'round 1: table absent -> not-drained');
        assert.strictEqual(await sync._bootstrapTable('price_snapshots'), 77,
            'round 2: table now present -> drains cleanly (no restart needed)');
    });
});

describe('HubDbSync bootstrap fail-closed on partial drain / holes @regression @tier1', function () {

    // BOOTSTRAP-HOLE-1: on an apply failure mid-page the cursor must not advance past the
    // failed row (directly or via a later row in the page), or the next retry's since_id =
    // SELECT MAX(id) skips it forever and, once the retry drains clean, the heartbeat gate
    // opens over a permanent mirror hole. BOOTSTRAP-FLAG-PARTIAL-DRAIN: a partial drain must
    // not arm the *Bootstrapped flag, or the barrier's empty/content fast path opens against
    // an incomplete mirror and forks.
    it('stops the page at the first apply failure and does not arm the barrier', async function () {
        const doQuery = sinon.stub();
        doQuery.withArgs(sinon.match(/SHOW COLUMNS/)).resolves([{ Field: 'id' }, { Field: 'status' }]);
        doQuery.withArgs(sinon.match(/MAX\(id\)/)).resolves([{ max_id: 0 }]);
        doQuery.resolves([]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sinon.stub(sync, '_httpGet').resolves({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }], watermark: 99 });
        const applied = [];
        sinon.stub(sync, '_applyRow').callsFake(async (t, row) => {
            if (row.id === 2) throw new Error('unappliable row');
            applied.push(row.id);
        });
        const refresh = sinon.stub(sync, '_refreshPriceSyncHeight').resolves();

        const result = await sync._bootstrapTable('price_snapshots');

        assert.strictEqual(result, null, 'a hole must report not-drained');
        assert.deepStrictEqual(applied, [1],
            'stops at the first failure; row 3 (after the hole) is never applied, so local MAX(id) stays below the hole');
        assert.ok(refresh.notCalled,
            'a partial drain must NOT arm the barrier (BOOTSTRAP-FLAG-PARTIAL-DRAIN)');
    });

    it('a clean full drain still arms the barrier (no regression)', async function () {
        const doQuery = sinon.stub();
        doQuery.withArgs(sinon.match(/SHOW COLUMNS/)).resolves([{ Field: 'id' }]);
        doQuery.withArgs(sinon.match(/MAX\(id\)/)).resolves([{ max_id: 0 }]);
        doQuery.resolves([]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sinon.stub(sync, '_httpGet').resolves({ rows: [{ id: 1 }], watermark: 77 });
        sinon.stub(sync, '_applyRow').resolves();
        const refresh = sinon.stub(sync, '_refreshPriceSyncHeight').resolves();

        const result = await sync._bootstrapTable('price_snapshots');

        assert.strictEqual(result, 77, 'clean drain returns the watermark');
        assert.ok(refresh.calledOnce, 'a full drain arms the barrier');
    });

    // CATCHUP-SCHEMA-BYPASS-1: the hub_ready_max_id catch-up fetch must honor the same
    // schema_version fail-closed as the main page loop; a mismatched catch-up page marks
    // the table not-drained rather than applying rows of an unknown shape.
    it('a schema-mismatched catch-up page fails closed (not drained)', async function () {
        const doQuery = sinon.stub();
        doQuery.withArgs(sinon.match(/SHOW COLUMNS/)).resolves([{ Field: 'id' }]);
        doQuery.withArgs(sinon.match(/MAX\(id\)/)).resolves([{ max_id: 5 }]);
        doQuery.resolves([{ max_id: 5 }]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sync._readyMaxIds = { oracle_prices: 100 };            // hub advertises rows past our local max
        const httpGet = sinon.stub(sync, '_httpGet');
        httpGet.onFirstCall().resolves({ rows: [], watermark: 10 });          // main page: clean short drain
        httpGet.onSecondCall().resolves({ rows: [{ id: 6 }], schema_version: 999999 });  // catch-up: mismatch
        sinon.stub(sync, '_applyRow').resolves();
        const refresh = sinon.stub(sync, '_refreshOracleSyncTimestamp').resolves();

        const result = await sync._bootstrapTable('oracle_prices');

        assert.strictEqual(result, null, 'a schema-mismatched catch-up must mark the table not-drained');
        assert.ok(refresh.notCalled, 'and must not arm the barrier');
    });
});

// ---------------------------------------------------------------------------
// #2422: the WS subscription opens BEFORE the REST bootstrap and
// price_snapshots deliberately drains LAST behind a multi-minute pull, so a
// freshly-finalized round arriving on the socket mid-drain used to apply
// immediately; _refreshPriceSyncHeight then adopted its MAX(reference_block)
// while earlier rounds (lower ids, only deliverable via the still-draining
// bootstrap) were absent locally, and the height barrier's case-1 opened over
// a HOLED mirror: a per-operator divergent native-fee price read. Live price
// events must BUFFER until the price bootstrap drains, keeping the local
// mirror a CONTIGUOUS prefix of the hub's table, while the reconnect
// self-heal (which reads a COMPLETE mirror before the re-bootstrap, tests
// above) keeps working unguarded.
// ---------------------------------------------------------------------------
describe('HubDbSync live price rows buffer until the price bootstrap drains (#2422) @regression @tier1', function () {

    function makeBufferSync() {
        const doQuery = sinon.stub().resolves([]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        return { sync, doQuery };
    }

    it('a live price round arriving mid-bootstrap is buffered, not applied, and cannot open the height barrier', async function () {
        const { sync } = makeBufferSync();
        const applyRow = sinon.stub(sync, '_applyRow').resolves();
        const refresh  = sinon.stub(sync, '_refreshPriceSyncHeight').resolves();
        assert.strictEqual(sync._priceDrained, false, 'price drain pending on a fresh connection');
        await sync._handleRowEvent({ type: 'row:inserted', table: 'price_snapshots',
            row: { id: 37032, reference_block: 900000, status: 'finalized' } });
        assert.ok(applyRow.notCalled, 'must not apply ahead of the still-draining bootstrap');
        assert.ok(refresh.notCalled, 'must not refresh (a MAX() read would adopt the holed height)');
        assert.strictEqual(sync._pendingPriceEvents.length, 1, 'event buffered for post-drain replay');
        assert.strictEqual(sync.priceSyncHeight, 0, 'barrier input unchanged');
        assert.ok(!sync.priceBootstrapped, 'time-barrier flag not armed from a holed mirror');
        assert.strictEqual(sync._priceSyncSatisfied(900000, undefined), false, 'barrier stays shut');
    });

    it('a live price retraction mid-bootstrap buffers too (replay order vs its insert is consensus-relevant)', async function () {
        const { sync } = makeBufferSync();
        const retract = sinon.stub(sync, '_applyRetraction').resolves();
        await sync._handleRowEvent({ type: 'row:deleted', table: 'price_snapshots',
            source_chain: 'BTC', from_action_index: 50 });
        assert.ok(retract.notCalled, 'deletion deferred behind any buffered insert it may retract');
        assert.strictEqual(sync._pendingPriceEvents.length, 1);
    });

    it('live rows for OTHER tables still apply immediately mid-bootstrap', async function () {
        const { sync } = makeBufferSync();
        const applyRow = sinon.stub(sync, '_applyRow').resolves();
        const refresh  = sinon.stub(sync, '_refreshOracleSyncTimestamp').resolves();
        await sync._handleRowEvent({ type: 'row:inserted', table: 'oracle_prices', row: { id: 1 } });
        assert.ok(applyRow.calledOnce, 'non-price mirrors keep the live path');
        assert.ok(refresh.calledOnce);
        assert.strictEqual(sync._pendingPriceEvents.length, 0);
    });

    it('a schema-mismatched live price event is refused outright, never buffered for replay', async function () {
        const { sync } = makeBufferSync();
        const applyRow = sinon.stub(sync, '_applyRow').resolves();
        await sync._handleRowEvent({ type: 'row:inserted', table: 'price_snapshots',
            schema_version: 999999, row: { id: 1 } });
        assert.ok(applyRow.notCalled);
        assert.strictEqual(sync._pendingPriceEvents.length, 0, 'a bad-shape row must not survive to the flush');
        assert.strictEqual(sync._schemaMismatchSeen, true, 'watermark gate frozen');
    });

    it('the drain replays buffered events in arrival order, arms the refresh, and resumes the live path', async function () {
        const doQuery = sinon.stub().resolves([{ max_id: null }]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sinon.stub(sync, '_localColumns').resolves(new Set(['id', 'status']));
        sinon.stub(sync, '_httpGet').resolves({ rows: [{ id: 1 }, { id: 2 }], watermark: 55 });
        const seq = [];
        sinon.stub(sync, '_applyRow').callsFake(async (t, row) => { seq.push('insert:' + row.id); });
        sinon.stub(sync, '_applyRetraction').callsFake(async (e) => { seq.push('delete:' + e.from_action_index); });
        const refresh = sinon.stub(sync, '_refreshPriceSyncHeight').resolves();

        // Two live events land mid-drain: a fresh round, then its retraction.
        await sync._handleRowEvent({ type: 'row:inserted', table: 'price_snapshots', row: { id: 9 } });
        await sync._handleRowEvent({ type: 'row:deleted', table: 'price_snapshots', source_chain: 'BTC', from_action_index: 9 });
        assert.deepStrictEqual(seq, [], 'nothing applied before the drain');

        const mark = await sync._bootstrapTable('price_snapshots');
        assert.strictEqual(mark, 55, 'drain completes');
        assert.deepStrictEqual(seq, ['insert:1', 'insert:2', 'insert:9', 'delete:9'],
            'bootstrap pages first, then buffered events replay in arrival order');
        assert.strictEqual(sync._priceDrained, true);
        assert.strictEqual(sync._pendingPriceEvents.length, 0);
        assert.ok(refresh.calledOnce, 'the barrier refresh runs once, after the replay');

        // Live path resumes: the next event applies immediately and refreshes.
        await sync._handleRowEvent({ type: 'row:inserted', table: 'price_snapshots', row: { id: 10 } });
        assert.deepStrictEqual(seq.slice(-1), ['insert:10']);
        assert.ok(refresh.calledTwice, 'post-drain live rows refresh as before');
    });

    it('a failed replay fails closed: the table reports not-drained and the failed event stays buffered', async function () {
        const doQuery = sinon.stub().resolves([{ max_id: null }]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sinon.stub(sync, '_localColumns').resolves(new Set(['id']));
        sinon.stub(sync, '_httpGet').resolves({ rows: [{ id: 1 }], watermark: 55 });
        const applyRow = sinon.stub(sync, '_applyRow');
        applyRow.resolves();
        applyRow.withArgs('price_snapshots', sinon.match({ id: 9 })).rejects(new Error('ER_SOMETHING'));
        const refresh = sinon.stub(sync, '_refreshPriceSyncHeight').resolves();
        await sync._handleRowEvent({ type: 'row:inserted', table: 'price_snapshots', row: { id: 9 } });
        await sync._handleRowEvent({ type: 'row:inserted', table: 'price_snapshots', row: { id: 10 } });

        const mark = await sync._bootstrapTable('price_snapshots');
        assert.strictEqual(mark, null, 'flush failure must report not-drained so _bootstrapAll retries');
        assert.strictEqual(sync._priceDrained, false, 'live path must not open over the missed round');
        assert.strictEqual(sync._pendingPriceEvents.length, 2, 'failed event and tail stay buffered for the retry');
        assert.ok(refresh.notCalled, 'must not arm the barrier over the hole');
    });

    it('a disconnect racing the drain cannot stale-arm the live path (epoch guard)', async function () {
        const doQuery = sinon.stub().resolves([{ max_id: null }]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sinon.stub(sync, '_localColumns').resolves(new Set(['id']));
        sinon.stub(sync, '_httpGet').resolves({ rows: [], watermark: 55 });
        const refresh = sinon.stub(sync, '_refreshPriceSyncHeight').resolves();
        // Simulate the socket closing while the flush is in flight (the close
        // handler bumps _wsEpoch and resets the per-connection drain state).
        sinon.stub(sync, '_flushPendingPriceEvents').callsFake(async () => { sync._wsEpoch++; return true; });

        const mark = await sync._bootstrapTable('price_snapshots');
        assert.strictEqual(mark, null, 'a raced drain must not certify the table');
        assert.strictEqual(sync._priceDrained, false, 'the NEXT connection must re-buffer until its own re-drain');
        assert.ok(refresh.notCalled);
    });

    it('buffer overflow forces a re-drain instead of opening the gate over dropped events', async function () {
        const { sync } = makeBufferSync();
        sync._pendingPriceEvents = new Array(10000).fill({ type: 'row:inserted', row: { id: 1 } });
        sync._bufferPriceEvent({ type: 'row:inserted', row: { id: 99999 } });
        assert.strictEqual(sync._pendingPriceOverflow, true, 'overflow flagged');
        assert.strictEqual(sync._pendingPriceEvents.length, 0, 'buffer abandoned (rows re-page from the hub)');
        assert.strictEqual(await sync._flushPendingPriceEvents(), false,
            'the flush reports not-drained so _bootstrapAll re-pages the dropped rows');
        assert.strictEqual(sync._pendingPriceOverflow, false, 'flag consumed; the retry starts clean');
    });

    it('reconnect self-heal preserved: a COMPLETE mirror still clears a price waiter while the re-drain is pending', async function () {
        // The distinguishing signal is the mirror's CONTIGUITY, not a flag:
        // buffering guarantees no out-of-order live row was ever applied, so
        // at the reconnect edge (_bootstrapDrained false, _priceDrained false)
        // the local mirror is exactly the pre-disconnect complete prefix and
        // the proactive refresh may adopt its MAX unguarded (the 5d465fa /
        // 2026-06-13 self-heal fixes stay intact).
        const doQuery = sinon.stub().callsFake(async () => [{ h: 150 }]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sync.priceSyncHeight   = 10;               // in-memory frozen behind the mirror
        sync._bootstrapDrained = false;            // reconnect edge: gate closed...
        sync._priceDrained     = false;            // ...and the price re-drain still pending
        const pending = sync.waitForPriceSyncHeight(100, 60000);
        await sync._refreshAllSyncHeights();       // the reconnect-edge proactive refresh
        assert.strictEqual(await pending, 150, 'barrier opens from the complete local mirror, not the timeout');
        assert.strictEqual(sync._priceWaiters.length, 0);
    });
});

// Cross-chain call-sync watermark must be scoped to this coin (item 4573): a global
// MAX(effective_time) could be bumped by an unrelated other-chain call and let the
// barrier pass before this chain's calls are mirrored, forking XEXEC injection.
describe('HubDbSync call-sync watermark chain scoping @regression @tier1', function () {
    it('scopes MAX(effective_time) to (target_chain OR source_chain) = this.coin', async function () {
        const doQuery = require('sinon').stub();
        let captured = null;
        doQuery.callsFake(async (sql, args) => { captured = { sql, args }; return [{ ts: 123 }]; });
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', coin: 'BTC' });

        await sync._refreshCallSyncTimestamp();

        assert.ok(captured, 'query ran');
        assert.ok(/cross_chain_calls/.test(captured.sql));
        assert.ok(/target_chain\s*=\s*\?\s+OR\s+source_chain\s*=\s*\?/i.test(captured.sql),
            'must filter to calls touching this coin');
        assert.deepStrictEqual(captured.args, ['BTC', 'BTC']);
        assert.strictEqual(sync.callSyncTimestamp, 123);
    });

    it('falls back to an unscoped watermark when no coin is configured', async function () {
        const doQuery = require('sinon').stub();
        let captured = null;
        doQuery.callsFake(async (sql, args) => { captured = { sql, args }; return [{ ts: 5 }]; });
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });

        await sync._refreshCallSyncTimestamp();

        assert.ok(!/target_chain/.test(captured.sql), 'no coin -> no chain filter');
        assert.deepStrictEqual(captured.args, []);
    });
});

// Cross-chain MATCH-sync watermark must be scoped to this coin, same fork class as the
// call-sync watermark (item 4573): a global MAX(effective_time) could be bumped by an
// unrelated other-chain match (both legs on other chains, still mirrored here) and let
// waitForMatchSync pass before this chain's matches are mirrored, forking cross_settle.
describe('HubDbSync match-sync watermark chain scoping @regression @tier1', function () {
    it('scopes MAX(effective_time) to (a_chain OR b_chain) = this.coin', async function () {
        const doQuery = require('sinon').stub();
        let captured = null;
        doQuery.callsFake(async (sql, args) => { captured = { sql, args }; return [{ ts: 456 }]; });
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', coin: 'BTC' });

        await sync._refreshMatchSyncTimestamp();

        assert.ok(captured, 'query ran');
        assert.ok(/cross_chain_matches/.test(captured.sql));
        assert.ok(/a_chain\s*=\s*\?\s+OR\s+b_chain\s*=\s*\?/i.test(captured.sql),
            'must filter to matches touching this coin');
        assert.deepStrictEqual(captured.args, ['BTC', 'BTC']);
        assert.strictEqual(sync.matchSyncTimestamp, 456);
    });

    it('falls back to an unscoped watermark when no coin is configured', async function () {
        const doQuery = require('sinon').stub();
        let captured = null;
        doQuery.callsFake(async (sql, args) => { captured = { sql, args }; return [{ ts: 9 }]; });
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });

        await sync._refreshMatchSyncTimestamp();

        assert.ok(!/a_chain/.test(captured.sql), 'no coin -> no chain filter');
        assert.deepStrictEqual(captured.args, []);
    });
});

// Schema-parity guard (class-retiring): every mirror table the reorg-retraction path
// DELETEs from MUST declare, in its own src/sql twin, the columns that DELETE references.
// price_snapshots shipped without source_chain/source_action_index while _applyRetraction
// built `DELETE ... WHERE source_chain = ? AND source_action_index >= ?`, so every reorg
// price:deleted threw ER_BAD_FIELD_ERROR and was swallowed -> the rolled-back round was
// never pruned on distributed replicas, diverging their native-fee price set from single-
// host indexers. This test reads the actual SQL and fails if any retraction key column is
// absent, covering both the generic RETRACTION_COLUMNS tables and the special cross-chain paths.
describe('HubDbSync retraction schema parity @regression @tier1', function () {
    const fs   = require('fs');
    const path = require('path');
    const sqlDir = path.join(__dirname, '..', '..', 'src', 'sql');
    const cols = (table) => {
        const sql = fs.readFileSync(path.join(sqlDir, table + '.sql'), 'utf8');
        // Column name is the first token of each definition line (strip leading whitespace).
        return new Set(sql.split('\n').map(l => (l.trim().match(/^([a-z_][a-z0-9_]*)\b/i) || [])[1]).filter(Boolean));
    };
    // Required retraction key columns per mirrored table (source_chain + the action-index
    // column the DELETE matches on + the push_generation fence).
    const REQUIRED = {
        price_snapshots:     ['source_chain', 'source_action_index', 'push_generation'],
        oracle_prices:       ['source_chain', 'action_index', 'push_generation'],
        cross_chain_calls:   ['source_chain', 'source_action_index', 'push_generation'],
        cross_chain_matches: ['a_chain', 'a_action_index', 'a_push_generation',
                              'b_chain', 'b_action_index', 'b_push_generation'],
    };
    for (const [table, need] of Object.entries(REQUIRED)) {
        it(table + ' mirror schema carries its retraction key columns', function () {
            const have = cols(table);
            for (const c of need) {
                assert.ok(have.has(c),
                    table + '.sql is missing retraction column `' + c + '` used by _applyRetraction');
            }
        });
    }
});

// _applyRetraction mirrors the hub's reorg delete onto the local copy. When the broadcast
// carries to_action_index (a deferred/closed-range retraction, item 5296) the replica MUST
// bound its delete identically or it diverges from the hub. The first doQuery call is the delete.
describe('HubDbSync._applyRetraction closed-range parity @regression @tier3', function () {
    function makeApply() {
        const calls = [];
        const doQuery = sinon.stub().callsFake(async (sql, args) => { calls.push({ sql, args }); return []; });
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        return { sync, calls };
    }

    it('open-ended delete for price_snapshots when no to_action_index', async function () {
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'price_snapshots', source_chain: 'BTC', from_action_index: 50 });
        assert.match(calls[0].sql, /source_action_index >= \?/);
        assert.ok(!/<= \?/.test(calls[0].sql), 'must stay open-ended');
        assert.deepStrictEqual(calls[0].args, ['BTC', 50]);
    });

    it('bounded delete for price_snapshots when to_action_index present', async function () {
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'price_snapshots', source_chain: 'BTC', from_action_index: 50, to_action_index: 75 });
        assert.match(calls[0].sql, /source_action_index >= \? AND source_action_index <= \?/);
        assert.deepStrictEqual(calls[0].args, ['BTC', 50, 75]);
    });

    it('bounded delete for oracle_prices keys on action_index', async function () {
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'oracle_prices', source_chain: 'LTC', from_action_index: 1, to_action_index: 9 });
        assert.match(calls[0].sql, /action_index >= \? AND action_index <= \?/);
        assert.deepStrictEqual(calls[0].args, ['LTC', 1, 9]);
    });

    // : quorum-class tables refuse unfenced deletions outright (every current
    // source stamps the item-5308 fence); the fenced variants below stay the
    // closed-range parity coverage for these two tables.
    it('REFUSES an unfenced delete for cross_chain_calls ', async function () {
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'cross_chain_calls', source_chain: 'BTC', from_action_index: 10, to_action_index: 20 });
        assert.strictEqual(calls.length, 0, 'no DELETE may run for an unfenced quorum-class retraction');
    });

    it('REFUSES an unfenced delete for cross_chain_matches ', async function () {
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'cross_chain_matches', source_chain: 'BTC', from_action_index: 10, to_action_index: 20 });
        assert.strictEqual(calls.length, 0, 'no DELETE may run for an unfenced quorum-class retraction');
    });

    // Item 5308: when the broadcast carries retraction_generation, the replica mirrors the SAME
    // generation fence (push_generation <= it), so a row re-published at a recycled action_index
    // (higher generation) survives on the replica too. cross_chain_matches fences per leg.
    it('gen-fenced delete for price_snapshots adds push_generation <= ?', async function () {
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'price_snapshots', source_chain: 'BTC', from_action_index: 50, to_action_index: 75, retraction_generation: 5 });
        assert.match(calls[0].sql, /source_action_index >= \? AND source_action_index <= \? AND push_generation <= \?/);
        assert.deepStrictEqual(calls[0].args, ['BTC', 50, 75, 5]);
    });

    it('gen-fenced open-ended delete for oracle_prices (gen but no to_action_index)', async function () {
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'oracle_prices', source_chain: 'LTC', from_action_index: 1, retraction_generation: 7 });
        assert.match(calls[0].sql, /action_index >= \? AND push_generation <= \?/);
        assert.ok(!/action_index <= \?/.test(calls[0].sql), 'no closed-range clause');
        assert.deepStrictEqual(calls[0].args, ['LTC', 1, 7]);
    });

    it('gen-fenced delete for cross_chain_calls adds push_generation <= ?', async function () {
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'cross_chain_calls', source_chain: 'BTC', from_action_index: 10, to_action_index: 20, retraction_generation: 3 });
        assert.match(calls[0].sql, /source_action_index >= \? AND source_action_index <= \? AND push_generation <= \?/);
        assert.deepStrictEqual(calls[0].args, ['BTC', 10, 20, 3]);
    });

    it('gen-fenced PER-LEG delete for cross_chain_matches (a_/b_push_generation)', async function () {
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'cross_chain_matches', source_chain: 'BTC', from_action_index: 10, to_action_index: 20, retraction_generation: 4 });
        assert.match(calls[0].sql, /a_action_index <= \? AND a_push_generation <= \?/);
        assert.match(calls[0].sql, /b_action_index <= \? AND b_push_generation <= \?/);
        assert.deepStrictEqual(calls[0].args, ['BTC', 10, 20, 4, 'BTC', 10, 20, 4]);
    });
});

// ---------------------------------------------------------------------------
// XCALL-RETRACT-1 receive-side guards . row:deleted events are unsigned
// and the hub's push*reorg RPCs forward the caller's claim verbatim, so the
// mirror must not treat them as ground truth: retractions claiming a reorg of
// OUR OWN chain are checked against our own push_generations authority, and
// per-chain generation monotonicity drops stale replays.
// ---------------------------------------------------------------------------
describe('HubDbSync._applyRetraction receive-side guards  @regression @tier1', function () {
    function makeApply(ownGeneration) {
        const calls = [];
        const doQuery = sinon.stub().callsFake(async (sql, args) => { calls.push({ sql, args }); return []; });
        const opts = { hubUrl: 'http://hub.test', coin: 'BTC' };
        if (ownGeneration !== undefined) opts.getOwnRollbackGeneration = ownGeneration;
        const sync = new HubDbSync({ doQuery }, opts);
        return { sync, calls };
    }
    const deletes = (calls) => calls.filter(c => /^DELETE/.test(c.sql));

    it('accepts an own-chain retraction whose fence is below our rollback generation', async function () {
        const { sync, calls } = makeApply(async () => 6);
        await sync._applyRetraction({ table: 'cross_chain_calls', source_chain: 'BTC', from_action_index: 10, retraction_generation: 5 });
        assert.strictEqual(deletes(calls).length, 1, 'legitimate backstop delete must apply');
    });

    it('REFUSES an own-chain retraction at/above our rollback generation (forged reorg)', async function () {
        const { sync, calls } = makeApply(async () => 6);
        await sync._applyRetraction({ table: 'cross_chain_calls', source_chain: 'BTC', from_action_index: 10, retraction_generation: 6 });
        await sync._applyRetraction({ table: 'cross_chain_calls', source_chain: 'BTC', from_action_index: 10, retraction_generation: 999 });
        assert.strictEqual(deletes(calls).length, 0, 'no rollback of ours produced these fences');
    });

    it('REFUSES an own-chain retraction when never rolled back (generation 0)', async function () {
        const { sync, calls } = makeApply(async () => 0);
        await sync._applyRetraction({ table: 'oracle_prices', source_chain: 'BTC', from_action_index: 1, retraction_generation: 0 });
        assert.strictEqual(deletes(calls).length, 0);
    });

    it('fails CLOSED when the own-generation read throws', async function () {
        const { sync, calls } = makeApply(async () => { throw new Error('db down'); });
        await sync._applyRetraction({ table: 'cross_chain_calls', source_chain: 'BTC', from_action_index: 10, retraction_generation: 1 });
        assert.strictEqual(deletes(calls).length, 0);
    });

    it('REFUSES an unfenced own-chain retraction even for non-quorum tables', async function () {
        const { sync, calls } = makeApply(async () => 6);
        await sync._applyRetraction({ table: 'oracle_prices', source_chain: 'BTC', from_action_index: 1 });
        assert.strictEqual(deletes(calls).length, 0, 'our own retractions are always fenced');
    });

    it('other-chain retractions skip the own-generation check but track monotonicity', async function () {
        const { sync, calls } = makeApply(async () => 0);
        await sync._applyRetraction({ table: 'cross_chain_calls', source_chain: 'LTC', from_action_index: 10, retraction_generation: 7 });
        assert.strictEqual(deletes(calls).length, 1, 'no local authority for LTC; fenced delete applies');
        // Stale replay below the tracked generation is dropped...
        await sync._applyRetraction({ table: 'cross_chain_calls', source_chain: 'LTC', from_action_index: 10, retraction_generation: 6 });
        assert.strictEqual(deletes(calls).length, 1, 'stale replay must be skipped');
        // ...equal-generation redelivery is idempotent and still applied.
        await sync._applyRetraction({ table: 'cross_chain_calls', source_chain: 'LTC', from_action_index: 10, retraction_generation: 7 });
        assert.strictEqual(deletes(calls).length, 2, 'same-generation redelivery stays idempotent');
    });

    it('monotonicity is tracked per (table, source_chain), not globally', async function () {
        const { sync, calls } = makeApply(async () => 0);
        await sync._applyRetraction({ table: 'cross_chain_calls', source_chain: 'LTC', from_action_index: 10, retraction_generation: 9 });
        await sync._applyRetraction({ table: 'cross_chain_matches', source_chain: 'LTC', from_action_index: 10, retraction_generation: 2 });
        await sync._applyRetraction({ table: 'cross_chain_calls', source_chain: 'DOGE', from_action_index: 10, retraction_generation: 1 });
        assert.strictEqual(deletes(calls).length, 3, 'independent keys must not shadow each other');
    });

    it('without the hook (explorer vendored mirror) other-chain legacy behavior is unchanged', async function () {
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'oracle_prices', source_chain: 'LTC', from_action_index: 1 });
        assert.strictEqual(deletes(calls).length, 1, 'unfenced non-quorum retraction stays compatible');
        await sync._applyRetraction({ table: 'oracle_prices', source_chain: 'BTC', from_action_index: 1 });
        assert.strictEqual(deletes(calls).length, 2, 'own-chain check needs the hook; without it legacy applies');
    });
});

// ---------------------------------------------------------------------------
// ensureTables(): mirror-schema creation for consumers without their own
// table machinery (the explorer's embedded mirror). The indexer never calls
// this (verifyTables() owns its schema); these tests pin the contract the
// explorer relies on: comment-safe statement splitting, per-file retry with
// backoff, and a hard error on an empty SQL dir.
// ---------------------------------------------------------------------------
describe('HubDbSync.ensureTables @regression @tier3', function () {

    const fs   = require('fs');
    const os   = require('os');
    const path = require('path');
    const { ensureTables } = HubDbSync;

    function makeSqlDir(files) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mirror-sql-'));
        for (const [name, content] of Object.entries(files))
            fs.writeFileSync(path.join(dir, name), content);
        return dir;
    }

    it('is exported alongside the class', function () {
        assert.strictEqual(typeof ensureTables, 'function');
    });

    it('executes every statement of every .sql file, in filename order', async function () {
        const dir = makeSqlDir({
            'b_second.sql': 'CREATE TABLE b (id INT);',
            'a_first.sql':  'CREATE TABLE a (id INT);\nCREATE INDEX idx_a ON a (id);'
        });
        const calls = [];
        await ensureTables({ doQuery: async (sql) => { calls.push(sql); return []; } }, dir);
        const creates = calls.filter((s) => !/^SHOW TABLES/.test(s));
        assert.strictEqual(creates.length, 3);
        assert.match(creates[0], /CREATE TABLE a/);
        assert.match(creates[1], /CREATE INDEX idx_a/);
        assert.match(creates[2], /CREATE TABLE b/);
    });

    it('skips a file whose table already exists (restart against a built schema)', async function () {
        // The SQL twins use bare CREATE TABLE, so a re-run must gate on
        // existence exactly like the indexer verifyTables() does; without the
        // gate a mirror consumer crash-loops with ER_TABLE_EXISTS_ERROR on
        // every restart (caught live in the keyed-feed drill 2026-07-06).
        const dir = makeSqlDir({
            'a.sql': 'CREATE TABLE a (id INT);',
            'b.sql': 'CREATE TABLE b (id INT);'
        });
        const calls = [];
        const doQuery = async (sql, args) => {
            calls.push(sql);
            if (/^SHOW TABLES/.test(sql)) return args[0] === 'a' ? [{ t: 'a' }] : [];
            return [];
        };
        await ensureTables({ doQuery }, dir);
        const creates = calls.filter((s) => !/^SHOW TABLES/.test(s));
        assert.strictEqual(creates.length, 1, 'only the missing table is created');
        assert.match(creates[0], /CREATE TABLE b/);
    });

    it('a semicolon inside a -- comment is not a statement terminator', async function () {
        // Statement bodies must not contain quoted semicolons (the split on ';'
        // is naive there, same as indexer db.js createTable); the guarantee
        // under test is comment prose only, which is what bit attests.sql.
        const dir = makeSqlDir({
            't.sql': '-- header prose; with a semicolon\nCREATE TABLE t (id INT);'
        });
        const calls = [];
        await ensureTables({ doQuery: async (sql) => { calls.push(sql); return []; } }, dir);
        const creates = calls.filter((s) => !/^SHOW TABLES/.test(s));
        assert.strictEqual(creates.length, 1, 'comment semicolons must not split statements');
        assert.match(creates[0], /CREATE TABLE t/);
    });

    it('retries a failing file with backoff and succeeds', async function () {
        const clock = sinon.useFakeTimers();
        try {
            const dir = makeSqlDir({ 't.sql': 'CREATE TABLE t (id INT);' });
            let calls = 0;
            let created = false;
            const doQuery = async (sql) => {
                calls++;
                if (calls === 1) throw new Error('transient');
                if (/^CREATE TABLE/.test(sql)) created = true;
                return [];
            };
            const p = ensureTables({ doQuery }, dir);
            await clock.tickAsync(600);
            await p;
            assert.strictEqual(created, true, 'table created on the retry attempt');
        } finally {
            clock.restore();
        }
    });

    it('throws after exhausting attempts on a persistently failing file', async function () {
        const clock = sinon.useFakeTimers();
        try {
            const dir = makeSqlDir({ 't.sql': 'CREATE TABLE t (id INT);' });
            const p = assert.rejects(
                ensureTables({ doQuery: async () => { throw new Error('down'); } }, dir),
                /failed to create t\.sql after 5 attempts: down/
            );
            await clock.tickAsync(60000);
            await p;
        } finally {
            clock.restore();
        }
    });

    it('throws on a directory with no .sql files', async function () {
        const dir = makeSqlDir({});
        await assert.rejects(
            ensureTables({ doQuery: async () => [] }, dir),
            /no \.sql files found/
        );
    });
});

// H-3 / NATIVE_FEE_PRICE_TIME_GATE: time-keyed price barrier for non-reference
// chains (LTC/DOGE). Their heights are not comparable to the rounds' BTC
// reference_block anchor, so catch-up is judged by the rounds' consensus
// timestamps (mirror MAX(block_timestamp)) or the hub stream watermark.
describe('HubDbSync time-keyed price barrier (H-3) @regression @tier3', function () {

    function makeTimeSync(maxReferenceBlock, maxTimestamp) {
        const doQuery = sinon.stub();
        doQuery.callsFake(async () => [{ h: maxReferenceBlock, ts: maxTimestamp }]);
        const hubDb = { doQuery };
        const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test' });
        return { sync, hubDb, doQuery };
    }

    it('_refreshPriceSyncHeight adopts MAX(block_timestamp) alongside the height', async function () {
        const { sync } = makeTimeSync(123, 5000);
        await sync._refreshPriceSyncHeight();
        assert.strictEqual(sync.priceSyncHeight, 123);
        assert.strictEqual(sync.priceSyncMaxTimestamp, 5000);
    });

    it('resolves immediately when the mirror already holds a round at/past the block time', async function () {
        const { sync } = makeTimeSync(123, 5000);
        await sync._refreshPriceSyncHeight();
        const got = await sync.waitForPriceSyncTime(4000, 1000);
        assert.strictEqual(got, 5000);
    });

    it('resolves once a later sync raises the mirror max timestamp', async function () {
        const { sync, doQuery } = makeTimeSync(0, 0);
        await sync._refreshPriceSyncHeight();
        const pending = sync.waitForPriceSyncTime(4000, 2000);
        doQuery.callsFake(async () => [{ h: 10, ts: 4500 }]);
        await sync._refreshPriceSyncHeight();
        const got = await pending;
        assert.strictEqual(got, 4500);
    });

    it('resolves via the stream watermark when the hub has covered blockTime + grace', async function () {
        const { sync } = makeTimeSync(0, 0);
        await sync._refreshPriceSyncHeight();
        const pending = sync.waitForPriceSyncTime(4000, 2000);
        sync._advanceWatermark(4000 + sync.priceWatermarkGraceS);
        const got = await pending;
        assert.strictEqual(got, 0, 'watermark satisfaction does not require any local round');
    });

    it('rejects on timeout while the mirror and watermark stay behind', async function () {
        const { sync } = makeTimeSync(0, 0);
        await sync._refreshPriceSyncHeight();
        await assert.rejects(
            sync.waitForPriceSyncTime(4000, 50),
            /price time-sync barrier timed out/
        );
    });

    it('self-heals on timeout when the DB caught up but the in-memory timestamp was stale', async function () {
        const { sync, doQuery } = makeTimeSync(0, 0);
        await sync._refreshPriceSyncHeight();
        doQuery.callsFake(async () => [{ h: 10, ts: 9000 }]);   // DB is current; memory is stale
        const got = await sync.waitForPriceSyncTime(4000, 50);
        assert.strictEqual(got, 9000, 'timeout path must re-read the mirror before rejecting');
    });

    it('is a no-op when sync is disabled (single-host)', async function () {
        const sync = new HubDbSync(null, {});
        const got = await sync.waitForPriceSyncTime(999999, 10);
        assert.strictEqual(got, 0);
    });
});

// Heartbeat-timeout watchdog (review finding 0af6d951): reconnect used to trigger
// ONLY on the socket's 'close'/'error' events, so a half-open TCP connection (no
// frames, no close/error) froze the mirror indefinitely. The watchdog measures
// time-since-last-watermark and terminates a stalled socket so the existing
// close-handler reconnect path self-heals.
describe('HubDbSync heartbeat-timeout watchdog @regression @tier2', function () {

    function makeWatchdogSync() {
        const doQuery = sinon.stub().resolves([{ h: 0 }]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', watermarkIntervalMs: 10000 });
        return sync;
    }

    function stubWs() {
        return { terminate: sinon.stub() };
    }

    it('terminates the socket once no watermark frame arrives for 3x the interval', function () {
        const clock = sinon.useFakeTimers();
        try {
            const sync = makeWatchdogSync();
            const ws = stubWs();
            sync._startWatchdog(ws);

            clock.tick(29999);
            assert.strictEqual(ws.terminate.called, false, 'must not terminate before the 3x threshold');

            clock.tick(2);
            assert.strictEqual(ws.terminate.called, true, 'must terminate once idle >= 3x the watermark interval');
        } finally {
            clock.restore();
        }
    });

    it('never fires while watermark frames keep arriving on schedule', function () {
        const clock = sinon.useFakeTimers();
        try {
            const sync = makeWatchdogSync();
            const ws = stubWs();
            sync._startWatchdog(ws);

            // Simulate a heartbeat landing every 10s, well inside the 30s timeout,
            // for several times longer than the timeout would otherwise allow.
            for (let i = 0; i < 10; i++) {
                clock.tick(10000);
                sync._lastHeartbeatAt = Date.now();
            }
            assert.strictEqual(ws.terminate.called, false, 'watchdog must not fire while heartbeats stay current');
        } finally {
            clock.restore();
        }
    });

    it('a real watermark message stamps _lastHeartbeatAt and keeps the watchdog quiet', async function () {
        const clock = sinon.useFakeTimers();
        try {
            const sync = makeWatchdogSync();
            sync._bootstrapDrained = true;
            const ws = stubWs();
            sync._startWatchdog(ws);

            // Advance close to (but under) the threshold, then simulate what the
            // 'watermark' message handler does: stamp liveness and advance the
            // stream watermark. The watchdog must see the reset and stay quiet
            // through another full interval.
            clock.tick(25000);
            sync._lastHeartbeatAt = Date.now();
            sync._advanceWatermark(1);
            clock.tick(25000);
            assert.strictEqual(ws.terminate.called, false, 'a fresh heartbeat must reset the idle clock');
        } finally {
            clock.restore();
        }
    });

    it('no timer remains active after _stopWatchdog (close-path cleanup)', function () {
        const clock = sinon.useFakeTimers();
        try {
            const sync = makeWatchdogSync();
            const ws = stubWs();
            sync._startWatchdog(ws);
            assert.ok(sync._watchdogTimer, 'watchdog timer set while socket is open');

            sync._stopWatchdog();
            assert.strictEqual(sync._watchdogTimer, null, 'timer reference cleared');

            clock.tick(60000);
            assert.strictEqual(ws.terminate.called, false, 'a stopped watchdog must never terminate a closed socket');
        } finally {
            clock.restore();
        }
    });

    it('starting a fresh watchdog on reconnect clears any prior timer instead of leaking it', function () {
        const clock = sinon.useFakeTimers();
        try {
            const sync = makeWatchdogSync();
            const ws1 = stubWs();
            sync._startWatchdog(ws1);
            const firstTimer = sync._watchdogTimer;

            const ws2 = stubWs();
            sync._startWatchdog(ws2);
            assert.notStrictEqual(sync._watchdogTimer, firstTimer, 'a new timer replaces the old one');

            clock.tick(30000);
            assert.strictEqual(ws1.terminate.called, false, 'the abandoned first socket must not be terminated by a leaked timer');
        } finally {
            clock.restore();
        }
    });

    it('adopts the hub-advertised watermark interval and resizes the timeout to 3x', function () {
        const sync = makeWatchdogSync();
        assert.strictEqual(sync.watermarkTimeoutMs, 30000, 'seed timeout is 3x the env/option interval');
        const adopted = sync._adoptHubWatermarkInterval(45000);
        assert.strictEqual(adopted, true, 'a valid interval is adopted');
        assert.strictEqual(sync.watermarkIntervalMs, 45000);
        assert.strictEqual(sync.watermarkTimeoutMs, 135000, 'timeout self-sizes to 3x the hub cadence');
    });

    it('ignores a missing/invalid advertised interval, keeping the env-seeded timeout (older hub)', function () {
        const sync = makeWatchdogSync();
        for (const bad of [undefined, null, 0, -1, 'x', NaN]) {
            assert.strictEqual(sync._adoptHubWatermarkInterval(bad), false, 'invalid interval is not adopted');
        }
        assert.strictEqual(sync.watermarkIntervalMs, 10000, 'interval unchanged');
        assert.strictEqual(sync.watermarkTimeoutMs, 30000, 'timeout unchanged (env-seeded fallback intact)');
    });

    it('a socket heartbeating at the hub cadence survives once the interval is adopted (drift no longer kills healthy sockets)', function () {
        const clock = sinon.useFakeTimers();
        try {
            const sync = makeWatchdogSync();
            // Hub raised its interval to 45s; without adoption the 30s (3x10s) timeout
            // would terminate a socket that legitimately heartbeats every 45s.
            sync._adoptHubWatermarkInterval(45000);
            const ws = stubWs();
            sync._startWatchdog(ws);

            for (let i = 0; i < 6; i++) {
                clock.tick(45000);
                sync._lastHeartbeatAt = Date.now();
            }
            assert.strictEqual(ws.terminate.called, false, 'a 45s-cadence socket must not be terminated after adopting the hub interval');
        } finally {
            clock.restore();
        }
    });
});

// ---------------------------------------------------------------------------
//  full fix: signed quorum-class retractions. Once this mirror's own
// capability_snapshots high-water mark crosses the RETRACTION_SIGNING era
// (regtest: genesis), a cross_chain_calls / cross_chain_matches deletion must
// carry a 2f+1 `cross_chain` co-signature set over the XRETRACTV1 canonical,
// verified against the mirrored snapshot at the event's snapshot_block.
// The canonical here is the GOLDEN literal pinned byte-for-byte by the hub's
// RetractionConsensus.test.js: a signature minted over the literal must verify
// against this module's independent rebuild, proving producer/consumer parity.
// ---------------------------------------------------------------------------
describe('HubDbSync._applyRetraction signed retractions  @regression @tier1', function () {
    const nodeCrypto = require('crypto');
    const GOLDEN_CANONICAL = 'XRETRACTV1|cross_chain_calls|DOGE|42|99|7|5000';
    const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

    function makeSigner() {
        const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ed25519');
        const pubkeyHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length).toString('hex');
        return {
            pubkey: pubkeyHex.toLowerCase(),
            sign: (payload) => nodeCrypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('hex')
        };
    }

    // Mirror stub: routes the gate high-water query, the per-block snapshot
    // membership query, and captures DELETEs. `snapRows` = mirrored
    // capability_snapshots at snapshot_block 5000 (source-keyed: SWQ is
    // genesis-active on regtest, so the weighted 3*tally > 2*S predicate runs).
    function makeSigned({ snapRows, maxSnapshotBlock = 5000, network = 'regtest' } = {}) {
        const deletes = [];
        const doQuery = sinon.stub().callsFake(async (sql, args) => {
            if (/MAX\(snapshot_block\)/.test(sql)) return [{ sb: maxSnapshotBlock }];
            if (/SELECT signing_pubkey/.test(sql)) return snapRows || [];
            if (/^DELETE/.test(sql)) { deletes.push({ sql, args }); return []; }
            return [];
        });
        const sync = new HubDbSync({ doQuery }, network ? { hubUrl: 'http://hub.test', network } : { hubUrl: 'http://hub.test' });
        return { sync, deletes };
    }

    function signedEvent(sigs, overrides) {
        return Object.assign({
            table: 'cross_chain_calls', source_chain: 'DOGE',
            from_action_index: 42, to_action_index: 99,
            retraction_generation: 7, snapshot_block: 5000,
            retraction_signatures: sigs
        }, overrides || {});
    }

    it('REFUSES an unsigned quorum-class retraction once the local snapshot era passes the gate', async function () {
        const s = makeSigner();
        const { sync, deletes } = makeSigned({ snapRows: [{ signing_pubkey: s.pubkey, amount: '100', source: 'srcA' }] });
        const evt = signedEvent(undefined);
        delete evt.retraction_signatures;
        delete evt.snapshot_block;
        await sync._applyRetraction(evt);
        assert.strictEqual(deletes.length, 0, 'unsigned quorum-class deletion must not run past the gate');
    });

    it('APPLIES a correctly signed retraction (1-of-1 snapshot), proving canonical parity with the hub', async function () {
        const s = makeSigner();
        const { sync, deletes } = makeSigned({ snapRows: [{ signing_pubkey: s.pubkey, amount: '100', source: 'srcA' }] });
        await sync._applyRetraction(signedEvent([{ pubkey: s.pubkey, sig: s.sign(GOLDEN_CANONICAL) }]));
        assert.strictEqual(deletes.length, 1, 'a valid quorum-signed retraction must apply');
        assert.match(deletes[0].sql, /DELETE FROM cross_chain_calls/);
    });

    it('REFUSES when the wire generation is tampered after signing (fence is signature-bound)', async function () {
        const s = makeSigner();
        const { sync, deletes } = makeSigned({ snapRows: [{ signing_pubkey: s.pubkey, amount: '100', source: 'srcA' }] });
        await sync._applyRetraction(signedEvent(
            [{ pubkey: s.pubkey, sig: s.sign(GOLDEN_CANONICAL) }],
            { retraction_generation: 999999 }));   // replay with an inflated fence
        assert.strictEqual(deletes.length, 0, 'an inflated-generation replay must fail signature verification');
    });

    it('REFUSES a signer outside the mirrored snapshot', async function () {
        const member = makeSigner(), stranger = makeSigner();
        const { sync, deletes } = makeSigned({ snapRows: [{ signing_pubkey: member.pubkey, amount: '100', source: 'srcA' }] });
        await sync._applyRetraction(signedEvent([{ pubkey: stranger.pubkey, sig: stranger.sign(GOLDEN_CANONICAL) }]));
        assert.strictEqual(deletes.length, 0);
    });

    it('enforces the weighted 2/3 bar: 2 of 4 equal sources refused, 3 of 4 applied', async function () {
        const signers = [makeSigner(), makeSigner(), makeSigner(), makeSigner()];
        const snapRows = signers.map((s, i) => ({ signing_pubkey: s.pubkey, amount: '100', source: 'src' + i }));
        const sigsOf = (n) => signers.slice(0, n).map(s => ({ pubkey: s.pubkey, sig: s.sign(GOLDEN_CANONICAL) }));
        {
            const { sync, deletes } = makeSigned({ snapRows });
            await sync._applyRetraction(signedEvent(sigsOf(2)));
            assert.strictEqual(deletes.length, 0, '2 of 4 sources is sub-quorum (600 !> 2/3 of 400*... 3*200 > 2*400 is false)');
        }
        {
            const { sync, deletes } = makeSigned({ snapRows });
            await sync._applyRetraction(signedEvent(sigsOf(3)));
            assert.strictEqual(deletes.length, 1, '3 of 4 sources meets the weighted bar');
        }
    });

    it('REFUSES when no snapshot rows exist at the claimed snapshot_block', async function () {
        const s = makeSigner();
        const { sync, deletes } = makeSigned({ snapRows: [] });
        await sync._applyRetraction(signedEvent([{ pubkey: s.pubkey, sig: s.sign(GOLDEN_CANONICAL) }]));
        assert.strictEqual(deletes.length, 0);
    });

    it('REFUSES a signed set whose snapshot_block is itself below the gate era (no sub-gate minting)', async function () {
        const s = makeSigner();
        // mainnet threshold 969500: local high-water past it, but the event claims an old era
        const { sync, deletes } = makeSigned({
            snapRows: [{ signing_pubkey: s.pubkey, amount: '100', source: 'srcA' }],
            maxSnapshotBlock: 990000, network: 'mainnet'
        });
        const canonical = 'XRETRACTV1|cross_chain_calls|DOGE|42|99|7|5000';   // sb 5000 < 969500
        await sync._applyRetraction(signedEvent([{ pubkey: s.pubkey, sig: s.sign(canonical) }]));
        assert.strictEqual(deletes.length, 0);
    });

    it('legacy tier: without a wired network the  fences stand alone and unsigned events apply', async function () {
        const { sync, deletes } = makeSigned({ snapRows: [], network: null });
        const evt = signedEvent(undefined);
        delete evt.retraction_signatures;
        delete evt.snapshot_block;
        await sync._applyRetraction(evt);
        assert.strictEqual(deletes.length, 1, 'no network wired -> legacy behavior (explorer vendored mirror, older wiring)');
    });

    it('legacy tier: pre-bootstrap mirror (no snapshot rows at all) applies unsigned events', async function () {
        const deletes = [];
        const doQuery = sinon.stub().callsFake(async (sql, args) => {
            if (/MAX\(snapshot_block\)/.test(sql)) return [{ sb: null }];   // empty mirror
            if (/^DELETE/.test(sql)) { deletes.push({ sql, args }); return []; }
            return [];
        });
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', network: 'regtest' });
        const evt = signedEvent(undefined);
        delete evt.retraction_signatures;
        delete evt.snapshot_block;
        await sync._applyRetraction(evt);
        assert.strictEqual(deletes.length, 1, 'pre-bootstrap there is no signer set to verify against');
    });

    // Pkg 13 /  twin parity: the tally marks a pubkey into the dedupe set only
    // AFTER its signature verifies, exactly as the hub producer twin
    // (RetractionConsensus._handleFinalized) and the sibling tallies in anchor.js,
    // recovery.js and StateAnchorPublisher already do. Pre-fix this consumer marked on
    // first encounter, so a garbage entry ordered ahead of the real one for the same
    // snapshot member silently under-counted the quorum and refused a hub-finalized
    // retraction (order-dependent false-reject).
    it('counts a snapshot member whose VALID signature is ordered AFTER a garbage one (verify-then-mark)', async function () {
        const s = makeSigner();
        const { sync, deletes } = makeSigned({ snapRows: [{ signing_pubkey: s.pubkey, amount: '100', source: 'srcA' }] });
        await sync._applyRetraction(signedEvent([
            { pubkey: s.pubkey, sig: 'ab'.repeat(64) },            // well-formed length, does not verify
            { pubkey: s.pubkey, sig: s.sign(GOLDEN_CANONICAL) }    // the real one, ordered second
        ]));
        assert.strictEqual(deletes.length, 1,
            'the leading garbage entry must not consume the dedupe slot for a valid signer');
    });

    it('still counts a duplicated pubkey ONCE when both entries verify (dedupe intact)', async function () {
        const signers = [makeSigner(), makeSigner(), makeSigner(), makeSigner()];
        const snapRows = signers.map((s, i) => ({ signing_pubkey: s.pubkey, amount: '100', source: 'src' + i }));
        const { sync, deletes } = makeSigned({ snapRows });
        // Two real signers, one of them repeated: 2 of 4 sources is still sub-quorum.
        // Were the repeat counted twice, the weighted tally would cross the 2/3 bar.
        await sync._applyRetraction(signedEvent([
            { pubkey: signers[0].pubkey, sig: signers[0].sign(GOLDEN_CANONICAL) },
            { pubkey: signers[0].pubkey, sig: signers[0].sign(GOLDEN_CANONICAL) },
            { pubkey: signers[1].pubkey, sig: signers[1].sign(GOLDEN_CANONICAL) }
        ]));
        assert.strictEqual(deletes.length, 0, 'a repeated valid signer must not inflate the quorum tally');
    });

    it('an invalid signature alone still fails the quorum (verify gate is not weakened)', async function () {
        const s = makeSigner();
        const { sync, deletes } = makeSigned({ snapRows: [{ signing_pubkey: s.pubkey, amount: '100', source: 'srcA' }] });
        await sync._applyRetraction(signedEvent([
            { pubkey: s.pubkey, sig: 'ab'.repeat(64) },
            { pubkey: s.pubkey, sig: 'cd'.repeat(64) }
        ]));
        assert.strictEqual(deletes.length, 0, 'no verifying signature means no quorum, whatever the ordering');
    });
});
