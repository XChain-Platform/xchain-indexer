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

const HubDbSync = require('../../../src/hub/hub_db_sync.js');

// Build a HubDbSync whose enabled flag is true (needs both a hub URL and a hub DB),
// backed by a stubbed doQuery we drive per-test to simulate the local price mirror.
function makeSync(maxReferenceBlock) {
    const doQuery = sinon.stub();
    doQuery.callsFake(async () => [{ h: maxReferenceBlock }]);
    const hubDb = { doQuery };
    const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test' });
    return { sync, hubDb, doQuery };
}

function makeBufferSync() {
    const doQuery = sinon.stub().resolves([]);
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
    return { sync, doQuery };
}

// ---------------------------------------------------------------------------
// The WS subscription opens BEFORE the REST bootstrap and
// price_snapshots deliberately drains LAST behind a multi-minute pull, so a
// freshly-finalized round arriving on the socket mid-drain would apply
// immediately; _refreshPriceSyncHeight would then adopt its MAX(reference_block)
// while earlier rounds (lower ids, only deliverable via the still-draining
// bootstrap) are absent locally, and the height barrier's case-1 would open over
// a HOLED mirror: a per-operator divergent native-fee price read. Live price
// events must BUFFER until the price bootstrap drains, keeping the local
// mirror a CONTIGUOUS prefix of the hub's table, while the reconnect
// self-heal (which reads a COMPLETE mirror before the re-bootstrap, tests
// above) keeps working unguarded.
// ---------------------------------------------------------------------------
describe('HubDbSync live price rows buffer until the price bootstrap drains (#2422) @regression @tier1', function () {
    it('a live price round arriving mid-bootstrap is buffered, not applied, and cannot open the height barrier', async function () {
        const { sync } = makeBufferSync();
        const applyRow = sinon.stub(sync, '_applyRow').resolves();
        const refresh  = sinon.stub(sync, '_refreshPriceSyncHeight').resolves();
        assert.strictEqual(sync._priceDrained, false, 'price drain pending on a fresh connection');
        await sync.handleRowEvent({ type: 'row:inserted', table: 'price_snapshots',
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
        await sync.handleRowEvent({ type: 'row:deleted', table: 'price_snapshots',
            source_chain: 'BTC', from_action_index: 50 });
        assert.ok(retract.notCalled, 'deletion deferred behind any buffered insert it may retract');
        assert.strictEqual(sync._pendingPriceEvents.length, 1);
    });

    it('live rows for OTHER tables still apply immediately mid-bootstrap', async function () {
        const { sync } = makeBufferSync();
        const applyRow = sinon.stub(sync, '_applyRow').resolves();
        const refresh  = sinon.stub(sync, 'refreshOracleSyncTimestamp').resolves();
        await sync.handleRowEvent({ type: 'row:inserted', table: 'oracle_prices', row: { id: 1 } });
        assert.ok(applyRow.calledOnce, 'non-price mirrors keep the live path');
        assert.ok(refresh.calledOnce);
        assert.strictEqual(sync._pendingPriceEvents.length, 0);
    });

    it('a schema-mismatched live price event is refused outright, never buffered for replay', async function () {
        const { sync } = makeBufferSync();
        const applyRow = sinon.stub(sync, '_applyRow').resolves();
        await sync.handleRowEvent({ type: 'row:inserted', table: 'price_snapshots',
            schema_version: 999999, row: { id: 1 } });
        assert.ok(applyRow.notCalled);
        assert.strictEqual(sync._pendingPriceEvents.length, 0, 'a bad-shape row must not survive to the flush');
        assert.strictEqual(sync._schemaMismatchSeen, true, 'watermark gate frozen');
    });
});

describe('HubDbSync live price rows buffer until the price bootstrap drains (#2422) @regression @tier1', function () {
    it('the drain replays buffered events in arrival order, arms the refresh, and resumes the live path', async function () {
        const doQuery = sinon.stub().resolves([{ max_id: null }]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sinon.stub(sync, 'localColumns').resolves(new Set(['id', 'status']));
        sinon.stub(sync, '_httpGet').resolves({ rows: [{ id: 1 }, { id: 2 }], watermark: 55 });
        const seq = [];
        sinon.stub(sync, '_applyRow').callsFake(async (t, row) => { seq.push('insert:' + row.id); });
        sinon.stub(sync, '_applyRetraction').callsFake(async (e) => { seq.push('delete:' + e.from_action_index); });
        const refresh = sinon.stub(sync, '_refreshPriceSyncHeight').resolves();

        // Two live events land mid-drain: a fresh round, then its retraction.
        await sync.handleRowEvent({ type: 'row:inserted', table: 'price_snapshots', row: { id: 9 } });
        await sync.handleRowEvent({ type: 'row:deleted', table: 'price_snapshots', source_chain: 'BTC', from_action_index: 9 });
        assert.deepStrictEqual(seq, [], 'nothing applied before the drain');

        const mark = await sync._bootstrapTable('price_snapshots');
        assert.strictEqual(mark, 55, 'drain completes');
        assert.deepStrictEqual(seq, ['insert:1', 'insert:2', 'insert:9', 'delete:9'],
            'bootstrap pages first, then buffered events replay in arrival order');
        assert.strictEqual(sync._priceDrained, true);
        assert.strictEqual(sync._pendingPriceEvents.length, 0);
        assert.ok(refresh.calledOnce, 'the barrier refresh runs once, after the replay');

        // Live path resumes: the next event applies immediately and refreshes.
        await sync.handleRowEvent({ type: 'row:inserted', table: 'price_snapshots', row: { id: 10 } });
        assert.deepStrictEqual(seq.slice(-1), ['insert:10']);
        assert.ok(refresh.calledTwice, 'post-drain live rows refresh as before');
    });

    it('a failed replay fails closed: the table reports not-drained and the failed event stays buffered', async function () {
        const doQuery = sinon.stub().resolves([{ max_id: null }]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sinon.stub(sync, 'localColumns').resolves(new Set(['id']));
        sinon.stub(sync, '_httpGet').resolves({ rows: [{ id: 1 }], watermark: 55 });
        const applyRow = sinon.stub(sync, '_applyRow');
        applyRow.resolves();
        applyRow.withArgs('price_snapshots', sinon.match({ id: 9 })).rejects(new Error('ER_SOMETHING'));
        const refresh = sinon.stub(sync, '_refreshPriceSyncHeight').resolves();
        await sync.handleRowEvent({ type: 'row:inserted', table: 'price_snapshots', row: { id: 9 } });
        await sync.handleRowEvent({ type: 'row:inserted', table: 'price_snapshots', row: { id: 10 } });

        const mark = await sync._bootstrapTable('price_snapshots');
        assert.strictEqual(mark, null, 'flush failure must report not-drained so bootstrapAll retries');
        assert.strictEqual(sync._priceDrained, false, 'live path must not open over the missed round');
        assert.strictEqual(sync._pendingPriceEvents.length, 2, 'failed event and tail stay buffered for the retry');
        assert.ok(refresh.notCalled, 'must not arm the barrier over the hole');
    });
});

describe('HubDbSync live price rows buffer until the price bootstrap drains (#2422) @regression @tier1', function () {
    it('a disconnect racing the drain cannot stale-arm the live path (epoch guard)', async function () {
        const doQuery = sinon.stub().resolves([{ max_id: null }]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sinon.stub(sync, 'localColumns').resolves(new Set(['id']));
        sinon.stub(sync, '_httpGet').resolves({ rows: [], watermark: 55 });
        const refresh = sinon.stub(sync, '_refreshPriceSyncHeight').resolves();
        // Simulate the socket closing while the flush is in flight (the close
        // handler bumps _wsEpoch and resets the per-connection drain state).
        sinon.stub(sync, 'flushPendingPriceEvents').callsFake(async () => { sync._wsEpoch++; return true; });

        const mark = await sync._bootstrapTable('price_snapshots');
        assert.strictEqual(mark, null, 'a raced drain must not certify the table');
        assert.strictEqual(sync._priceDrained, false, 'the NEXT connection must re-buffer until its own re-drain');
        assert.ok(refresh.notCalled);
    });

    it('buffer overflow forces a re-drain instead of opening the gate over dropped events', async function () {
        const { sync } = makeBufferSync();
        sync._pendingPriceEvents = new Array(10000).fill({ type: 'row:inserted', row: { id: 1 } });
        sync.bufferPriceEvent({ type: 'row:inserted', row: { id: 99999 } });
        assert.strictEqual(sync._pendingPriceOverflow, true, 'overflow flagged');
        assert.strictEqual(sync._pendingPriceEvents.length, 0, 'buffer abandoned (rows re-page from the hub)');
        assert.strictEqual(await sync.flushPendingPriceEvents(), false,
            'the flush reports not-drained so bootstrapAll re-pages the dropped rows');
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
        await sync.refreshAllSyncHeights();       // the reconnect-edge proactive refresh
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

        await sync.refreshCallSyncTimestamp();

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

        await sync.refreshCallSyncTimestamp();

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

        await sync.refreshMatchSyncTimestamp();

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

        await sync.refreshMatchSyncTimestamp();

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
    const sqlDir = path.join(__dirname, '..', '..', '..', 'src', 'sql');
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
