// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// FIAT dispenser reverse price matching (claude/specs/DISPENSER_ORACLE_FIAT_PRICE_PLAN.md).
//
// Both matchers decide a CONSENSUS verdict: how many units a bare coin payment
// buys, and whether the dispense is valid at all. dispense.test.js covers the
// four action-level outcomes but stubs both matchers outright, so until now the
// arithmetic that actually settles the money had no direct test. These are the
// parts that fork a ledger if they drift: window bounds, the newest-first
// tiebreak, floor semantics on the unit boundary, and the degenerate price
// inputs a user oracle is allowed to publish.

const assert = require('assert');

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const Utility = require('../../src/utility.js');

// Minimal price DB double. Records the arguments each query was called with so
// the window bounds can be asserted, and returns rows verbatim (the real
// queries already sort newest-first, so ordering is the caller's contract).
function fakeDb(snapshots = [], oraclePrices = []) {
    const calls = { prices: [], oracle: [] };
    return {
        calls,
        async getPricesInTimeRange(coinPair, startTime, endTime) {
            calls.prices.push({ coinPair, startTime, endTime });
            return snapshots.filter(s => s.timestamp >= startTime && s.timestamp <= endTime);
        },
        async getOraclePricesInTimeRange(sourceAddress, coin, tick, fiat, startTime, endTime) {
            calls.oracle.push({ sourceAddress, coin, tick, fiat, startTime, endTime });
            return oraclePrices.filter(o => o.effectiveAt >= startTime && o.effectiveAt <= endTime);
        }
    };
}

const snap = (price, timestamp, roundNumber = 1) => ({ price, timestamp, roundNumber });
const oracle = (price, effectiveAt, actionIndex = 1) => ({ price, effectiveAt, actionIndex, blockTime: effectiveAt });

