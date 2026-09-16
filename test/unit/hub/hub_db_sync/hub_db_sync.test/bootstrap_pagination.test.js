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

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');

// Build a HubDbSync whose enabled flag is true (needs both a hub URL and a hub DB),
// backed by a stubbed doQuery we drive per-test to simulate the local price mirror.
function makeSync(maxReferenceBlock) {
    const doQuery = sinon.stub();
    doQuery.callsFake(async () => [{ h: maxReferenceBlock }]);
    const hubDb = { doQuery };
    const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test' });
    return { sync, hubDb, doQuery };
}

function registerBootstrapPaginationGroup1(PAGE, makeBootstrapSync, fullPage) { it('paginates past a full page and drains with the last page watermark', async function () {
        const sync = makeBootstrapSync();
        const httpGet = sinon.stub(sync, 'httpGet');
        httpGet.onCall(0).resolves({ rows: fullPage(1),        watermark: 111 });
        httpGet.onCall(1).resolves({ rows: [{ id: PAGE + 1 }], watermark: 222 });

        const mark = await sync.bootstrapTable('price_snapshots');
        assert.strictEqual(mark, 222, 'must drain and return the LAST page watermark');
        assert.strictEqual(httpGet.callCount, 2);
        assert.ok(httpGet.secondCall.args[0].includes('since_id=' + PAGE),
            'second page must resume from the first page cursor: ' + httpGet.secondCall.args[0]);
        assert.strictEqual(sync.applyRow.callCount, PAGE + 1, 'every row from every page applied');
    }); }

function registerBootstrapPaginationGroup2(PAGE, makeBootstrapSync, fullPage) { it('a single short page still drains in one fetch', async function () {
        const sync = makeBootstrapSync();
        sinon.stub(sync, 'httpGet').resolves({ rows: [{ id: 1 }, { id: 2 }], watermark: 99 });
        assert.strictEqual(await sync.bootstrapTable('oracle_prices'), 99);
    }); }

function registerBootstrapPaginationGroup3(PAGE, makeBootstrapSync, fullPage) { it('capability_snapshots bootstraps from since_id=0 regardless of local MAX(id) (#2270)', async function () {
        const sync = makeBootstrapSync();
        sinon.stub(sync, 'localColumns').resolves(new Set(['id', 'snapshot_block']));
        sync.hubDb.doQuery = sinon.stub().resolves([{ max_id: 500 }]);   // local rows exist
        const httpGet = sinon.stub(sync, 'httpGet').resolves({ rows: [{ id: 3 }], watermark: 7 });
        assert.strictEqual(await sync.bootstrapTable('capability_snapshots'), 7);
        assert.ok(httpGet.firstCall.args[0].includes('since_id=0'),
            'must page from 0, not local MAX(id): ' + httpGet.firstCall.args[0]);
    }); }

function registerBootstrapPaginationGroup4(PAGE, makeBootstrapSync, fullPage) { ['price_snapshots', 'cross_chain_calls', 'cross_chain_matches'].forEach((table) => {
        it(`${table} bootstraps from since_id=0 regardless of local MAX(id) to re-fetch in-place upgrades (#2491)`, async function () {
            const sync = makeBootstrapSync();
            sinon.stub(sync, 'localColumns').resolves(new Set(['id', 'status']));
            sync.hubDb.doQuery = sinon.stub().resolves([{ max_id: 500 }]);   // local rows already present
            const httpGet = sinon.stub(sync, 'httpGet').resolves({ rows: [{ id: 3 }], watermark: 7 });
            await sync.bootstrapTable(table);
            assert.ok(httpGet.firstCall.args[0].includes('since_id=0'),
                `${table} must page from 0, not local MAX(id): ` + httpGet.firstCall.args[0]);
        });
    }); }

