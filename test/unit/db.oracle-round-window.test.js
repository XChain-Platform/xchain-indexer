/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/db.oracle-round-window.test.js
 *
 * The VM-visible oracle round window (db.getOracleDataForVM).
 *
 * WHAT WENT WRONG. The preload was a flat 50,000-row cap taken newest-first, and
 * nothing downstream could see the edge of it. A contract asking for a round that
 * had scrolled out got the same null as for a round that never existed, and the
 * price-bet templates vote their void guard on precisely that null
 * (getPriceAtRound(settleRound) === null), so the LOSER of a bet that consensus
 * history had already settled could reclaim their stake by waiting. The row cap
 * had been exceeded for roughly seventy days by the time it was measured -
 * 389,752 finalized rows against a 50,000-row cap, 7.8x over - which at 36 coin
 * pairs left the VM about 1,388 of ~10,826 rounds, a window shrinking by ~5,184
 * rows a day. Nothing had broken only because no contract had ever executed on any
 * live network, so this code path had never once run for real.
 *
 * WHAT THIS FILE PINS:
 *   1. The window is denominated in ROUNDS, so adding a coin pair cannot shrink it.
 *   2. The floor is EXACT: it is the oldest round the payload guarantees, and it is
 *      0 when nothing was evicted (a young chain holds all its history).
 *   3. The row ceiling, when it bites, raises the floor ABOVE the oldest loaded
 *      round instead of claiming coverage the payload does not have, and the
 *      partial round is dropped rather than shipped half-answered.
 *   4. The row budget still fits the live pair count, so a future pair-count
 *      increase reddens here rather than quietly shrinking the window again.
 *
 * price_snapshots is ONE hub-mirrored set: every chain path reads identical rows,
 * so all of this is fleet-wide rather than per chain.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');
const { ORACLE_VM_ROUND_WINDOW, ORACLE_VM_MAX_ROWS } = require('../../src/protocol/constants.js');

const PAIR_A   = 'BTC/USD';
const PAIR_B   = 'LTC/USD';
const BLOCK    = 900000;
const BLOCK_TS = 1700000000;

// Live pair count on the mainnet oracle at the time the window was sized. The
// payload is rounds x pairs, so this is the other half of the budget.
const LIVE_PAIRS = 36;

function priceRow(pair, round) {
    return { coin_pair: pair, price: '60000.00000000', round_number: round, block_timestamp: BLOCK_TS - round };
}

/**
 * A Database whose doQuery answers getOracleDataForVM's four queries from canned
 * data. `history` is returned in the DESC order the real query guarantees, and the
 * DISTINCT-round query is answered from `distinctRounds` so a case can drive the
 * "window is full" branch without materializing a window's worth of rows.
 */
function dbFor({ distinctRounds, history }) {
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    const calls = [];
    sinon.stub(db, 'doQuery').callsFake((query, args) => {
        calls.push({ query, args });
        if (/MAX\(reference_block\)/i.test(query))      return Promise.resolve([]);
        if (/INNER JOIN/i.test(query))                  return Promise.resolve([]);
        if (/SELECT DISTINCT round_number/i.test(query))
            return Promise.resolve(distinctRounds.map(r => ({ round_number: r })));
        // The row query is bounded by the floor the caller computed, so answer it
        // the way the engine would rather than handing back everything.
        const floor = Number(args[1]);
        return Promise.resolve(history.filter(r => Number(r.round_number) >= floor));
    });
    db._oracleCalls = calls;
    return db;
}

function roundQueryCall(db) {
    return db._oracleCalls.find(c => /round_number >= \?/.test(c.query));
}

afterEach(function () { sinon.restore(); });