describe('Utility FIAT dispenser price matching @regression', function () {
    let util;
    const WINDOW = 86400;
    const NOW = 1790000000;

    beforeEach(function () {
        util = new Utility();
    });

    describe('reversePriceMatch() - Mode A, validator snapshot', function () {

        it('floors the multiplier and absorbs the remainder as a tip', async function () {
            // FIAT_AMOUNT 100 at 50000/coin => 0.002 coin per unit.
            // 0.011 coin / 0.002 = 5.5 => 5 units, 0.001 coin kept.
            const db = fakeDb([snap('50000', NOW - 60)]);
            const r = await util.reversePriceMatch('0.011', '100', 'BTC/USD', NOW, WINDOW, db);
            assert(r, 'expected a match');
            assert.strictEqual(r.units, 5);
            // units is a JS number (bcfloor); btcPerToken stays a bignumber.
            assert.strictEqual(String(r.btcPerToken), '0.002');
        });

        it('matches at exactly one unit', async function () {
            const db = fakeDb([snap('50000', NOW - 60)]);
            const r = await util.reversePriceMatch('0.002', '100', 'BTC/USD', NOW, WINDOW, db);
            assert(r, 'a payment covering exactly one unit must match');
            assert.strictEqual(r.units, 1);
        });

        it('returns null one satoshi below one unit', async function () {
            const db = fakeDb([snap('50000', NOW - 60)]);
            const r = await util.reversePriceMatch('0.00199999', '100', 'BTC/USD', NOW, WINDOW, db);
            assert.strictEqual(r, null, 'below one unit is not a dispense');
        });

        it('returns the newest snapshot that yields at least one unit', async function () {
            // Newest is too expensive to afford a unit; the next one down works.
            // Rows arrive newest-first, exactly as the real query orders them.
            const db = fakeDb([
                snap('10000', NOW - 60, 3),
                snap('50000', NOW - 600, 2),
                snap('90000', NOW - 3600, 1)
            ]);
            const r = await util.reversePriceMatch('0.005', '100', 'BTC/USD', NOW, WINDOW, db);
            assert(r, 'expected a match from an older snapshot');
            assert.strictEqual(r.snapshot.roundNumber, 2, 'must stop at the newest AFFORDABLE snapshot');
            assert.strictEqual(r.units, 2);
        });

        it('prefers the newest snapshot when several would match', async function () {
            const db = fakeDb([
                snap('50000', NOW - 60, 2),
                snap('50000', NOW - 600, 1)
            ]);
            const r = await util.reversePriceMatch('0.011', '100', 'BTC/USD', NOW, WINDOW, db);
            assert.strictEqual(r.snapshot.roundNumber, 2);
        });

        it('bounds the query to [block_time - window, block_time]', async function () {
            const db = fakeDb([snap('50000', NOW - 60)]);
            await util.reversePriceMatch('0.011', '100', 'BTC/USD', NOW, WINDOW, db);
            assert.deepStrictEqual(db.calls.prices[0], {
                coinPair: 'BTC/USD', startTime: NOW - WINDOW, endTime: NOW
            });
        });

        it('never matches a snapshot newer than the block being processed', async function () {
            // Causality: a node replaying an old block must not see a price that
            // did not exist yet, or it diverges from the node that processed it live.
            const db = fakeDb([snap('50000', NOW + 1)]);
            const r = await util.reversePriceMatch('0.011', '100', 'BTC/USD', NOW, WINDOW, db);
            assert.strictEqual(r, null, 'a future snapshot must be invisible');
        });

        it('ignores a snapshot older than the window', async function () {
            const db = fakeDb([snap('50000', NOW - WINDOW - 1)]);
            const r = await util.reversePriceMatch('0.011', '100', 'BTC/USD', NOW, WINDOW, db);
            assert.strictEqual(r, null);
        });

        it('returns null when the oracle produced nothing in the window', async function () {
            const r = await util.reversePriceMatch('0.011', '100', 'BTC/USD', NOW, WINDOW, fakeDb([]));
            assert.strictEqual(r, null);
        });
    });

    describe('reverseOraclePriceMatch() - Mode B, user oracle', function () {

        it('cross-converts through the shared fiat currency', async function () {
            // 1 PEPECASH = JPY 7.50, 1 BTC = JPY 15,000,000, pays 0.001 BTC.
            // (0.001 * 15000000) / 7.50 = 2000 tokens.
            const db = fakeDb([snap('15000000', NOW - 600)], [oracle('7.50', NOW - 600)]);
            const r = await util.reverseOraclePriceMatch(
                '0.001', '1OracleAddr', 'BTC', 'PEPECASH', 'JPY', NOW, WINDOW, db);
            assert(r, 'expected a match');
            assert.strictEqual(r.units, 2000);
            assert.strictEqual(r.coinFiatPrice, '15000000');
        });

        it('prices the coin at the ORACLE row effective time, not at block time', async function () {
            // The validator price must be contemporaneous with the oracle quote,
            // otherwise a stale pairing settles at a rate neither side published.
            const db = fakeDb([snap('15000000', NOW - 600)], [oracle('7.50', NOW - 600)]);
            await util.reverseOraclePriceMatch(
                '0.001', '1OracleAddr', 'BTC', 'PEPECASH', 'JPY', NOW, WINDOW, db);
            const call = db.calls.prices[0];
            assert.strictEqual(call.endTime, NOW - 600, 'coin price is fetched as of the oracle effective_at');
            assert.strictEqual(call.startTime, NOW - 600 - WINDOW);
        });

        it('skips an oracle row that has no validator price behind it', async function () {
            // First (newest) oracle row has no coin price in its own window; the
            // loop must continue rather than failing the whole dispense.
            const db = fakeDb(
                [snap('15000000', NOW - 100000)],
                [oracle('7.50', NOW - 10), oracle('7.50', NOW - 90000)]
            );
            const r = await util.reverseOraclePriceMatch(
                '0.001', '1OracleAddr', 'BTC', 'PEPECASH', 'JPY', NOW, WINDOW, db);
            assert.strictEqual(r, null, 'the second row is outside the oracle window, so no match');
            assert.strictEqual(db.calls.prices.length, 1, 'only the in-window oracle row is priced');
        });

        it('returns the newest affordable oracle quote', async function () {
            const db = fakeDb(
                [snap('15000000', NOW - 600), snap('15000000', NOW - 30)],
                [oracle('999999', NOW - 30, 2), oracle('7.50', NOW - 600, 1)]
            );
            const r = await util.reverseOraclePriceMatch(
                '0.001', '1OracleAddr', 'BTC', 'PEPECASH', 'JPY', NOW, WINDOW, db);
            assert(r, 'expected a match from the older, affordable quote');
            assert.strictEqual(r.oraclePrice.actionIndex, 1);
        });

        it('bounds the oracle query to [block_time - window, block_time]', async function () {
            const db = fakeDb([snap('15000000', NOW - 600)], [oracle('7.50', NOW - 600)]);
            await util.reverseOraclePriceMatch(
                '0.001', '1OracleAddr', 'BTC', 'PEPECASH', 'JPY', NOW, WINDOW, db);
            assert.strictEqual(db.calls.oracle[0].startTime, NOW - WINDOW);
            assert.strictEqual(db.calls.oracle[0].endTime, NOW);
        });

        it('returns null when the oracle published nothing in the window', async function () {
            const db = fakeDb([snap('15000000', NOW - 600)], []);
            const r = await util.reverseOraclePriceMatch(
                '0.001', '1OracleAddr', 'BTC', 'PEPECASH', 'JPY', NOW, WINDOW, db);
            assert.strictEqual(r, null);
        });
    });

    // Guards on the inputs a PRICE v1 oracle is actually allowed to publish
    // (actions/price.js validates VALUE only as a positive 8-decimal string, so
    // the minimum publishable price is 0.00000001). See .
    describe('degenerate price inputs', function () {

        it('does not throw on the smallest publishable oracle price at ordinary payment sizes', async function () {
            const db = fakeDb([snap('50000', NOW - 60)], [oracle('0.00000001', NOW - 60)]);
            const r = await util.reverseOraclePriceMatch(
                '0.001', '1OracleAddr', 'BTC', 'PEPECASH', 'USD', NOW, WINDOW, db);
            assert(r, 'expected a match');
            assert.strictEqual(r.units, 5000000000);
        });

        it(': saturates instead of throwing once the count passes MAX_SAFE_INTEGER', async function () {
            // A 1e-8 oracle price on a high-magnitude fiat pair puts the unit
            // count past 2^53-1 for under one coin of payment, sent to an address
            // the operator controls (so the attack costs a tx fee). This used to
            // reach plain bcfloor and throw, and a throw on the block-processing
            // path rolls the block back and retries the same block forever,
            // wedging every indexer on the chain. It must now return a verdict.
            const db = fakeDb([snap('140000000', NOW - 60)], [oracle('0.00000001', NOW - 60)]);
            const r = await util.reverseOraclePriceMatch(
                '1', '1OracleAddr', 'BTC', 'PEPECASH', 'KRW', NOW, WINDOW, db);
            assert(r, 'must return a match rather than throwing');
            assert.strictEqual(r.units, Number.MAX_SAFE_INTEGER,
                'the count saturates at the safe-integer ceiling');
            // Mode A is not reachable at plausible amounts (FIAT_AMOUNT is floored
            // at 2 decimals), but the same guard covers it.
            const dbA = fakeDb([snap('140000000000000', NOW - 60)]);
            const rA = await util.reversePriceMatch('1000000', '0.01', 'BTC/KRW', NOW, WINDOW, dbA);
            assert.strictEqual(rA.units, Number.MAX_SAFE_INTEGER);
        });

        it('bcfloor itself still throws, so non-FIAT consensus math keeps failing loudly', function () {
            // Only the two FIAT unit counts saturate. Every other caller must keep
            // the fail-fast behavior rather than silently returning a lossy integer.
            assert.throws(() => util.bcfloor('9007199254740992'), RangeError);
            assert.strictEqual(util.bcfloorSaturating('9007199254740992'),
                Number.MAX_SAFE_INTEGER);
            // Below the ceiling the two agree exactly.
            assert.strictEqual(util.bcfloor('137.99999999999'), 137);
            assert.strictEqual(util.bcfloorSaturating('137.99999999999'), 137);
        });
    });
});