function registerBootstrapPaginationGroup5(PAGE, makeBootstrapSync, fullPage) { describe('cross_chain_matches missed-retraction reconciliation (#3211)', function () {

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
            sinon.stub(sync, 'httpGet').resolves({ rows: [{ id: 1, match_id: 'M1' }, { id: 3, match_id: 'M3' }], watermark: 7 });
            await sync.bootstrapTable('cross_chain_matches');
            assert.deepStrictEqual(updates, [[2]], 'only the unserved row converges');
        });

        it('never touches a row ABOVE the highest served id (it may just be newer than the snapshot)', async function () {
            const { sync, updates } = makeReconcileSync([{ id: 3, match_id: 'M3' }, { id: 9, match_id: 'NEWER' }]);
            sinon.stub(sync, 'httpGet').resolves({ rows: [{ id: 3, match_id: 'M3' }], watermark: 7 });
            await sync.bootstrapTable('cross_chain_matches');
            assert.deepStrictEqual(updates, [], 'a row past the served ceiling is exempt');
        });

        it('does NOT reconcile on a partial drain (an unfetched page is not evidence of a retraction)', async function () {
            const { sync, updates } = makeReconcileSync([{ id: 1, match_id: 'M1' }, { id: 2, match_id: 'UNSEEN' }]);
            // A full page means more rows remain; the loop stops on the apply hole below.
            sync.applyRow.onSecondCall().rejects(new Error('ER_SOMETHING'));
            sinon.stub(sync, 'httpGet').resolves({ rows: [{ id: 1, match_id: 'M1' }, { id: 2, match_id: 'X' }], watermark: 7 });
            await sync.bootstrapTable('cross_chain_matches');
            assert.deepStrictEqual(updates, [], 'a holed/partial drain must never reconcile');
        });

        it('is a no-op when the hub served nothing at all (empty mirror, no ceiling to judge against)', async function () {
            const { sync, updates } = makeReconcileSync([{ id: 1, match_id: 'M1' }]);
            sinon.stub(sync, 'httpGet').resolves({ rows: [], watermark: 7 });
            await sync.bootstrapTable('cross_chain_matches');
            assert.deepStrictEqual(updates, []);
        });

        it('runs for cross_chain_matches only, never for a sibling mirror table', async function () {
            for (const table of ['cross_chain_calls', 'price_snapshots', 'capability_snapshots']) {
                const { sync, updates } = makeReconcileSync([{ id: 2, match_id: 'GONE' }]);
                sinon.stub(sync, 'httpGet').resolves({ rows: [{ id: 1 }, { id: 3 }], watermark: 7 });
                await sync.bootstrapTable(table);
                assert.deepStrictEqual(updates, [], table + ' must not run the match reconciliation');
            }
        });
    }); }

function registerBootstrapPaginationGroup6(PAGE, makeBootstrapSync, fullPage) { it('_applyRow strips the wire id for capability_snapshots so a local PK can never collide (#2270)', async function () {
        const doQuery = sinon.stub().resolves([]);
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        sinon.stub(sync, 'localColumns').resolves(
            new Set(['id', 'snapshot_block', 'capability', 'signing_pubkey', 'amount', 'source']));
        await sync.applyRow('capability_snapshots',
            { id: 42, snapshot_block: 1, capability: 'cross_chain', signing_pubkey: 'aa', amount: '10', source: 's1' });
        const [query, args] = doQuery.firstCall.args;
        const colList = query.slice(query.indexOf('(') + 1, query.indexOf(')'));
        assert.ok(!colList.split(',').map(c => c.trim()).includes('id'),
            'id must not be inserted: ' + query);
        assert.ok(!args.includes(42), 'wire id must not ride the args');
    }); }

function registerBootstrapPaginationGroup7(PAGE, makeBootstrapSync, fullPage) { it('returns null (gate closed) when any row fails to apply, even after paging', async function () {
        const sync = makeBootstrapSync();
        sync.applyRow.onFirstCall().rejects(new Error('ER_SOMETHING'));
        const httpGet = sinon.stub(sync, 'httpGet');
        httpGet.onCall(0).resolves({ rows: fullPage(1),        watermark: 111 });
        httpGet.onCall(1).resolves({ rows: [{ id: PAGE + 1 }], watermark: 222 });
        assert.strictEqual(await sync.bootstrapTable('price_snapshots'), null);
    }); }

function registerBootstrapPaginationGroup8(PAGE, makeBootstrapSync, fullPage) { it('a partial bootstrap schedules a retry (WS mode has no poll loop)', async function () {
        const clock = sinon.useFakeTimers();
        try {
            const sync = makeBootstrapSync();
            sync.running = true;
            const bootstrapTable = sinon.stub(sync, 'bootstrapTable');
            bootstrapTable.onCall(0).resolves(null);    // price_snapshots fails round 1
            bootstrapTable.resolves(123);               // everything drains afterwards

            await sync.bootstrapAll();
            assert.strictEqual(sync._bootstrapDrained, false, 'gate closed after partial drain');

            await clock.tickAsync(sync.pollIntervalMs + 1);
            assert.strictEqual(sync._bootstrapDrained, true, 'retry must re-attempt and open the gate');
            assert.strictEqual(sync.streamWatermark, 123);
        } finally {
            clock.restore();
        }
    }); }

function registerBootstrapPaginationGroup9(PAGE, makeBootstrapSync, fullPage) { it('does not schedule retries once drained or when stopped', async function () {
        const clock = sinon.useFakeTimers();
        try {
            const sync = makeBootstrapSync();
            sync.running = false;                       // stopped: no retry even on failure
            const bootstrapTable = sinon.stub(sync, 'bootstrapTable').resolves(null);
            await sync.bootstrapAll();
            await clock.tickAsync(sync.pollIntervalMs * 3);
            assert.strictEqual(bootstrapTable.callCount, 10, 'one pass over the 10 mirrored tables, no retries');
        } finally {
            clock.restore();
        }
    }); }

