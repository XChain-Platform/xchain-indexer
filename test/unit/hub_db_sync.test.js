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
        const marks = { price_snapshots: 900, oracle_prices: 880, cross_chain_matches: 910, cross_chain_calls: 915, capability_snapshots: 905, state_checkpoints: 920 };
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
            assert.strictEqual(bootstrapTable.callCount, 6, 'one pass over the 6 mirrored tables, no retries');
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

    it('bounded delete for cross_chain_calls', async function () {
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'cross_chain_calls', source_chain: 'BTC', from_action_index: 10, to_action_index: 20 });
        assert.match(calls[0].sql, /source_action_index >= \? AND source_action_index <= \?/);
        assert.deepStrictEqual(calls[0].args, ['BTC', 10, 20]);
    });

    it('bounded two-sided delete for cross_chain_matches', async function () {
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'cross_chain_matches', source_chain: 'BTC', from_action_index: 10, to_action_index: 20 });
        assert.match(calls[0].sql, /a_action_index >= \? AND a_action_index <= \?/);
        assert.match(calls[0].sql, /b_action_index >= \? AND b_action_index <= \?/);
        assert.deepStrictEqual(calls[0].args, ['BTC', 10, 20, 'BTC', 10, 20]);
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
