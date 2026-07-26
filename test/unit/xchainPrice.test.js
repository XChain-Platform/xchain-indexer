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
 * test/unit/xchainPrice.test.js
 *
 * XCHAIN price derivation from platform-realized fills (, step 1 of the
 * spec's implementation sketch: the pure formula, no wiring).
 *
 * This arithmetic will feed native-coin fee validation on LTC and DOGE, so the
 * cases below cover the manipulation shapes the spec's §5 threat model names,
 * not merely "does the average work": wash-trading in BOTH directions (cheap
 * fees vs griefing those chains into unusability), recyclable self-dealt volume,
 * and giveaway fills.
 */

'use strict';

const assert  = require('assert');
const Utility = require('../../src/utility.js');
const { deriveXchainRate, referenceRateFromUsd, toUsd } = require('../../src/xchainPrice.js');

// A fill as the caller will shape it from order_matches / dispenses: how much
// XCHAIN moved and how much BTC was paid for it.
const fill = (xchainAmount, coinAmount, venue = 'dex') => ({ xchainAmount, coinAmount, venue });

// The reference the band is anchored on: 0.00001 BTC per XCHAIN, which at
// 200,000 USD/BTC is the $2.00  D2 bootstrap.
const REF = '0.00001';

describe('XCHAIN price derivation from realized fills @regression', function () {
    let util;
    beforeEach(function () { util = new Utility(); });

    describe('the winsorized volume-weighted average', function () {

        it('prices a single in-band fill at exactly its own rate', function () {
            const r = deriveXchainRate(util, [fill('100', '0.001')], REF);
            assert.strictEqual(r.rate, '0.00001000');
            assert.strictEqual(r.usedCount, 1);
            assert.strictEqual(r.clampedCount, 0);
        });

        it('weights by volume, not by fill count', function () {
            // 1000 XCHAIN at 0.00001 and 10 XCHAIN at 0.00002 (both in band). A
            // plain mean of the RATES would be 0.000015; the volume-weighted
            // answer must sit far nearer the large fill.
            //   numerator = 0.01 + 0.0002 = 0.0102 ; denominator = 1010
            const r = deriveXchainRate(util, [
                fill('1000', '0.01'),
                fill('10',   '0.0002'),
            ], REF);
            assert.strictEqual(r.rate, '0.00001010');
            assert.strictEqual(r.clampedCount, 0);
        });

        it('adds in-band fills with no per-fill division at all', function () {
            // An in-band fill contributes exactly its coin amount, so splitting the
            // same volume across many fills must give the same answer as one
            // aggregate fill. This is the property that keeps the common path exact.
            const many = deriveXchainRate(util, [
                fill('33', '0.00033'), fill('33', '0.00033'), fill('34', '0.00034'),
            ], REF);
            const one = deriveXchainRate(util, [fill('100', '0.001')], REF);
            assert.strictEqual(many.rate, one.rate);
        });

        it('treats both venues identically: a fill is a fill', function () {
            const a = deriveXchainRate(util, [
                fill('100', '0.001', 'dex'), fill('300', '0.006', 'dispense'),
            ], REF);
            const b = deriveXchainRate(util, [
                fill('300', '0.006', 'dispense'), fill('100', '0.001', 'dex'),
            ], REF);
            assert.strictEqual(a.rate, b.rate);
            // Dispensers carrying the volume means dispensers set the price:
            // 0.007/400 = 0.0000175, nearer the dispense rate than the DEX one.
            assert.strictEqual(a.rate, '0.00001750');
        });
    });

    describe('manipulation resistance (spec §5)', function () {

        it('clamps a whale self-dealing a huge quantity at a nonsense-low rate', function () {
            // The DOWN attack: a cheaper XCHAIN/USD means cheaper LTC/DOGE fees.
            // Weight is denominated in XCHAIN, which the attacker already holds, so
            // dumping 1,000,000 on themselves for one satoshi costs only fees while
            // carrying enormous weight. Winsorization caps its contribution at the
            // band edge, so it can pull toward ref/2 but no further.
            const honest = [fill('100', '0.001'), fill('200', '0.002')];
            const attacked = honest.concat([fill('1000000', '0.00000001')]);

            const clean = deriveXchainRate(util, honest, REF);
            const under = deriveXchainRate(util, attacked, REF);

            assert.strictEqual(clean.rate, '0.00001000');
            assert.strictEqual(under.clampedCount, 1);
            // Pulled down, but floored at the band edge (ref/2 = 0.000005), never
            // to the ~0 an unwinsorized VWAP would have produced.
            assert.ok(util.bcgte(under.rate, under.lower),
                'winsorized result must not fall below the band floor, got ' + under.rate);
            assert.strictEqual(under.rate, '0.00000500');
        });

        it('clamps the UP direction too, which is the griefing attack', function () {
            // A higher XCHAIN/USD makes every fee-bearing action on LTC and DOGE
            // more expensive without bound, shutting those chains. It needs no
            // profit motive, so the defence has to be symmetric.
            const attacked = [
                fill('100', '0.001'), fill('200', '0.002'),
                fill('1000000', '1000'),
            ];
            const r = deriveXchainRate(util, attacked, REF);
            assert.strictEqual(r.clampedCount, 1);
            assert.ok(util.bclte(r.rate, r.upper),
                'winsorized result must not exceed the band ceiling, got ' + r.rate);
            assert.strictEqual(r.rate, '0.00002000');
        });

        it('caps recycled wash volume at the band edge however often it repeats', function () {
            // Volume is recyclable: the same inventory can wash through unlimited
            // fills in one window. Many clamped fills still cannot push past the
            // edge, so repetition buys reach toward the edge, never past it.
            const many = [];
            for (let i = 0; i < 50; i++) many.push(fill('10000', '0.00000001'));
            const r = deriveXchainRate(util, many.concat([fill('100', '0.001')]), REF);
            assert.strictEqual(r.clampedCount, 50);
            assert.ok(util.bcgte(r.rate, r.lower), 'still floored at the band edge');
        });

        it('leaves genuine volatility inside the band untouched', function () {
            // A real move to 1.8x the reference is volatility, not an attack.
            const r = deriveXchainRate(util, [
                fill('100', '0.001'), fill('100', '0.0018'),
            ], REF);
            assert.strictEqual(r.clampedCount, 0);
            assert.strictEqual(r.rate, '0.00001400');
        });

        it('honours a caller-supplied band', function () {
            // A tighter band clamps what the default would have admitted.
            const fills = [fill('100', '0.001'), fill('100', '0.0018')];
            const tight = deriveXchainRate(util, fills, REF, { bandFactor: '1.2' });
            assert.strictEqual(tight.clampedCount, 1);
            assert.strictEqual(tight.upper, '0.00001200');
        });
    });

    describe('the reference anchor', function () {

        it('refuses to publish without a reference rather than averaging unanchored', function () {
            // No anchor means no band, and an unanchored average of a thin market
            // is exactly what an attacker can set to anything.
            const fills = [fill('100', '0.001')];
            assert.strictEqual(deriveXchainRate(util, fills, null), null);
            assert.strictEqual(deriveXchainRate(util, fills, '0'), null);
            assert.strictEqual(deriveXchainRate(util, fills, 'abc'), null);
        });

        it('derives the reference in XCHAIN/BTC terms from the last published USD price', function () {
            // $2.00 XCHAIN at $200,000 BTC => 0.00001 BTC per XCHAIN, the band centre.
            const ref = referenceRateFromUsd(util, '2.00000000', '200000.00000000');
            assert.strictEqual(util.bcformat(ref, 8), '0.00001000');
        });

        it('refuses a missing or non-positive reference input', function () {
            assert.strictEqual(referenceRateFromUsd(util, null, '200000'), null);
            assert.strictEqual(referenceRateFromUsd(util, '2', null), null);
            assert.strictEqual(referenceRateFromUsd(util, '0', '200000'), null);
            assert.strictEqual(referenceRateFromUsd(util, '2', '0'), null);
        });
    });

    describe('degenerate inputs', function () {

        it('returns null for an empty window, so the caller holds the bootstrap', function () {
            assert.strictEqual(deriveXchainRate(util, [], REF), null);
            assert.strictEqual(deriveXchainRate(util, null, REF), null);
        });

        it('drops fills with a zero or negative side rather than clamping them', function () {
            // A zero XCHAIN side is an infinite rate; a zero coin side is a
            // giveaway. Winsorizing these would let their weight count at a band
            // edge, which is worse than ignoring records that carry no price.
            const r = deriveXchainRate(util, [
                fill('100', '0.001'),
                fill('0', '0.5'),
                fill('100', '0'),
                fill('-5', '0.001'),
            ], REF);
            assert.strictEqual(r.usedCount, 1);
            assert.strictEqual(r.droppedCount, 3);
            assert.strictEqual(r.rate, '0.00001000');
        });

        it('returns null when every fill is degenerate', function () {
            assert.strictEqual(deriveXchainRate(util, [fill('0', '0'), fill('0', '1')], REF), null);
        });

        it('survives unparseable amounts without throwing', function () {
            const r = deriveXchainRate(util, [fill('100', '0.001'), fill('abc', 'xyz')], REF);
            assert.strictEqual(r.usedCount, 1);
            assert.strictEqual(r.droppedCount, 1);
        });

        it('reports the band and totals it priced from, for auditability', function () {
            const r = deriveXchainRate(util, [fill('100', '0.001'), fill('300', '0.003')], REF);
            assert.strictEqual(r.totalXchain, '400.00000000');
            assert.strictEqual(r.refRate, '0.00001000');
            assert.strictEqual(r.lower, '0.00000500');
            assert.strictEqual(r.upper, '0.00002000');
        });
    });

    // The BTC-side notional (D2's threshold quantity) and the unwinsorized VWAP
    // (§10 step 6). Neither reaches the published price, so nothing else in this
    // file would notice them being wrong.
    describe('volume and the pre-winsorize audit trail', function () {

        it('sums the BTC side of the window as the threshold quantity', function () {
            const r = deriveXchainRate(util, [fill('100', '0.001'), fill('300', '0.003')], REF);
            assert.strictEqual(r.totalCoin, '0.00400000');
        });

        it('counts a CLAMPED fill at the BTC actually paid, not at the band edge', function () {
            // The whole point of measuring volume pre-winsorize. This fill's rate is
            // far above the band, so its contribution to the price is the band edge,
            // but only 0.001 BTC really changed hands. Taking the volume from the
            // numerator instead would report 0.02 and let a clamped wash print
            // manufacture the very evidence that says the market is real.
            const r = deriveXchainRate(util, [fill('1000', '1')], REF);
            assert.strictEqual(r.clampedCount, 1);
            assert.strictEqual(r.totalCoin, '1.00000000');
            assert.strictEqual(r.rate, '0.00002000');       // clamped to the upper edge
        });

        it('excludes dropped rows from the volume, matching the price', function () {
            // A degenerate fill is not a trade, so it must not count toward the
            // threshold either, or a free zero-BTC print would help clear the bar.
            const r = deriveXchainRate(util, [fill('100', '0.001'), fill('50', '0')], REF);
            assert.strictEqual(r.droppedCount, 1);
            assert.strictEqual(r.usedCount, 1);
            assert.strictEqual(r.totalCoin, '0.00100000');
        });

        it('reports rawRate equal to the price when nothing was clamped', function () {
            const r = deriveXchainRate(util, [fill('100', '0.001'), fill('300', '0.0045')], REF);
            assert.strictEqual(r.clampedCount, 0);
            assert.strictEqual(r.rawRate, r.rate);
        });

        it('reports rawRate diverging from the price exactly when the band bites', function () {
            // 100 XCHAIN at the reference plus 100 at 100x it. The raw average is
            // dragged to ~0.0005; the published price is held near the band edge.
            // The gap between the two IS the defence, and it is only visible here.
            const r = deriveXchainRate(util, [fill('100', '0.001'), fill('100', '0.1')], REF);
            assert.strictEqual(r.clampedCount, 1);
            assert.strictEqual(r.rawRate, '0.00050500');
            assert.strictEqual(r.rate, '0.00001500');
            assert.ok(util.bcgt(r.rawRate, r.rate), 'raw must exceed the winsorized print here');
        });
    });

    describe('precision and determinism', function () {

        it('rounds HALF-UP, not half-even, matching the indexer bcmath', function () {
            // Pinned deliberately: the spec calls the rounding mode a consensus
            // parameter, and this is the mode the fee path actually uses. A second
            // implementation assuming banker's rounding would disagree at exactly
            // the .5 boundary, which for a fee input is a fork.
            // bcmath returns Decimal objects; bcformat is what renders them, so
            // the mode is asserted through the same path the module publishes on.
            assert.strictEqual(util.bcformat(util.bcdiv('2', '3', 8), 8), '0.66666667');
            assert.strictEqual(util.bcformat(util.bcnum('0.000000025'), 8), '0.00000003');
            assert.strictEqual(util.bcformat(util.bcnum('0.000000005'), 8), '0.00000001');
        });

        it('publishes at 8dp (satoshi), like every other pair', function () {
            const r = deriveXchainRate(util, [fill('3', '0.00001')], REF);
            assert.ok(/^\d+\.\d{8}$/.test(r.rate), 'rate must be an 8dp decimal string, got ' + r.rate);
        });

        it('is order-independent: the same fills shuffled give the same price', function () {
            const fills = [
                fill('100', '0.001'), fill('250', '0.003'), fill('7', '0.00009'), fill('1000', '0.012'),
            ];
            const a = deriveXchainRate(util, fills, REF);
            const b = deriveXchainRate(util, fills.slice().reverse(), REF);
            const c = deriveXchainRate(util, [fills[2], fills[0], fills[3], fills[1]], REF);
            assert.strictEqual(a.rate, b.rate);
            assert.strictEqual(a.rate, c.rate);
        });

        it('returns null rather than a zero price when the rate rounds away', function () {
            // Publishing 0.00000000 would price every fee at zero, so a rate below
            // half a satoshi per XCHAIN must fail closed to the caller's fallback.
            const tiny = '0.00000000000001';
            const r = deriveXchainRate(util, [fill('100000000000', '0.00000001')], tiny);
            assert.strictEqual(r, null);
        });
    });

    describe('the USD leg', function () {

        it('multiplies the on-chain rate by the round\'s own BTC/USD', function () {
            // 0.00001 BTC per XCHAIN at 200,000 USD/BTC => $2.00, the D2 bootstrap.
            assert.strictEqual(toUsd(util, '0.00001000', '200000.00000000'), '2.00000000');
        });

        it('round-trips against the reference derivation', function () {
            const ref = referenceRateFromUsd(util, '2.00000000', '200000.00000000');
            assert.strictEqual(toUsd(util, ref, '200000.00000000'), '2.00000000');
        });

        it('refuses a missing or non-positive input rather than publishing nonsense', function () {
            assert.strictEqual(toUsd(util, null, '100000'), null);
            assert.strictEqual(toUsd(util, '0.00001', null), null);
            assert.strictEqual(toUsd(util, '0', '100000'), null);
            assert.strictEqual(toUsd(util, 'abc', '100000'), null);
        });
    });
});
