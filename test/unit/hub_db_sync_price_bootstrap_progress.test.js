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

// A fresh indexer's price_snapshots drain is every round the hub has ever finalized, and
// its cost IS the drain: one awaited INSERT round-trip per row - 411,747 rows measured on
// one production hub, ~13 minutes of deferred blocks - reported by a single log line after
// the fact, so a cold start was indistinguishable from a wedge.
//
// These tests pin the two things that changed and, more importantly, the several that must
// not have: the mirror's contents, the accounting, and the stop-at-the-first-unappliable-row
// rule are identical whether a chunk went out as one statement or as N.
describe('HubDbSync price bootstrap throughput and progress @regression @tier2', function () {

    afterEach(function () { sinon.restore(); });

    const COLS = ['id', 'round_number', 'coin_pair', 'price', 'reference_block', 'block_timestamp', 'status'];

    // A HubDbSync over a fake local mirror that applies the REAL statements this module
    // emits. Unlike the bound suite (which stubs _applyRow to model the upsert), this one
    // decodes `INSERT INTO price_snapshots ... VALUES (...), (...)` back into rows, so a
    // batched drain and a per-row drain are measured through the same door and can be
    // compared row for row.
    //
    // `batchOk` decides what the multi-row statement returns: the driver's OK object (the
    // statement ran) or doQuery's swallowed-error `[]` default (it did not).
    function makeSync(options, batchOk) {
        const rows  = [];                                  // the mirror, keyed naturally below
        const stmts = [];                                  // every INSERT this drain emitted
        const key   = (r) => String(r.round_number) + '/' + String(r.coin_pair);

        const upsert = (row) => {
            const i = rows.findIndex(r => key(r) === key(row));
            if (i === -1) { rows.push(Object.assign({}, row)); return; }
            // The ODKU body: content moves only when the INCOMING row is finalized.
            if (String(row.status) === 'finalized') rows[i] = Object.assign({}, row);
        };

        const doQuery = sinon.stub().callsFake(async (sql, args) => {
            const m = /^INSERT INTO price_snapshots \(([^)]*)\) VALUES /.exec(sql);
            if (m) {
                const cols  = m[1].split(', ').map(c => c.replace(/`/g, ''));
                const count = args.length / cols.length;
                stmts.push({ sql: sql, rows: count });
                if (count > 1 && batchOk === false) return [];   // doQuery's swallowed-error default
                for (let i = 0; i < args.length; i += cols.length) {
                    const row = {};
                    cols.forEach((c, j) => { row[c] = args[i + j]; });
                    upsert(row);
                }
                return { affectedRows: count };
            }
            if (/^SELECT id, round_number, coin_pair FROM price_snapshots/.test(sql)) {
                return rows.filter(r => String(r.status) === 'finalized')
                           .map(r => ({ id: r.id, round_number: r.round_number, coin_pair: r.coin_pair }));
            }
            if (/^SELECT MAX\(reference_block\)/.test(sql)) {
                const fin = rows.filter(r => String(r.status) === 'finalized');
                return [{ h:  fin.length ? Math.max.apply(null, fin.map(r => Number(r.reference_block) || 0)) : null,
                          ts: fin.length ? Math.max.apply(null, fin.map(r => Number(r.block_timestamp) || 0)) : null }];
            }
            if (/^SELECT MAX\(id\)/.test(sql)) return [{ max_id: null }];
            return [];
        });

        const sync = new HubDbSync({ doQuery }, Object.assign({
            hubUrl: 'http://hub.test',
            network: 'testnet'
            // No getPriceMirrorHorizon: this is the FRESH-node shape the item is about,
            // where the bound has nothing to remove and every row must be applied.
        }, options || {}));
        sinon.stub(sync, '_localColumns').resolves(new Set(COLS));
        sinon.stub(sync, '_flushPendingPriceEvents').resolves(true);
        return { sync, rows, stmts, doQuery };
    }

    function stubHub(sync, hubRows) {
        sinon.stub(sync, '_httpGet').callsFake(async (path) => {
            const since = Number(/since_id=(\d+)/.exec(path)[1]);
            return { rows: hubRows.filter(r => Number(r.id) > since), watermark: 5000 };
        });
    }

    // `n` finalized rounds, ids and round numbers ascending exactly as the hub writes them.
    function hubTable(n, status) {
        const out = [];
        for (let i = 1; i <= n; i++)
            out.push({ id: i, round_number: i, coin_pair: 'XCHAIN/USD', price: '1.0' + i,
                       reference_block: 100000 + i, block_timestamp: 1900000000 + (i * 600),
                       status: status || 'finalized' });
        return out;
    }

    it('emits ONE statement per chunk instead of one per row', async function () {
        // The whole point: a fresh node's drain is dominated by round-trips, and the row
        // count is the hub's price history, which only grows.
        const { sync, rows, stmts } = makeSync({ batchApplyRows: 50 });
        stubHub(sync, hubTable(500));

        assert.strictEqual(await sync._bootstrapTable('price_snapshots'), 5000, 'drain should complete');
        assert.strictEqual(rows.length, 500, 'every row the hub served must reach the mirror');
        assert.strictEqual(stmts.length, 10, '500 rows at 50 per chunk is 10 statements, not 500');
        assert.ok(stmts.every(s => s.rows === 50), 'every statement should carry a full chunk');
    });

    it('mirrors exactly what the per-row path mirrors', async function () {
        // Equivalence is the claim that lets this land at all. Same hub table, both paths,
        // compared row for row - including the skipped -> finalized upgrade, which is the
        // one piece of the ODKU body that is consensus-relevant.
        const table = hubTable(120).concat([
            // A round first served as a 'skipped' placeholder and later upgraded, both
            // inside one chunk, so the multi-row statement has to converge them itself.
            { id: 200, round_number: 200, coin_pair: 'XCHAIN/USD', price: null,
              reference_block: 100200, block_timestamp: 1900120000, status: 'skipped' },
            { id: 201, round_number: 200, coin_pair: 'XCHAIN/USD', price: '9.99',
              reference_block: 100200, block_timestamp: 1900120000, status: 'finalized' },
            // And the reverse order, which must NOT clobber the finalized row.
            { id: 202, round_number: 300, coin_pair: 'XCHAIN/USD', price: '7.77',
              reference_block: 100300, block_timestamp: 1900130000, status: 'finalized' },
            { id: 203, round_number: 300, coin_pair: 'XCHAIN/USD', price: null,
              reference_block: 100300, block_timestamp: 1900130000, status: 'skipped' }
        ]);

        const batched = makeSync({ batchApplyRows: 64 });
        stubHub(batched.sync, table);
        await batched.sync._bootstrapTable('price_snapshots');

        const perRow = makeSync({ batchApply: false });
        stubHub(perRow.sync, table);
        await perRow.sync._bootstrapTable('price_snapshots');

        assert.ok(perRow.stmts.every(s => s.rows === 1), 'the control must really be per-row');
        assert.ok(batched.stmts.length < perRow.stmts.length, 'and the batched drain must really batch');

        const sort = (rs) => rs.slice().sort((a, b) => Number(a.round_number) - Number(b.round_number));
        assert.deepStrictEqual(sort(batched.rows), sort(perRow.rows),
            'the batched mirror must be the per-row mirror, row for row');
        const upgraded = batched.rows.find(r => String(r.round_number) === '200');
        assert.strictEqual(String(upgraded.status), 'finalized', 'skipped -> finalized must still upgrade');
        assert.strictEqual(upgraded.price, '9.99');
        const kept = batched.rows.find(r => String(r.round_number) === '300');
        assert.strictEqual(kept.price, '7.77', 'a later skipped row must never clobber a finalized one');
    });

    it('builds the batched statement from the same source as the per-row statement', async function () {
        // The ODKU body is the consensus-relevant half of this file. Two copies of it would
        // be two chances to diverge, so there is one builder and this is the proof.
        const cols = ['round_number', 'coin_pair', 'price', 'status'];
        const one  = HubDbSync.priceUpsertSql(cols, 1);
        const many = HubDbSync.priceUpsertSql(cols, 3);
        assert.strictEqual(one.split(' ON DUPLICATE KEY UPDATE ')[1],
                           many.split(' ON DUPLICATE KEY UPDATE ')[1],
                           'both arities must carry the identical ODKU body');
        assert.strictEqual(many.split(' ON DUPLICATE KEY UPDATE ')[0],
                           one.split(' ON DUPLICATE KEY UPDATE ')[0] + ', (?, ?, ?, ?), (?, ?, ?, ?)',
                           'the batch is the same statement with more value tuples');

        // And the per-row applier really does emit priceUpsertSql(cols, 1).
        const { sync, doQuery } = makeSync({ batchApply: false });
        await sync._applyRow('price_snapshots', { round_number: 1, coin_pair: 'XCHAIN/USD',
                                                  price: '1.00', status: 'finalized' });
        assert.strictEqual(doQuery.firstCall.args[0], one);
    });

    it('falls back to per-row applies when the batched statement does not land', async function () {
        // doQuery SWALLOWS a non-transactional query error and returns its [] default, so a
        // batch that failed is indistinguishable from one that did nothing. Reading that as
        // failure and re-applying one at a time is what keeps a failed batch from becoming a
        // silent mirror hole.
        const { sync, rows, stmts } = makeSync({ batchApplyRows: 25 }, false);
        stubHub(sync, hubTable(100));

        assert.strictEqual(await sync._bootstrapTable('price_snapshots'), 5000);
        assert.strictEqual(rows.length, 100, 'every row must still reach the mirror');
        assert.ok(stmts.some(s => s.rows > 1), 'the batch was attempted');
        assert.strictEqual(stmts.filter(s => s.rows === 1).length, 100,
            'and every row was then applied on its own');
    });

    it('still stops the page at the first unappliable row', async function () {
        // BOOTSTRAP-HOLE-1. Batching must not let a bad row be stepped over: an apply that
        // throws has to leave that row and everything after it unapplied, and report the
        // table not-drained so _bootstrapAll retries with the barrier shut.
        const { sync, rows } = makeSync({ batchApplyRows: 1000 });
        stubHub(sync, hubTable(40));
        const real = sync._applyRow.bind(sync);
        sinon.stub(sync, '_applyRow').callsFake(async (t, row) => {
            if (Number(row.id) === 17) throw new Error('column does not exist');
            return real(t, row);
        });
        // Force the per-row path, which is where a throwing apply is visible at all.
        sinon.stub(sync, '_applyRowsBatched').resolves(false);

        assert.strictEqual(await sync._bootstrapTable('price_snapshots'), null,
            'a holed drain must not be certified');
        assert.strictEqual(rows.length, 16, 'nothing at or after the bad row may be applied');
        assert.ok(rows.every(r => Number(r.id) < 17));
    });

    it('declines to batch anything but price_snapshots', async function () {
        const { sync } = makeSync();
        assert.strictEqual(await sync._applyRowsBatched('oracle_prices', hubTable(4)), false);
        assert.strictEqual(await sync._applyRowsBatched('cross_chain_matches', hubTable(4)), false);
    });

    it('declines to batch rows whose mirrored columns differ', async function () {
        // One placeholder tuple has to be correct for every row in the statement. A page
        // mixing row shapes goes back to the per-row path rather than misaligning args.
        const { sync } = makeSync();
        const mixed = [hubTable(1)[0], { id: 2, round_number: 2, coin_pair: 'XCHAIN/USD', status: 'finalized' }];
        assert.strictEqual(await sync._applyRowsBatched('price_snapshots', mixed), false);
    });

    it('declines to batch when the rows carry no status column', async function () {
        // Without `status` the per-row applier takes its generic INSERT IGNORE branch, not
        // the price ODKU, and the batch must not silently substitute a different statement.
        const { sync } = makeSync();
        sync._localColumns.resolves(new Set(['id', 'round_number', 'coin_pair', 'price']));
        const noStatus = hubTable(4).map(r => ({ id: r.id, round_number: r.round_number,
                                                 coin_pair: r.coin_pair, price: r.price }));
        assert.strictEqual(await sync._applyRowsBatched('price_snapshots', noStatus), false);
    });

    it('reports a progress counter while a long drain is running', async function () {
        // The operator-facing half of the item: at 15% CPU with no output, a working drain
        // and a wedged one look the same. The counter names rows fetched, rows applied, the
        // page, and the cursor.
        const logged = [];
        sinon.stub(console, 'log').callsFake((...a) => logged.push(a.join(' ')));
        // A real drain of this size takes microseconds; run the wall clock forward past the
        // throttle per reading, so the counter sees the elapsed time a 411k-row drain would.
        let fakeNow = 1750000000000;
        sinon.stub(Date, 'now').callsFake(() => (fakeNow += 20000));

        const { sync } = makeSync({ batchApplyRows: 10, bootstrapProgressMs: 15000 });
        stubHub(sync, hubTable(100));
        await sync._bootstrapTable('price_snapshots');

        const progress = logged.filter(l => /bootstrapping price_snapshots/.test(l));
        assert.ok(progress.length >= 2, 'a long drain must report more than once');
        assert.ok(/\d+ row\(s\) fetched/.test(progress[0]), 'the line must carry a row counter');
        assert.ok(/page \d+/.test(progress[0]), 'and the page it is on');
        assert.ok(/through id \d+/.test(progress[0]), 'and how far through the id space it has read');
    });

    it('stays silent on a drain that finishes inside the progress interval', async function () {
        // Nothing changes for the small mirrored tables: the counter is for the drain that
        // is long enough to worry an operator, not for every bootstrap.
        const logged = [];
        sinon.stub(console, 'log').callsFake((...a) => logged.push(a.join(' ')));

        const { sync } = makeSync({ batchApplyRows: 10 });   // default 15s interval
        stubHub(sync, hubTable(30));
        await sync._bootstrapTable('price_snapshots');

        assert.strictEqual(logged.filter(l => /bootstrapping price_snapshots/.test(l)).length, 0);
        assert.ok(logged.some(l => /bootstrapped 30 rows into price_snapshots/.test(l)),
            'the end-of-drain summary is unchanged');
    });

    it('announces a drain the hub says is bigger than one page', async function () {
        // The hub states its own MAX(id) per table in the subscription ready message. Where
        // that says the table is large, say so before the first page rather than after the
        // last one.
        const logged = [];
        sinon.stub(console, 'log').callsFake((...a) => logged.push(a.join(' ')));

        const { sync } = makeSync();
        sync._readyMaxIds = { price_snapshots: 411747 };
        stubHub(sync, hubTable(5));
        await sync._bootstrapTable('price_snapshots');

        assert.ok(logged.some(l => /draining price_snapshots from id 0 \(the hub reports 411747/.test(l)),
            'the drain must announce the size the hub told it about');
    });

    it('honours the batching off switch', async function () {
        // Throughput work with no barrier depending on it gets a plain off switch, so an
        // operator who suspects it can take it out of the picture without a code change.
        const { sync, stmts } = makeSync({ batchApply: false });
        stubHub(sync, hubTable(40));
        await sync._bootstrapTable('price_snapshots');
        assert.ok(stmts.every(s => s.rows === 1), 'every statement must be a single row');

        const prev = process.env.HUB_SYNC_BATCH_APPLY;
        process.env.HUB_SYNC_BATCH_APPLY = 'false';
        try {
            const env = makeSync();
            stubHub(env.sync, hubTable(40));
            await env.sync._bootstrapTable('price_snapshots');
            assert.ok(env.stmts.every(s => s.rows === 1), 'HUB_SYNC_BATCH_APPLY=false must disable it too');
        } finally {
            if (prev === undefined) delete process.env.HUB_SYNC_BATCH_APPLY;
            else process.env.HUB_SYNC_BATCH_APPLY = prev;
        }
    });
});