describe('HubDbSync bootstrap pagination + retry @regression @tier2', function () {

    // Regression (prod incident 2026-06-11): bootstrapTable fetched ONE page and
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
        sinon.stub(sync, 'applyRow').resolves();
        sinon.stub(sync, 'refreshPriceSyncHeight').resolves();
        sinon.stub(sync, 'refreshOracleSyncTimestamp').resolves();
        sinon.stub(sync, 'refreshMatchSyncTimestamp').resolves();
        sinon.stub(sync, 'releaseSnapshotWaiters').resolves();
        return sync;
    }

    function fullPage(startId) {
        return Array.from({ length: PAGE }, (_, i) => ({ id: startId + i }));
    }

    registerBootstrapPaginationGroup1(PAGE, makeBootstrapSync, fullPage);
    registerBootstrapPaginationGroup2(PAGE, makeBootstrapSync, fullPage);

    // capability_snapshots is a natural-key mirror. Local ids are locally
    // assigned (recovery rebuilds id-less; hub ids are hub-local), so seeding the
    // cursor from local MAX(id) silently skips hub rows, and applying a wire id
    // collides with a local PK where INSERT IGNORE drops the row.
    registerBootstrapPaginationGroup3(PAGE, makeBootstrapSync, fullPage);

    // The three in-place-UPGRADED tables must ALSO bootstrap from since_id=0, so a row
    // upgraded on the hub under its unchanged id (price_snapshots skipped->finalized,
    // cross_chain_calls re-finalized, cross_chain_matches anchor_txid) while this mirror was
    // disconnected is re-delivered and converged by its idempotent applyRow ODKU. A
    // since_id=MAX(local id) cursor is INSERT-shaped and would strand the pre-upgrade row.
    registerBootstrapPaginationGroup4(PAGE, makeBootstrapSync, fullPage);

    // The missed-retraction half no ODKU can reach: the hub's snapshot endpoint filters
    // `status <> 'retracted'`, so a match retracted while this mirror was disconnected is
    // ABSENT from every bootstrap page. There is no row to converge against, and the stale
    // local copy keeps settling a match the hub retracted. After a COMPLETE re-page, a local
    // finalized row at or below the highest served id whose match_id was never served can
    // only be such a retraction (hub-parity ascending ids; the hub never deletes a match).
    registerBootstrapPaginationGroup5(PAGE, makeBootstrapSync, fullPage);
    registerBootstrapPaginationGroup6(PAGE, makeBootstrapSync, fullPage);

    registerBootstrapPaginationGroup7(PAGE, makeBootstrapSync, fullPage);
    registerBootstrapPaginationGroup8(PAGE, makeBootstrapSync, fullPage);

    registerBootstrapPaginationGroup9(PAGE, makeBootstrapSync, fullPage);
});

describe('HubDbSync _applyRow column filtering @regression @tier2', function () {

    // Regression (fleet incident 2026-06-11): the hub's state_checkpoints gained
    // the anchor_txid audit column (ANCHOR rollout) which the indexer-side mirror
    // schema deliberately omits; the unfiltered INSERT turned every mirrored
    // checkpoint into ER_BAD_FIELD_ERROR and silently killed the mirror fleet-wide.
    // applyRow must drop hub-served columns the local table does not carry.

    function makeApplySync(localCols) {
        const doQuery = sinon.stub();
        doQuery.withArgs(sinon.match(/^SHOW COLUMNS/)).resolves(localCols.map(f => ({ Field: f })));
        doQuery.resolves([]); // default for the INSERT
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
        return { sync, doQuery };
    }

    it('drops hub-only columns (anchor_txid) instead of erroring', async function () {
        const { sync, doQuery } = makeApplySync(['id', 'chain', 'block_index']);
        await sync.applyRow('state_checkpoints', { id: 1, chain: 'LTC', block_index: 5, anchor_txid: 'ff' });
        const insert = doQuery.getCalls().find(c => /^INSERT IGNORE/.test(c.args[0]));
        assert.ok(insert, 'INSERT must still run');
        assert.ok(!insert.args[0].includes('anchor_txid'), 'hub-only column must be filtered out');
        assert.deepStrictEqual(insert.args[1], [1, 'LTC', 5]);
    });

    it('passes through rows whose columns all exist locally', async function () {
        const { sync, doQuery } = makeApplySync(['id', 'chain']);
        await sync.applyRow('state_checkpoints', { id: 2, chain: 'BTC' });
        const insert = doQuery.getCalls().find(c => /^INSERT IGNORE/.test(c.args[0]));
        assert.ok(insert.args[0].includes('(id, chain)'));
    });

    it('no-ops when nothing intersects the local schema', async function () {
        const { sync, doQuery } = makeApplySync(['id']);
        await sync.applyRow('state_checkpoints', { mystery: 'x' });
        assert.ok(!doQuery.getCalls().some(c => /^INSERT/.test(c.args[0])), 'no INSERT for an empty column set');
    });

    it('caches the local column set per table (one SHOW COLUMNS per table)', async function () {
        const { sync, doQuery } = makeApplySync(['id']);
        await sync.applyRow('state_checkpoints', { id: 1 });
        await sync.applyRow('state_checkpoints', { id: 2 });
        const shows = doQuery.getCalls().filter(c => /^SHOW COLUMNS/.test(c.args[0]));
        assert.strictEqual(shows.length, 1);
    });
});
