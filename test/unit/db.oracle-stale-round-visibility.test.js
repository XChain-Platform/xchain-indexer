/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/unit/db.oracle-stale-round-visibility.test.js
 *
 * VM oracle stale-round visibility flag-day (see
 * src/oracle_stale_round_visibility_activation.js). db.getOracleDataForVM()
 * applied its freshness guard to the `prices` view only: a stale tip round was
 * dropped there while `rounds` still carried the same round, so getPrice()
 * reported "no oracle data" about a round getPriceAtRound() could read. A
 * liveness guard built on getPrice() (the price-bet family's void path) then
 * voids a bet consensus history already decided.
 *
 * At/after the activation height the stale tip is kept with its PRICE WITHHELD
 * ({ price: null, roundNumber, timestamp, stale: true }); below it the row is
 * dropped exactly as before. These tests are mock-based (doQuery stubbed) and
 * lock:
 *   - the GATE: dropped when inert, withheld-price row when active;
 *   - fresh rows are byte-identical either side of the boundary (no `stale`
 *     key, price present);
 *   - `rounds` history is never row-filtered by staleness, in either state
 *     (row-filtering it would empty getPriceAtRound of everything older than
 *     the max age and hand every round-number bet a universal void);
 *   - the activation-module predicate itself.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');
const srv               = require('../../src/oracle_stale_round_visibility_activation');

const PAIR      = 'BTC/USD';
const BLOCK_TS  = 1700000000;
const MAX_AGE   = 1800;

// Rows the two snapshot queries return. `tipTs` drives staleness; the history
// rows are deliberately far older than MAX_AGE so any row-level filter applied
// to `rounds` would erase them.
function rowsFor(tipTs) {
    return {
        tip: [{ coin_pair: PAIR, price: '61000.00000000', round_number: 42, block_timestamp: tipTs }],
        history: [
            { coin_pair: PAIR, price: '61000.00000000', round_number: 42, block_timestamp: tipTs },
            { coin_pair: PAIR, price: '60000.00000000', round_number: 41, block_timestamp: BLOCK_TS - 86400 },
            { coin_pair: PAIR, price: '59000.00000000', round_number: 40, block_timestamp: BLOCK_TS - 172800 }
        ]
    };
}

// A Database whose doQuery answers each of getOracleDataForVM's three queries
// from the canned row set (age query -> empty, tip query -> tip, history -> history).
function dbFor(network, coin, tipTs) {
    const config   = getTestConfig();
    config.NETWORK = network;
    config.COIN    = coin || 'BTC';
    const util     = new Utility();
    sinon.stub(util, 'logError');
    const db   = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    const rows = rowsFor(tipTs);
    sinon.stub(db, 'doQuery').callsFake((query) => {
        if (/MAX\(reference_block\)/i.test(query))  return Promise.resolve([]);
        if (/INNER JOIN/i.test(query))              return Promise.resolve(rows.tip);
        return Promise.resolve(rows.history);
    });
    return db;
}

const STALE_TIP = BLOCK_TS - (MAX_AGE + 60);   // one minute past the max age
const FRESH_TIP = BLOCK_TS - 60;

afterEach(function () { sinon.restore(); });

describe('VM oracle stale-round visibility gate (getOracleDataForVM) @regression @tier1', function () {

    describe('gate: what a STALE tip round looks like to the VM', function () {

        it('mainnet BELOW its per-coin height drops the stale tip (legacy, byte-identical replay)', async function () {
            const db   = dbFor('mainnet', 'BTC', STALE_TIP);   // BTC:mainnet armed at 963000
            const snap = await db.getOracleDataForVM(500, BLOCK_TS, MAX_AGE);
            assert.strictEqual(snap.prices[PAIR], undefined,
                'below the armed height a stale tip must not appear in prices at all');
        });

        it('regtest (genesis-armed) keeps the stale tip with its PRICE WITHHELD', async function () {
            const db   = dbFor('regtest', 'BTC', STALE_TIP);
            const snap = await db.getOracleDataForVM(500, BLOCK_TS, MAX_AGE);
            const tip  = snap.prices[PAIR];
            assert.ok(tip, 'active: the stale tip must still be visible as a round');
            assert.strictEqual(tip.price, null, 'the stale PRICE VALUE stays unreadable');
            assert.strictEqual(tip.roundNumber, 42, 'round identity is what a liveness guard needs');
            assert.strictEqual(tip.timestamp, STALE_TIP, 'consensus timestamp stays readable');
            assert.strictEqual(tip.stale, true, 'withheld rows are marked');
        });

        it('mainnet AT its per-coin height flips to the withheld-price row', async function () {
            const db   = dbFor('mainnet', 'BTC', STALE_TIP);
            const snap = await db.getOracleDataForVM(963000, BLOCK_TS, MAX_AGE);
            assert.ok(snap.prices[PAIR], 'at the armed height the stale tip becomes visible');
            assert.strictEqual(snap.prices[PAIR].price, null);
            assert.strictEqual(snap.prices[PAIR].roundNumber, 42);
        });

        it('the withheld row is what closes the void path: a stale tip at/after settleTime is now readable', async function () {
            // Reproduces the fund-loss shape. settleTime sits BEFORE the stale
            // tip's timestamp, so a qualifying round demonstrably exists; the
            // template's void guard is "latest === null || latest.timestamp <
            // settleTime". Legacy -> latest is null -> the loser voids a decided
            // bet. Gated -> the guard sees the round and blocks the void.
            const settleTime = STALE_TIP - 600;

            const legacy = await dbFor('mainnet', 'BTC', STALE_TIP).getOracleDataForVM(500, BLOCK_TS, MAX_AGE);
            const before = legacy.prices[PAIR] || null;
            assert.ok(before === null || before.timestamp < settleTime,
                'legacy: the void guard passes, so the loser can void a decided bet');

            const gated = await dbFor('regtest', 'BTC', STALE_TIP).getOracleDataForVM(500, BLOCK_TS, MAX_AGE);
            const after = gated.prices[PAIR] || null;
            assert.ok(after !== null && after.timestamp >= settleTime,
                'gated: the void guard fails, so settle() is the only remaining transition');
        });
    });

    describe('fresh rows are untouched on both sides of the boundary', function () {

        it('a FRESH tip is identical inert vs active (price present, no marker)', async function () {
            const inert  = await dbFor('mainnet', 'BTC', FRESH_TIP).getOracleDataForVM(500, BLOCK_TS, MAX_AGE);
            const active = await dbFor('regtest', 'BTC', FRESH_TIP).getOracleDataForVM(500, BLOCK_TS, MAX_AGE);
            assert.deepStrictEqual(inert.prices[PAIR], {
                price: '61000.00000000', roundNumber: 42, timestamp: FRESH_TIP
            });
            assert.deepStrictEqual(active.prices[PAIR], inert.prices[PAIR],
                'the gate must not perturb the fresh-price shape');
            assert.ok(!('stale' in active.prices[PAIR]), 'no marker key on fresh rows');
        });

        it('the guard is disabled by maxAgeSeconds <= 0 in both states', async function () {
            const active = await dbFor('regtest', 'BTC', STALE_TIP).getOracleDataForVM(500, BLOCK_TS, 0);
            assert.strictEqual(active.prices[PAIR].price, '61000.00000000',
                'no max age configured -> nothing is stale -> the price is readable');
            assert.ok(!('stale' in active.prices[PAIR]));
        });
    });

    describe('history is never row-filtered by staleness', function () {

        it('rounds older than the max age stay readable when the gate is ACTIVE', async function () {
            const snap = await dbFor('regtest', 'BTC', STALE_TIP).getOracleDataForVM(500, BLOCK_TS, MAX_AGE);
            // 41 and 40 are a day and two days old: a row-level staleness filter
            // would erase them, emptying getPriceAtRound and handing every
            // round-number bet a universal void.
            assert.strictEqual(snap.rounds[PAIR]['41'].price, '60000.00000000');
            assert.strictEqual(snap.rounds[PAIR]['40'].price, '59000.00000000');
            assert.strictEqual(snap.rounds[PAIR]['42'].price, '61000.00000000',
                'the tip keeps its price in immutable history even while withheld from getPrice');
        });

        it('history is identical inert vs active', async function () {
            const inert  = await dbFor('mainnet', 'BTC', STALE_TIP).getOracleDataForVM(500, BLOCK_TS, MAX_AGE);
            const active = await dbFor('regtest', 'BTC', STALE_TIP).getOracleDataForVM(500, BLOCK_TS, MAX_AGE);
            assert.deepStrictEqual(active.rounds, inert.rounds);
        });
    });

    describe('activation-module predicate', function () {

        it('regtest is active from genesis at any block height', function () {
            assert.strictEqual(srv.isOracleStaleRoundVisibilityActive(0, 'regtest', 'BTC'), true);
            assert.strictEqual(srv.isOracleStaleRoundVisibilityActive(999999, 'regtest', 'BTC'), true);
        });

        it('mainnet is armed per coin: inert below the height, active at/after it', function () {
            assert.strictEqual(srv.isOracleStaleRoundVisibilityActive(962999, 'mainnet', 'BTC'), false);
            assert.strictEqual(srv.isOracleStaleRoundVisibilityActive(963000, 'mainnet', 'BTC'), true);
            assert.strictEqual(srv.isOracleStaleRoundVisibilityActive(3161999, 'mainnet', 'LTC'), false);
            assert.strictEqual(srv.isOracleStaleRoundVisibilityActive(3162000, 'mainnet', 'LTC'), true);
            assert.strictEqual(srv.isOracleStaleRoundVisibilityActive(6337999, 'mainnet', 'DOGE'), false);
            assert.strictEqual(srv.isOracleStaleRoundVisibilityActive(6338000, 'mainnet', 'DOGE'), true);
        });

        it('pinned to the shared pre-freeze deploy-train boundary', function () {
            assert.deepStrictEqual(srv.ORACLE_STALE_ROUND_VISIBILITY_ACTIVATION, {
                'BTC:mainnet':  963000,
                'LTC:mainnet':  3162000,
                'DOGE:mainnet': 6338000,
                testnet: 0,
                regtest: 0
            });
        });

        it('testnet is genesis-active for every coin (pre-launch cohort)', function () {
            assert.strictEqual(srv.isOracleStaleRoundVisibilityActive(0, 'testnet', 'BTC'), true);
            assert.strictEqual(srv.isOracleStaleRoundVisibilityActive(0, 'testnet', 'DOGE'), true);
            assert.strictEqual(srv.isOracleStaleRoundVisibilityActive(999999999, 'testnet', 'LTC'), true);
        });

        it('unknown network or unparseable height is off (safe: keeps deployed behavior)', function () {
            assert.strictEqual(srv.isOracleStaleRoundVisibilityActive(0, 'stagenet', 'BTC'), false);
            assert.strictEqual(srv.isOracleStaleRoundVisibilityActive('nonsense', 'regtest', 'BTC'), false);
            assert.strictEqual(srv.isOracleStaleRoundVisibilityActive(undefined, 'regtest', 'BTC'), false);
        });
    });
});