describe('VM oracle round window (getOracleDataForVM) @regression @tier1', function () {

    describe('a chain holding less history than the window', function () {

        it('reports floor 0, because nothing is hidden', async function () {
            // Regtest and a fresh testnet live here permanently. A non-zero floor
            // would make every round below the oldest published one read as
            // "evicted", and a contract would refuse to void a bet on a round that
            // genuinely never happened.
            const db = dbFor({
                distinctRounds: [3, 2, 1],
                history: [priceRow(PAIR_A, 3), priceRow(PAIR_A, 2), priceRow(PAIR_A, 1)]
            });

            const snap = await db.getOracleDataForVM(BLOCK, BLOCK_TS, 0);

            assert.strictEqual(snap.roundFloor, 0);
            assert.deepStrictEqual(Object.keys(snap.rounds[PAIR_A]).sort(), ['1', '2', '3']);
        });

        it('binds that floor into the row query, so no history is excluded', async function () {
            const db = dbFor({ distinctRounds: [2, 1], history: [priceRow(PAIR_A, 2), priceRow(PAIR_A, 1)] });

            await db.getOracleDataForVM(BLOCK, BLOCK_TS, 0);

            assert.deepStrictEqual(roundQueryCall(db).args, [BLOCK, 0]);
        });
    });

    describe('a chain past the window', function () {

        // The DISTINCT query is capped at the window, so a full result means older
        // rounds exist beyond it. Its last row is therefore the oldest round the
        // payload covers, and everything below it is unknowable rather than absent.
        const fullWindow = Array.from({ length: ORACLE_VM_ROUND_WINDOW }, (_, i) => 5000 - i);
        const FLOOR      = 5000 - (ORACLE_VM_ROUND_WINDOW - 1);

        it('reports the oldest round the window covers as the floor', async function () {
            const db = dbFor({ distinctRounds: fullWindow, history: [priceRow(PAIR_A, 5000)] });

            const snap = await db.getOracleDataForVM(BLOCK, BLOCK_TS, 0);

            assert.strictEqual(snap.roundFloor, FLOOR);
        });

        it('loads rows from the floor up, not the newest N rows', async function () {
            // The distinction that makes the window pair-count independent: the row
            // query is bounded by a ROUND, so a pair added tomorrow adds rows inside
            // the same window instead of pushing rounds out of it.
            const db = dbFor({ distinctRounds: fullWindow, history: [priceRow(PAIR_A, 5000)] });

            await db.getOracleDataForVM(BLOCK, BLOCK_TS, 0);

            assert.deepStrictEqual(roundQueryCall(db).args, [BLOCK, FLOOR]);
        });

        it('carries the floor to the VM, which is the whole point of computing it', async function () {
            const db = dbFor({ distinctRounds: fullWindow, history: [priceRow(PAIR_A, 5000)] });

            const snap = await db.getOracleDataForVM(BLOCK, BLOCK_TS, 0);

            // xchain-vm/src/readonly-accessors.js turns a read below this into a
            // distinguishable "outside the loaded window" answer. Absent, it is the
            // same null as "never existed" and the loser-reclaim is back.
            assert.strictEqual(typeof snap.roundFloor, 'number');
            assert.ok(snap.roundFloor > 0);
        });
    });

    describe('the row ceiling', function () {

        // Enough rows to hit the ceiling, with the OLDEST round deliberately
        // partial: two pairs everywhere except round 1, which carries only one.
        // That is exactly the shape the ceiling produces, because it truncates
        // newest-first and lands mid-round.
        function ceilingHistory() {
            const rows = [];
            const top  = Math.floor(ORACLE_VM_MAX_ROWS / 2);
            // A third pair on the newest round makes the row count land so that the
            // truncation falls mid-round, which is what a real ceiling does.
            rows.push(priceRow(PAIR_A, top), priceRow(PAIR_B, top), priceRow('DOGE/USD', top));
            for (let r = top - 1; r >= 2; r--)
                rows.push(priceRow(PAIR_A, r), priceRow(PAIR_B, r));
            rows.push(priceRow(PAIR_A, 1));            // round 1: PAIR_A only, PAIR_B cut off
            return rows;
        }

        it('raises the floor above the oldest loaded round, which may be partial', async function () {
            const history = ceilingHistory();
            const oldestLoaded = Number(history[history.length - 1].round_number);
            const db = dbFor({ distinctRounds: [], history });

            const snap = await db.getOracleDataForVM(BLOCK, BLOCK_TS, 0);

            assert.strictEqual(history.length, ORACLE_VM_MAX_ROWS, 'precondition: the ceiling bites');
            assert.strictEqual(snap.roundFloor, oldestLoaded + 1,
                'a round the ceiling cut in half is not covered, and must not be claimed');
        });

        it('drops the partial round rather than shipping it half-answered', async function () {
            // A half-loaded round is worse than a missing one: it answers "never
            // existed" for the pairs the ceiling cut off, which is the ambiguity the
            // floor exists to remove.
            const history = ceilingHistory();
            const oldestLoaded = Number(history[history.length - 1].round_number);
            const db = dbFor({ distinctRounds: [], history });

            const snap = await db.getOracleDataForVM(BLOCK, BLOCK_TS, 0);

            assert.strictEqual(snap.rounds[PAIR_A][String(oldestLoaded)], undefined,
                'the round below the floor must not appear in the payload');
            assert.strictEqual(snap.rounds[PAIR_B][String(oldestLoaded)], undefined,
                'and the pair the ceiling cut off must not read as "never existed" there');
            assert.ok(snap.rounds[PAIR_A][String(oldestLoaded + 1)],
                'the first fully covered round must');
        });
    });

    describe('the row budget', function () {

        it('fits the live pair count, so pair growth cannot silently shrink the window', async function () {
            // The failure this replaces was invisible: the flat row cap made the
            // window a function of the pair count, and every pair added took rounds
            // away with no signal anywhere. If a future pair count breaks this
            // arithmetic, the ceiling starts truncating and the guaranteed window
            // falls below the constant - visible here rather than in a stuck bet.
            assert.ok(ORACLE_VM_ROUND_WINDOW * LIVE_PAIRS <= ORACLE_VM_MAX_ROWS,
                ORACLE_VM_ROUND_WINDOW + ' rounds x ' + LIVE_PAIRS + ' pairs exceeds the ' +
                ORACLE_VM_MAX_ROWS + '-row ceiling: either raise the ceiling or lower the window');
        });

        it('keeps the window whole-round and the ceiling a backstop, not the window', function () {
            assert.ok(Number.isInteger(ORACLE_VM_ROUND_WINDOW) && ORACLE_VM_ROUND_WINDOW > 0);
            assert.ok(Number.isInteger(ORACLE_VM_MAX_ROWS) && ORACLE_VM_MAX_ROWS > ORACLE_VM_ROUND_WINDOW);
        });
    });
});
