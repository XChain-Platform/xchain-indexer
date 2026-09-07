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
const { ORACLE_VM_ROUND_WINDOW } = require('../../src/protocol/constants.js');

// price_snapshots is the one hub-mirrored table nothing prunes: 36 coin pairs at
// the default 600s round interval write ~5,184 rows a day, forever, and EVERY one of them
// was applied - one awaited INSERT at a time - before the price barrier could arm. A fresh
// indexer's time-to-first-block was therefore a function of how long the oracle had been
// running (411,609 rows held a 372-block TBTC reparse for ~13 minutes) rather than of how
// far behind that indexer actually was.
//
// The barrier is correct and is not what these tests relax. What they pin is the BOUND:
// the drain applies the rounds the blocks this node will parse can read (everything at or
// after the consumer's horizon, plus a margin of pre-horizon rounds deep enough to cover
// getOracleDataForVM's round window) and leaves the rest unapplied - while still SEEING
// every row the hub serves, so the reconciliation pass that rests on a complete re-page is
// untouched.
describe('HubDbSync price bootstrap bound @regression @tier2', function () {

    afterEach(function () { sinon.restore(); });

    const HORIZON  = 2000000000;                       // the consumer's horizon, in unix seconds
    const LOOKBACK = HubDbSync.PRICE_MIRROR_LOOKBACK_S;

    // A HubDbSync over a fake local mirror, shaped like the repoint suite's: applied rows
    // land in `rows` through the stubbed _applyRow the way the real upsert would, so what
    // the drain did to the mirror is modelled rather than asserted about.
    function makeSync(local, options) {
        const rows = (local || []).map(r => Object.assign({}, r));
        const seen = { deletes: [] };
        let nextId = rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 100000;

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
                return rows.filter(r => r.status === 'finalized')
                           .map(r => ({ id: r.id, round_number: r.round_number, coin_pair: r.coin_pair }));
            }
            if (/^SELECT MAX\(reference_block\)/.test(sql)) {
                const fin = rows.filter(r => r.status === 'finalized');
                return [{ h:  fin.length ? Math.max.apply(null, fin.map(r => Number(r.reference_block) || 0)) : null,
                          ts: fin.length ? Math.max.apply(null, fin.map(r => Number(r.block_timestamp) || 0)) : null }];
            }
            if (/^SELECT MAX\(id\)/.test(sql)) return [{ max_id: null }];
            return [];
        });

        const sync = new HubDbSync({ doQuery }, Object.assign({
            hubUrl: 'http://hub.test',
            network: 'testnet',
            getPriceMirrorHorizon: async () => HORIZON
        }, options || {}));
        sinon.stub(sync, '_localColumns').resolves(
            new Set(['id', 'round_number', 'coin_pair', 'price', 'reference_block', 'block_timestamp', 'status']));
        sinon.stub(sync, '_applyRow').callsFake(async (t, row) => {
            const i = rows.findIndex(r => String(r.round_number) === String(row.round_number) &&
                                          String(r.coin_pair) === String(row.coin_pair));
            if (i === -1) { rows.push(Object.assign({}, row, { id: nextId++ })); return; }
            if (String(row.status) !== 'finalized') return;
            rows[i] = Object.assign({}, row, { id: rows[i].id });
        });
        sinon.stub(sync, '_flushPendingPriceEvents').resolves(true);
        return { sync, rows, seen };
    }

    function stubHub(sync, hubRows) {
        sinon.stub(sync, '_httpGet').callsFake(async (path) => {
            const since = Number(/since_id=(\d+)/.exec(path)[1]);
            return { rows: hubRows.filter(r => Number(r.id) > since), watermark: 5000 };
        });
    }

    // A finalized round anchored `secondsBeforeHorizon` behind the horizon. Round numbers
    // descend with age exactly as the oracle assigns them.
    function round(id, roundNumber, secondsBeforeHorizon) {
        return { id: id, round_number: roundNumber, coin_pair: 'XCHAIN/USD', price: '1.00',
                 reference_block: 100000 - Math.floor(secondsBeforeHorizon / 600),
                 block_timestamp: HORIZON - secondsBeforeHorizon, status: 'finalized' };
    }

    // The hub's table: `deep` rounds older than the lookback (each one round further back),
    // then `near` rounds inside it, then `future` rounds at or after the horizon. Ids and
    // round numbers both ascend with time, as the hub writes them.
    function hubTable(deep, near, future) {
        const out = [];
        let id = 1, rn = 1;
        for (let i = deep; i > 0; i--)   out.push(round(id++, rn++, LOOKBACK + (i * 600)));
        for (let i = near; i > 0; i--)   out.push(round(id++, rn++, Math.floor((i * LOOKBACK) / (near + 1))));
        for (let i = 0; i < future; i++) out.push(round(id++, rn++, -(i + 1) * 600));
        return out;
    }

    it('keeps the margin the VM round window needs, and no less', function () {
        // The bound's floor exists to cover getOracleDataForVM's preload, which is a count of
        // ROUNDS, VM-visible, and consensus. A mirror holding fewer rounds than a peer hands
        // the VM a different roundFloor and forks the contract hash, so the margin must stay
        // above the constant even if that constant is raised.
        assert.ok(HubDbSync.PRICE_MIRROR_ROUND_MARGIN > ORACLE_VM_ROUND_WINDOW,
            'the mirror margin must exceed the VM round window (' + ORACLE_VM_ROUND_WINDOW + ')');
        assert.ok(HubDbSync.PRICE_MIRROR_MIN_PRE_HORIZON_ROUNDS >= ORACLE_VM_ROUND_WINDOW,
            'the drain must not certify a mirror shallower than the VM round window');
    });

    it('does not replay price history that predates the blocks it will parse', async function () {
        // The item's own verify: the deep rounds are the 80 days of history a fresh indexer
        // was replaying before it could reach its first block.
        const deep = 400, near = 1400, future = 5;
        const { sync, rows } = makeSync([]);
        stubHub(sync, hubTable(deep, near, future));

        assert.strictEqual(await sync._bootstrapTable('price_snapshots'), 5000, 'drain should complete');

        assert.strictEqual(rows.length, near + future,
            'only the rounds inside the mirror floor may be applied');
        const oldest = Math.min.apply(null, rows.map(r => Number(r.block_timestamp)));
        assert.ok(oldest >= HORIZON - LOOKBACK,
            'nothing below the floor may reach the mirror');
        assert.strictEqual(sync._priceMirrorFloorTs, HORIZON - LOOKBACK,
            'the drain must publish the floor it applied');
    });

    it('still bootstraps the whole table when no horizon is supplied', async function () {
        // The explorer vendors this client for a DISPLAY mirror and supplies no horizon;
        // that path must be byte-for-byte the unbounded behavior.
        const { sync, rows } = makeSync([], { getPriceMirrorHorizon: undefined });
        stubHub(sync, hubTable(40, 5, 2));

        await sync._bootstrapTable('price_snapshots');
        assert.strictEqual(rows.length, 47, 'an unbounded consumer mirrors every row');
        assert.strictEqual(sync._priceMirrorFloorTs, 0, 'and declares no floor');
    });

    it('mirrors in full when the horizon cannot be resolved', async function () {
        // Fail-open is the only safe direction: a wrong horizon costs a mirror that is short
        // of what a consensus read needs, and no drain is worth that.
        const { sync, rows } = makeSync([], {
            getPriceMirrorHorizon: async () => { throw new Error('decoder unavailable'); }
        });
        stubHub(sync, hubTable(40, 5, 2));

        await sync._bootstrapTable('price_snapshots');
        assert.strictEqual(rows.length, 47);
    });

    it('mirrors in full when the consumer reports no horizon at all', async function () {
        const { sync, rows } = makeSync([], { getPriceMirrorHorizon: async () => null });
        stubHub(sync, hubTable(40, 5, 2));

        await sync._bootstrapTable('price_snapshots');
        assert.strictEqual(rows.length, 47);
    });

    it('refuses to certify a drain that cut below the VM round window, and widens', async function () {
        // The lookback is a span in SECONDS; the constraint is a count of ROUNDS. On a hub
        // whose round interval is longer than the default, that span holds far fewer rounds
        // than it was sized for, and the drain must notice from its own data rather than
        // trust the arithmetic.
        const { sync } = makeSync([]);
        stubHub(sync, hubTable(300, 10, 2));            // only 10 rounds inside the lookback

        assert.strictEqual(await sync._bootstrapTable('price_snapshots'), null,
            'a mirror shallower than a consensus read can reach must not be certified');
        assert.strictEqual(sync._priceMirrorLookbackS, LOOKBACK * 4, 'the span must widen for the retry');
        assert.strictEqual(sync._priceMirrorFloorTs, 0, 'and no floor may be published');
    });

    it('accepts a drain that kept everything the hub holds below the horizon', async function () {
        // A young chain has less pre-horizon history than the window; keeping all of it is
        // not a short mirror, and must not trigger the widening.
        const { sync, rows } = makeSync([]);
        stubHub(sync, hubTable(0, 12, 3));

        assert.strictEqual(await sync._bootstrapTable('price_snapshots'), 5000);
        assert.strictEqual(rows.length, 15, 'nothing was below the floor, so nothing was bound out');
        assert.strictEqual(sync._priceMirrorLookbackS, LOOKBACK, 'no widening on a complete drain');
    });

    it('leaves history an existing mirror already holds alone', async function () {
        // The bound decides what a bootstrap INSERTS. It must never become a reason to DELETE:
        // an indexer that already mirrored the full history keeps it, and in particular the
        // foreign-round reconciliation must not read "below the floor" as "the hub does not
        // hold this".
        const old = round(1, 1, LOOKBACK * 3);
        const { sync, rows, seen } = makeSync([Object.assign({}, old, { id: 900 })]);
        stubHub(sync, [old].concat(hubTable(0, 1300, 2).map(r => (r.id += 10, r.round_number += 10, r))));

        assert.strictEqual(await sync._bootstrapTable('price_snapshots'), 5000);
        assert.strictEqual(seen.deletes.length, 0, 'a bounded drain deletes nothing');
        assert.ok(rows.some(r => Number(r.id) === 900),
            'pre-existing history below the floor must survive the bounded drain');
    });

    it('abandons the bound and re-mirrors when a block below the floor turns up', async function () {
        // The floor is derived from the oldest block this node expected to process. A block
        // older than that voids the premise: rounds its price reads can select are absent,
        // so the barrier must stop certifying and the table must be re-mirrored in full.
        const { sync } = makeSync([]);
        stubHub(sync, hubTable(400, 1400, 5));
        await sync._bootstrapTable('price_snapshots');
        const floor = sync._priceMirrorFloorTs;
        assert.ok(floor > 0);

        sync.running = true;
        const rebootstrap = sinon.stub(sync, '_bootstrapAll').resolves();
        sync.priceSyncHeight = 999999;                  // the height barrier would otherwise open

        sync._notePriceMirrorFloor(floor - 1);
        assert.strictEqual(sync._priceSyncSatisfied(1, floor - 1), false,
            'the height barrier must stop certifying');
        assert.strictEqual(sync._priceTimeSyncSatisfied(floor - 1), false,
            'and so must the time barrier');
        assert.strictEqual(sync._priceMirrorBoundDisabled, true, 'the bound is abandoned');
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(rebootstrap.callCount, 1, 'a full re-mirror must be scheduled');
    });

    it('leaves the barriers alone for a block at or above the floor', async function () {
        const { sync } = makeSync([]);
        stubHub(sync, hubTable(400, 1400, 5));
        await sync._bootstrapTable('price_snapshots');
        const floor = sync._priceMirrorFloorTs;

        sync._notePriceMirrorFloor(floor);
        assert.strictEqual(sync._priceMirrorBoundDisabled, false);
        assert.strictEqual(sync._priceMirrorRefloor, false);
    });

    it('clears the re-floor once a full drain has landed', async function () {
        const { sync } = makeSync([], { getPriceMirrorHorizon: async () => null });
        sync._priceMirrorRefloor = true;
        stubHub(sync, hubTable(5, 5, 2));

        await sync._bootstrapTable('price_snapshots');
        assert.strictEqual(sync._priceMirrorRefloor, false,
            'a drain that bound nothing IS the full mirror the re-floor was waiting for');
    });

    // A pair the oracle stopped finalizing before the lookback opens. Every row above is
    // XCHAIN/USD, so nothing in the suite so far could see the per-PAIR hole: the retention
    // sets the drain certifies itself against are keyed on round_number with all pairs
    // pooled, and the active pair's rounds satisfy the count on their own.
    function idleRound(id, roundNumber, secondsBeforeHorizon) {
        return { id: id, round_number: roundNumber, coin_pair: 'DOGE/USD', price: '0.10',
                 reference_block: 100000 - Math.floor(secondsBeforeHorizon / 600),
                 block_timestamp: HORIZON - secondsBeforeHorizon, status: 'finalized' };
    }

    // The active table plus an idle pair whose only finalized rows sit below the floor.
    // The idle rows reuse the three oldest round numbers, the way a real round carries every
    // pair at once, so the pooled round counts the acceptance check reads do not move.
    function hubTableWithIdlePair() {
        const base = hubTable(400, 1400, 5);
        const idle = [1, 2, 3].map((rn, i) =>
            idleRound(100000 + i, rn, LOOKBACK + ((400 - rn + 1) * 600)));
        return base.concat(idle);
    }

    // Per-pair latest finalized round: exactly what db.getOracleDataForVM's `prices` join
    // computes, and the quantity a bounded and a full mirror have to agree on.
    function latestByPair(rows) {
        const out = {};
        for (const r of rows) {
            if (String(r.status) !== 'finalized') continue;
            const p = String(r.coin_pair);
            if (out[p] === undefined || Number(r.round_number) > out[p]) out[p] = Number(r.round_number);
        }
        return out;
    }

    it('keeps a pair whose newest finalized round is below the floor', async function () {
        // getOracleDataForVM builds `prices` from a per-pair MAX(round_number) join with NO
        // time filter, so this pair's tip is what a full mirror answers getPrice() with. Drop
        // it and the bounded node answers null where its peers answer a row - VM-visible at
        // and after the stale-round visibility height, and enough for a contract branching on
        // it to commit divergent state.
        const { sync, rows } = makeSync([]);
        stubHub(sync, hubTableWithIdlePair());

        assert.strictEqual(await sync._bootstrapTable('price_snapshots'), 5000, 'drain should complete');

        const idle = rows.filter(r => String(r.coin_pair) === 'DOGE/USD');
        assert.strictEqual(idle.length, 1,
            'the uncovered pair keeps its newest finalized row, and only that one');
        assert.strictEqual(Number(idle[0].round_number), 3,
            'and it is the newest of the rows the bound declined, not an arbitrary one');

        // The covered pair is untouched: retention is conditional, so the bound still holds
        // everywhere it is not closing a per-pair hole.
        const activeBelowFloor = rows.filter(r => String(r.coin_pair) === 'XCHAIN/USD' &&
                                                  Number(r.block_timestamp) < HORIZON - LOOKBACK);
        assert.strictEqual(activeBelowFloor.length, 0,
            'a pair already covered above the floor must not drag its history back in');
    });

    it('answers every latest-price read the way a full mirror does', async function () {
        // The consensus statement, rather than a row count: for the same hub table, the
        // per-pair MAX(round_number) set a bounded mirror serves must equal the unbounded
        // one. That set IS the oracle preload's `prices` view.
        const hubRows = hubTableWithIdlePair();

        const bounded = makeSync([]);
        stubHub(bounded.sync, hubRows);
        assert.strictEqual(await bounded.sync._bootstrapTable('price_snapshots'), 5000);

        const full = makeSync([], { getPriceMirrorHorizon: undefined });
        stubHub(full.sync, hubRows);
        assert.strictEqual(await full.sync._bootstrapTable('price_snapshots'), 5000);

        assert.deepStrictEqual(latestByPair(bounded.rows), latestByPair(full.rows),
            'a bounded mirror and a full mirror must name the same latest round for every pair');
        assert.ok(bounded.rows.length < full.rows.length,
            'and the bound must still be doing its job, not quietly mirroring everything');
    });

    it('bounds nothing on any other mirrored table', async function () {
        const { sync } = makeSync([]);
        stubHub(sync, [{ id: 1, status: 'finalized', block_timestamp: 1 }]);
        await sync._bootstrapTable('oracle_prices');
        assert.strictEqual(sync._applyRow.callCount, 1, 'oracle_prices is not bounded');
    });
});
