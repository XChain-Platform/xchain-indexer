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

// A bootstrap never dropped capability_snapshots rows the current hub does not carry
// (#1837). The table has no `network` column, so _mirrorNetworkScope returns null and
// both purge paths are unreachable, and being a FULL_REPAGE table its cursor is forced
// to 0 so the id-ceiling fence never runs either. The re-page then converges only the
// uq_cap_snap keys the two hubs SHARE; a row from a retired hub at a block boundary the
// current one has never reached is never addressed. MEASURED 2026-08-28: both testnet
// indexer mirrors held 43 rows at snapshot_block 957439, a BTC MAINNET height inherited
// from the retired mainnet hub, on a testnet mirror that was never going to converge.
describe('HubDbSync capability snapshot mirror repoint @regression @tier2', function () {

    afterEach(function () { sinon.restore(); });

    // A HubDbSync over a fake local mirror. `local` is the simulated table content;
    // applied rows land in it through the stubbed _applyRow the same way the real apply
    // would (id-less INSERT IGNORE on uq_cap_snap, local AUTO_INCREMENT), so the drain's
    // own effect on the mirror - including the ids it assigns - is modelled, not assumed.
    function makeSync(local, opts) {
        const rows = (local || []).map(r => Object.assign({}, r));
        const seen = { deletes: [], selects: [] };
        let nextId = rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;

        const doQuery = sinon.stub().callsFake(async (sql, args) => {
            if (/^DELETE FROM capability_snapshots WHERE id IN/.test(sql)) {
                seen.deletes.push(args.slice());
                for (const id of args) {
                    const i = rows.findIndex(r => Number(r.id) === Number(id));
                    if (i !== -1) rows.splice(i, 1);
                }
                return { affectedRows: args.length };
            }
            if (/^SELECT id, snapshot_block, capability, signing_pubkey, source FROM capability_snapshots/.test(sql)) {
                seen.selects.push('keys');
                return rows.map(r => ({ id: r.id, snapshot_block: r.snapshot_block, capability: r.capability,
                                        signing_pubkey: r.signing_pubkey, source: r.source }));
            }
            if (/^SELECT id FROM capability_snapshots WHERE id <= \? AND snapshot_block > \?/.test(sql)) {
                seen.selects.push('ceiling');
                return rows.filter(r => Number(r.id) <= Number(args[0]) &&
                                        Number(r.snapshot_block) > Number(args[1]))
                           .map(r => ({ id: r.id }));
            }
            if (/^SELECT MAX\(id\)/.test(sql)) {
                const max = rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
                return [{ max_id: max || null }];
            }
            return [];
        });

        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', network: 'testnet' });
        // No `network` column - that absence is the whole reason the two existing purges
        // cannot defend this table, so the fixture must reproduce it.
        sinon.stub(sync, '_localColumns').resolves(
            new Set(['id', 'snapshot_block', 'capability', 'signing_pubkey', 'amount', 'source']));
        sinon.stub(sync, '_applyRow').callsFake(async (t, row) => {
            if (opts && opts.refuseApply) return false;         // chain-identity fence refusal
            const i = rows.findIndex(r => String(r.snapshot_block) === String(row.snapshot_block) &&
                                          String(r.capability) === String(row.capability) &&
                                          String(r.signing_pubkey) === String(row.signing_pubkey) &&
                                          String(r.source || '') === String(row.source || ''));
            if (i !== -1) return;                               // INSERT IGNORE no-op on the natural key
            // The wire id is stripped and a LOCAL id assigned; that is what lets the
            // reconciliation tell a row that predates the drain from one applied during it.
            rows.push(Object.assign({}, row, { id: nextId++ }));
        });
        return { sync, rows, seen, doQuery };
    }

    // Serve a hub table honestly over the ascending since_id page walk.
    function stubHub(sync, hubRows) {
        sinon.stub(sync, '_httpGet').callsFake(async (path) => {
            const since = Number(/since_id=(\d+)/.exec(path)[1]);
            return { rows: hubRows.filter(r => Number(r.id) > since), watermark: 5000 };
        });
    }

    function snap(id, block, pubkey, source) {
        return { id: id, snapshot_block: block, capability: 'cross_chain',
                 signing_pubkey: pubkey, amount: '100', source: source || 'src1' };
    }

    it('clears the retired hub validator sets a repoint leaves behind', async function () {
        // The prod shape: the mirror followed a mainnet hub (snapshot_block 957439) and now
        // follows a testnet one whose boundaries are far lower. The re-page addresses the
        // testnet boundaries and can never touch 957439: no shared natural key.
        const { sync, rows } = makeSync([snap(1, 957439, 'aa'), snap(2, 957439, 'bb'),
                                         snap(3, 90000, 'aa')]);
        stubHub(sync, [snap(11, 90000, 'aa'), snap(12, 90001, 'aa')]);

        assert.strictEqual(await sync._bootstrapTable('capability_snapshots'), 5000, 'drain should complete');

        const blocks = rows.map(r => Number(r.snapshot_block)).sort((a, b) => a - b);
        assert.deepStrictEqual(blocks, [90000, 90001],
            'the mirror must hold exactly the snapshots this hub serves');
        assert.ok(!rows.some(r => Number(r.snapshot_block) === 957439),
            'the mainnet-height rows a future capability would read stake from must be gone');
    });

    it('keeps a row the hub still serves under a second source', async function () {
        // uq_cap_snap is four columns on purpose: one key delegated by two sources is two
        // rows. A three-column key here would call the second source unserved and delete it.
        const { sync, rows } = makeSync([snap(1, 90000, 'aa', 'srcA'), snap(2, 90000, 'aa', 'srcB')]);
        stubHub(sync, [snap(11, 90000, 'aa', 'srcA'), snap(12, 90000, 'aa', 'srcB')]);

        await sync._bootstrapTable('capability_snapshots');
        assert.strictEqual(rows.length, 2, 'both sources are held by this hub');
        assert.deepStrictEqual(rows.map(r => r.source).sort(), ['srcA', 'srcB']);
    });

    it('touches nothing when the mirror already holds exactly what the hub serves', async function () {
        const { sync, rows, seen } = makeSync([snap(1, 90000, 'aa'), snap(2, 90001, 'aa')]);
        stubHub(sync, [snap(11, 90000, 'aa'), snap(12, 90001, 'aa')]);

        await sync._bootstrapTable('capability_snapshots');
        assert.strictEqual(seen.deletes.length, 0, 'a converged mirror must not be touched');
        assert.strictEqual(rows.length, 2);
    });

    it('clears the mirror when the hub serves an empty table (a rebuilt hub)', async function () {
        const { sync, rows } = makeSync([snap(1, 957439, 'aa')]);
        stubHub(sync, []);

        await sync._bootstrapTable('capability_snapshots');
        assert.deepStrictEqual(rows, [], 'a hub holding nothing means the mirror holds nothing');
    });

    it('never judges a row that arrived while the drain ran', async function () {
        // Live WS events on this table apply immediately rather than buffering, so a row
        // broadcast after the pages passed its id would look unserved. Ids are locally
        // assigned and ascending, so anything above the pre-drain mark is exempt.
        const { sync, rows } = makeSync([snap(1, 90000, 'aa')]);
        stubHub(sync, [snap(11, 90000, 'aa')]);
        const preMax = 1;
        // Simulate the live arrival by inserting it directly, exactly as _applyRow would.
        rows.push({ id: 500, snapshot_block: 90002, capability: 'cross_chain',
                    signing_pubkey: 'cc', amount: '100', source: 'src1' });

        await sync._reconcileForeignCapabilitySnapshots(
            new Set([[90000, 'cross_chain', 'aa', 'src1'].join(' ')]), true, 90000, preMax);

        assert.ok(rows.some(r => Number(r.id) === 500),
            'a row inserted during the drain is above the pre-drain mark and must survive');
    });

    it('never reconciles a PARTIAL drain', async function () {
        // Absence from the served set only proves anything after a complete re-page.
        const { sync, rows, seen } = makeSync([snap(1, 957439, 'aa')]);
        stubHub(sync, [snap(11, 90000, 'aa')]);
        sync._applyRow.restore();
        sinon.stub(sync, '_applyRow').rejects(new Error('bad row'));

        assert.strictEqual(await sync._bootstrapTable('capability_snapshots'), null,
            'an apply error must report the table not drained');
        assert.strictEqual(seen.deletes.length, 0, 'a holed drain must delete nothing');
        assert.strictEqual(rows.length, 1);
    });

    it('never reconciles a table that is not capability_snapshots', async function () {
        const { sync, seen } = makeSync([]);
        stubHub(sync, [{ id: 1 }]);
        await sync._bootstrapTable('oracle_prices');
        assert.strictEqual(seen.selects.length, 0, 'the pass is capability_snapshots-only');
        assert.strictEqual(seen.deletes.length, 0);
    });

    it('refuses to delete when no served key matches, which is a key-derivation fault', async function () {
        // Every row the drain served was applied moments ago, so at least one must read back
        // into the served set. If none does, the two sides are not producing the same key.
        const { sync, seen } = makeSync([snap(1, 957439, 'aa')]);
        stubHub(sync, [snap(11, 90000, 'aa')]);
        // Break the read-back side only, exactly as a column rename would: the local table
        // reports every row under a different capability spelling.
        const real = sync.hubDb.doQuery;
        sync.hubDb.doQuery = sinon.stub().callsFake(async (sql, args) => {
            if (/^SELECT id, snapshot_block, capability, signing_pubkey, source FROM capability_snapshots/.test(sql))
                return [{ id: 1, snapshot_block: 957439, capability: 'xchain', signing_pubkey: 'aa', source: 'src1' },
                        { id: 2, snapshot_block: 90000, capability: 'xchain', signing_pubkey: 'aa', source: 'src1' }];
            return real(sql, args);
        });

        await sync._bootstrapTable('capability_snapshots');
        assert.strictEqual(seen.deletes.length, 0, 'a total mismatch is a bug signal, not contamination');
    });

    it('keeps bootstrapping when the reconciliation read itself fails', async function () {
        const { sync } = makeSync([snap(1, 957439, 'aa')]);
        stubHub(sync, [snap(11, 90000, 'aa')]);
        const real = sync.hubDb.doQuery;
        sync.hubDb.doQuery = sinon.stub().callsFake(async (sql, args) => {
            if (/^SELECT id, snapshot_block, capability, signing_pubkey, source FROM capability_snapshots/.test(sql))
                throw new Error('mirror read failed');
            return real(sql, args);
        });
        assert.strictEqual(await sync._bootstrapTable('capability_snapshots'), 5000,
            'a failed reconciliation must not report the table undrained');
    });

    it('does not delete a local twin of a row the chain fence refused to apply', async function () {
        // A refusal is this mirror declining to TAKE a row the hub demonstrably HOLDS; that
        // is reported on its own path and must not become a deletion warrant here.
        const { sync, rows } = makeSync([snap(1, 90000, 'aa')], { refuseApply: true });
        stubHub(sync, [snap(11, 90000, 'aa')]);

        await sync._bootstrapTable('capability_snapshots');
        assert.strictEqual(rows.length, 1, 'the hub serves this key, so the local row stands');
    });

    it('falls back to the snapshot_block ceiling when the served-key set overflows its cap', async function () {
        // Above the cap, absence from the set proves nothing, so the pass drops to the
        // weaker rule that needs no set: nothing above the highest boundary the hub served.
        const { sync, rows, seen } = makeSync([snap(1, 957439, 'aa'), snap(2, 90000, 'bb')]);
        await sync._reconcileForeignCapabilitySnapshots(new Set(), false, 90000, 2);

        assert.ok(seen.selects.includes('ceiling'), 'the fallback must use the ceiling read');
        assert.ok(!rows.some(r => Number(r.snapshot_block) === 957439),
            'the mainnet height is above the ceiling');
        assert.ok(rows.some(r => Number(r.snapshot_block) === 90000),
            'the fallback must not reach below the ceiling');
    });

    it('deletes nothing when the mirror was empty before the drain', async function () {
        const { sync, rows, seen } = makeSync([]);
        stubHub(sync, [snap(11, 90000, 'aa')]);

        await sync._bootstrapTable('capability_snapshots');
        assert.strictEqual(seen.deletes.length, 0, 'nothing predates the drain');
        assert.strictEqual(rows.length, 1);
    });
});
