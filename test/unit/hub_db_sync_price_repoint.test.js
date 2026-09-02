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

// Repointing an indexer at a different hub (another network, a rebuilt
// database, a re-genesised testnet) purges state_checkpoints, which carries a
// `network` column, but leaves price_snapshots contaminated: it has no such column,
// so both purge paths are unreachable for it, and being a FULL_REPAGE table its
// cursor is forced to 0 so the id-ceiling fence never runs either. The re-page then
// converges only the (round_number, coin_pair) keys the two hubs SHARE; a foreign
// round numbered above anything the new hub has reached is never addressed, and
// every consensus read of this table takes the newest finalized row by round_number
// (db.getLatestPrice ORDER BY round_number DESC LIMIT 1, the native fee gate's price
// source). The mirror then serves a stale price forever on a correct config.
describe('HubDbSync price mirror repoint @regression @tier2', function () {

    afterEach(function () { sinon.restore(); });

    // A HubDbSync over a fake local mirror. `local` is the simulated table content as
    // {id, round_number, coin_pair, status} rows; applied rows land in it through the
    // stubbed _applyRow the same way the real upsert would (insert-or-replace on the
    // natural key), so the drain's own effect on the mirror is modelled, not assumed.
    function makeSync(local) {
        const rows = (local || []).map(r => Object.assign({}, r));
        const seen = { deletes: [], selects: [] };
        let nextId = rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1000;

        const doQuery = sinon.stub().callsFake(async (sql, args) => {
            if (/^DELETE FROM price_snapshots WHERE id IN/.test(sql)) {
                seen.deletes.push(args.slice());
                for (const id of args) {
                    const i = rows.findIndex(r => Number(r.id) === Number(id));
                    if (i !== -1) rows.splice(i, 1);
                }
                return { affectedRows: args.length };
            }
            if (/^SELECT id, round_number, coin_pair FROM price_snapshots/.test(sql)) {
                seen.selects.push('keys');
                return rows.filter(r => r.status === 'finalized')
                           .map(r => ({ id: r.id, round_number: r.round_number, coin_pair: r.coin_pair }));
            }
            if (/^SELECT id FROM price_snapshots WHERE status = 'finalized' AND round_number > \?/.test(sql)) {
                seen.selects.push('ceiling');
                return rows.filter(r => r.status === 'finalized' && Number(r.round_number) > Number(args[0]))
                           .map(r => ({ id: r.id }));
            }
            if (/^SELECT MAX\(reference_block\)/.test(sql)) {
                const fin = rows.filter(r => r.status === 'finalized');
                return [{ h: fin.length ? Math.max.apply(null, fin.map(r => Number(r.reference_block) || 0)) : null,
                          ts: fin.length ? Math.max.apply(null, fin.map(r => Number(r.block_timestamp) || 0)) : null }];
            }
            if (/^SELECT MAX\(id\)/.test(sql)) return [{ max_id: null }];
            return [];
        });

        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', network: 'testnet' });
        // price_snapshots carries no `network` column - that absence is the whole reason
        // the two existing purges cannot defend it, so the fixture must reproduce it.
        sinon.stub(sync, '_localColumns').resolves(
            new Set(['id', 'round_number', 'coin_pair', 'price', 'reference_block', 'block_timestamp', 'status']));
        sinon.stub(sync, '_applyRow').callsFake(async (t, row) => {
            const i = rows.findIndex(r => String(r.round_number) === String(row.round_number) &&
                                          String(r.coin_pair) === String(row.coin_pair));
            if (i === -1) { rows.push(Object.assign({}, row, { id: nextId++ })); return; }
            // The real upsert is status-gated: it overwrites an existing key ONLY when the
            // INCOMING row is finalized, so a skipped placeholder can never clobber a
            // finalize. Modelling that is the point - it is why a repoint strands the
            // previous hub's price at a round the new hub holds as skipped.
            if (String(row.status) !== 'finalized') return;
            rows[i] = Object.assign({}, row, { id: rows[i].id });
        });
        // The buffered-replay path is exercised by its own suite; here it must simply
        // not veto the drain.
        sinon.stub(sync, '_flushPendingPriceEvents').resolves(true);
        return { sync, rows, seen, doQuery };
    }

    // Serve a hub table honestly over the ascending since_id page walk.
    function stubHub(sync, hubRows) {
        sinon.stub(sync, '_httpGet').callsFake(async (path) => {
            const since = Number(/since_id=(\d+)/.exec(path)[1]);
            return { rows: hubRows.filter(r => Number(r.id) > since), watermark: 5000 };
        });
    }

    function finalized(id, round, pair, block) {
        return { id: id, round_number: round, coin_pair: pair, price: '1.00',
                 reference_block: block, block_timestamp: 1000 + round, status: 'finalized' };
    }

    it('clears the previous hub rounds a repoint leaves behind', async function () {
        // The mirror followed a hub that had reached round 900. The new hub is at round 3.
        // The re-page addresses rounds 1-3 and cannot touch 900: no shared natural key.
        const { sync, rows } = makeSync([
            finalized(500, 900, 'XCHAIN/USD', 880),
            finalized(501, 899, 'LTC/USD', 879)
        ]);
        stubHub(sync, [finalized(1, 1, 'XCHAIN/USD', 1), finalized(2, 2, 'XCHAIN/USD', 2),
                       finalized(3, 3, 'XCHAIN/USD', 3)]);

        assert.strictEqual(await sync._bootstrapTable('price_snapshots'), 5000, 'drain should complete');

        const survivors = rows.map(r => Number(r.round_number)).sort((a, b) => a - b);
        assert.deepStrictEqual(survivors, [1, 2, 3],
            'the mirror must hold exactly the rounds this hub serves');
        assert.ok(!rows.some(r => Number(r.round_number) === 900),
            'the foreign round that wins every ORDER BY round_number DESC read must be gone');
    });

    it('leaves the price height at the current hub rather than the retired one', async function () {
        // The barrier height is MAX(reference_block) over finalized rows, so a foreign
        // round also parks the height in the old chain's block space.
        const { sync } = makeSync([finalized(500, 900, 'XCHAIN/USD', 880000)]);
        stubHub(sync, [finalized(1, 1, 'XCHAIN/USD', 7)]);

        await sync._bootstrapTable('price_snapshots');
        assert.strictEqual(sync.priceSyncHeight, 7,
            'height must come from the hub this mirror follows');
    });

    it('touches nothing when the mirror already holds exactly what the hub serves', async function () {
        const { sync, rows, seen } = makeSync([finalized(1, 1, 'XCHAIN/USD', 1),
                                               finalized(2, 2, 'XCHAIN/USD', 2)]);
        stubHub(sync, [finalized(1, 1, 'XCHAIN/USD', 1), finalized(2, 2, 'XCHAIN/USD', 2)]);

        await sync._bootstrapTable('price_snapshots');
        assert.strictEqual(seen.deletes.length, 0, 'a converged mirror must not be touched');
        assert.strictEqual(rows.length, 2);
    });

    it('clears a stale finalized row at a round this hub holds as skipped', async function () {
        // The status-gated upsert deliberately refuses to downgrade finalized -> skipped
        // (within one hub's stream a skipped placeholder must never clobber a finalize).
        // Across a repoint that same rule strands the previous hub's price at a round the
        // new hub never finalized, and no later delivery can move it.
        const { sync, rows } = makeSync([finalized(500, 2, 'XCHAIN/USD', 900)]);
        stubHub(sync, [
            finalized(1, 1, 'XCHAIN/USD', 1),
            { id: 2, round_number: 2, coin_pair: 'XCHAIN/USD', price: null,
              reference_block: 2, block_timestamp: 1002, status: 'skipped' }
        ]);

        await sync._bootstrapTable('price_snapshots');
        const r2 = rows.filter(r => Number(r.round_number) === 2);
        assert.ok(!r2.some(r => r.status === 'finalized'),
            'a finalized row the hub holds as skipped is not this hub\'s row');
    });

    it('leaves local skipped rows alone', async function () {
        // No consensus read sees them (every query filters status='finalized') and the
        // upsert converges them in place, so they are outside this pass.
        const { sync, rows } = makeSync([
            { id: 400, round_number: 77, coin_pair: 'XCHAIN/USD', price: null,
              reference_block: 77, block_timestamp: 1077, status: 'skipped' }
        ]);
        stubHub(sync, [finalized(1, 1, 'XCHAIN/USD', 1)]);

        await sync._bootstrapTable('price_snapshots');
        assert.ok(rows.some(r => Number(r.round_number) === 77 && r.status === 'skipped'),
            'skipped rows are not reconciled');
    });

    it('clears the mirror when the hub serves an empty table (a rebuilt hub)', async function () {
        const { sync, rows } = makeSync([finalized(500, 900, 'XCHAIN/USD', 880)]);
        stubHub(sync, []);

        await sync._bootstrapTable('price_snapshots');
        assert.deepStrictEqual(rows, [], 'a hub holding nothing means the mirror holds nothing');
    });

    it('never reconciles a PARTIAL drain', async function () {
        // Absence from the served set only proves anything after a complete re-page.
        // A drain that stopped on an apply error has not seen every row the hub holds.
        const { sync, rows, seen } = makeSync([finalized(500, 900, 'XCHAIN/USD', 880)]);
        stubHub(sync, [finalized(1, 1, 'XCHAIN/USD', 1)]);
        sync._applyRow.restore();
        sinon.stub(sync, '_applyRow').rejects(new Error('bad row'));

        assert.strictEqual(await sync._bootstrapTable('price_snapshots'), null,
            'an apply error must report the table not drained');
        assert.strictEqual(seen.deletes.length, 0, 'a holed drain must delete nothing');
        assert.strictEqual(rows.length, 1);
    });

    it('never reconciles a table that is not price_snapshots', async function () {
        const { sync, seen } = makeSync([]);
        stubHub(sync, [{ id: 1, status: 'finalized' }]);
        await sync._bootstrapTable('oracle_prices');
        assert.strictEqual(seen.selects.length, 0, 'the pass is price_snapshots-only');
    });

    it('refuses to delete when no served key matches, which is a key-derivation fault', async function () {
        // Every finalized row the drain served was applied moments ago, so it must read
        // back into the served set. If none does, the two sides are not producing the
        // same key and the pass would empty a healthy mirror.
        const { sync, seen } = makeSync([]);
        stubHub(sync, [finalized(1, 1, 'XCHAIN/USD', 1)]);
        // Break the read-back side only: the local table reports rounds under a
        // different pair spelling, exactly as a column rename would.
        sync._applyRow.restore();
        sinon.stub(sync, '_applyRow').resolves();
        sync.hubDb.doQuery = sinon.stub().callsFake(async (sql) => {
            if (/^SELECT id, round_number, coin_pair FROM price_snapshots/.test(sql))
                return [{ id: 9, round_number: 1, coin_pair: 'xchain/usd' }];
            if (/^DELETE FROM price_snapshots/.test(sql)) { seen.deletes.push(1); return { affectedRows: 1 }; }
            if (/^SELECT MAX\(id\)/.test(sql)) return [{ max_id: null }];
            return [];
        });

        await sync._bootstrapTable('price_snapshots');
        assert.strictEqual(seen.deletes.length, 0, 'a total mismatch is a bug signal, not contamination');
    });

    it('keeps bootstrapping when the reconciliation read itself fails', async function () {
        const { sync } = makeSync([]);
        stubHub(sync, [finalized(1, 1, 'XCHAIN/USD', 1)]);
        const real = sync.hubDb.doQuery;
        sync.hubDb.doQuery = sinon.stub().callsFake(async (sql, args) => {
            if (/^SELECT id, round_number, coin_pair FROM price_snapshots/.test(sql))
                throw new Error('mirror read failed');
            return real(sql, args);
        });
        assert.strictEqual(await sync._bootstrapTable('price_snapshots'), 5000,
            'a failed reconciliation must not report the table undrained');
    });

    it('falls back to the round ceiling when the served-key set overflows its cap', async function () {
        // Above the cap, absence from the set proves nothing, so the pass drops to the
        // weaker rule that needs no set: nothing above the highest round the hub served.
        const { sync, rows, seen } = makeSync([finalized(500, 900, 'XCHAIN/USD', 880),
                                               finalized(501, 1, 'LTC/USD', 1)]);
        stubHub(sync, [finalized(1, 1, 'XCHAIN/USD', 1), finalized(2, 2, 'XCHAIN/USD', 2)]);
        await sync._reconcileForeignPriceRounds(new Set(), false, 2);

        assert.ok(seen.selects.includes('ceiling'), 'the fallback must use the ceiling read');
        assert.ok(!rows.some(r => Number(r.round_number) === 900), 'round 900 is above the ceiling');
        assert.ok(rows.some(r => Number(r.round_number) === 1),
            'the fallback must not reach below the ceiling');
    });
});
