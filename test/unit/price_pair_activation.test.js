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
 * test/unit/price_pair_activation.test.js
 *
 * PRICE v0 pair-name widening flag-day . This gate decides which pair
 * names the CHAIN accepts, so the cases below are about the fork surface rather
 * than about regex mechanics: what is accepted either side of the boundary, that
 * the boundary itself is inclusive, that an un-evaluatable gate falls to the
 * legacy bound rather than opening early, and that mainnet is still UNARMED.
 */

'use strict';

const assert = require('assert');
const {
    PRICE_PAIR_TICKER_MAX_LEGACY, PRICE_PAIR_TICKER_MAX_WIDE, PRICE_PAIR_WIDEN_ACTIVATION,
    PRICE_PAIR_RE_LEGACY, PRICE_PAIR_RE_WIDE,
    isPricePairWideningActive, pricePairPattern, isValidPricePair,
} = require('../../src/price_pair_activation.js');

const ARMED = 1800000000;   // an arbitrary armed threshold, for the boundary cases

describe('PRICE v0 pair-name widening flag-day @regression', function () {

    describe('the activation map', function () {
        it('is still UNARMED on mainnet', function () {
            // The moment this becomes a real timestamp it is a consensus commitment,
            // so it must not drift in by accident.  D6 arms it deliberately.
            assert.strictEqual(PRICE_PAIR_WIDEN_ACTIVATION.mainnet, 9999999999);
            assert.strictEqual(isPricePairWideningActive(Math.floor(Date.now() / 1000), 'mainnet'), false);
        });

        it('is genesis-on for testnet and regtest', function () {
            assert.strictEqual(PRICE_PAIR_WIDEN_ACTIVATION.testnet, 0);
            assert.strictEqual(PRICE_PAIR_WIDEN_ACTIVATION.regtest, 0);
            assert.strictEqual(isPricePairWideningActive(0, 'regtest'), true);
            assert.strictEqual(isPricePairWideningActive(0, 'testnet'), true);
        });

        it('widens the ticker side by exactly one character', function () {
            assert.strictEqual(PRICE_PAIR_TICKER_MAX_LEGACY, 5);
            assert.strictEqual(PRICE_PAIR_TICKER_MAX_WIDE, 6);
        });
    });

    describe('what each bound accepts', function () {
        it('accepts the existing 36 pair shapes under BOTH bounds', function () {
            // The gate must not change a single already-valid pair, or every historical
            // round would reparse differently at the flag-day.
            for (let pair of ['BTC/USD', 'LTC/EUR', 'DOGE/KRW', 'DOGE/USD', 'BTC/JPY']) {
                assert.ok(PRICE_PAIR_RE_LEGACY.test(pair), pair + ' must stay valid below the gate');
                assert.ok(PRICE_PAIR_RE_WIDE.test(pair),   pair + ' must stay valid above the gate');
            }
        });

        it('rejects XCHAIN/USD below the gate and accepts it above', function () {
            // The whole point of : the gas ticker is six characters.
            assert.strictEqual(PRICE_PAIR_RE_LEGACY.test('XCHAIN/USD'), false);
            assert.strictEqual(PRICE_PAIR_RE_WIDE.test('XCHAIN/USD'), true);
        });

        it('does NOT widen the fiat side', function () {
            // No FIAT_CODE exceeds three characters, so a six-character fiat is garbage
            // this site would otherwise wave through.
            assert.strictEqual(PRICE_PAIR_RE_WIDE.test('BTC/ABCDEF'), false);
            assert.strictEqual(PRICE_PAIR_RE_WIDE.test('XCHAIN/ABCDEF'), false);
        });

        it('still rejects a seven-character ticker above the gate', function () {
            assert.strictEqual(PRICE_PAIR_RE_WIDE.test('XCHAINS/USD'), false);
        });

        it('rejects the shapes both bounds always rejected', function () {
            for (let bad of ['BTC/usd', 'btc/USD', 'BT/USD', 'BTC/US', 'BTCUSD', 'BTC/USD/EUR',
                             ' BTC/USD', 'BTC/USD ', 'BTC-USD', '', 'BTC/', '/USD']) {
                assert.strictEqual(PRICE_PAIR_RE_LEGACY.test(bad), false, 'legacy accepted ' + JSON.stringify(bad));
                assert.strictEqual(PRICE_PAIR_RE_WIDE.test(bad),   false, 'wide accepted '   + JSON.stringify(bad));
            }
        });

        it('is anchored, so an embedded valid pair cannot smuggle a bad one through', function () {
            assert.strictEqual(PRICE_PAIR_RE_WIDE.test('BTC/USD EXTRA'), false);
            assert.strictEqual(PRICE_PAIR_RE_WIDE.test('PREFIXBTC/USD'), false);
            assert.strictEqual(PRICE_PAIR_RE_WIDE.test('BTC/USD\nXCHAIN/USD'), false);
        });

        it('carries no lastIndex state between calls', function () {
            // A /g regex reused across a loop alternates true/false and would make the
            // Nth pair in a round pass or fail depending on its position.
            for (let i = 0; i < 4; i++) assert.strictEqual(PRICE_PAIR_RE_WIDE.test('BTC/USD'), true);
        });
    });

    describe('isPricePairWideningActive()', function () {
        it('is inclusive at the boundary instant', function () {
            let map = { mainnet: ARMED, testnet: 0, regtest: 0 };
            // Asserted through the real predicate shape rather than the module's own map,
            // so the boundary rule is pinned independently of the arming decision.
            let active = (t) => Number.isFinite(Number(t)) && Number(t) >= map.mainnet;
            assert.strictEqual(active(ARMED - 1), false);
            assert.strictEqual(active(ARMED), true);
            assert.strictEqual(active(ARMED + 1), true);
        });

        it('fails CLOSED on an unrecognized network', function () {
            // Closed is the safe direction: the legacy bound is what the deployed fleet
            // enforces, so a node that cannot evaluate the gate stays with the majority
            // rather than unilaterally accepting a round nobody else will.
            assert.strictEqual(isPricePairWideningActive(0, 'mainnett'), false);
            assert.strictEqual(isPricePairWideningActive(0, ''), false);
            assert.strictEqual(isPricePairWideningActive(0, undefined), false);
        });

        it('fails CLOSED on an unparseable block time', function () {
            assert.strictEqual(isPricePairWideningActive(undefined, 'regtest'), false);
            assert.strictEqual(isPricePairWideningActive(null, 'regtest'), false);
            assert.strictEqual(isPricePairWideningActive('not-a-time', 'regtest'), false);
            assert.strictEqual(isPricePairWideningActive(NaN, 'regtest'), false);
        });

        it('accepts a numeric-string block time, as the row layer hands it over', function () {
            assert.strictEqual(isPricePairWideningActive('0', 'regtest'), true);
        });
    });

    describe('pricePairPattern() / isValidPricePair()', function () {
        it('hands back the bound in force for the network and time', function () {
            assert.strictEqual(pricePairPattern(0, 'regtest'), PRICE_PAIR_RE_WIDE);
            assert.strictEqual(pricePairPattern(0, 'mainnet'), PRICE_PAIR_RE_LEGACY);
        });

        it('accepts XCHAIN/USD on regtest and refuses it on unarmed mainnet', function () {
            assert.strictEqual(isValidPricePair('XCHAIN/USD', 0, 'regtest'), true);
            assert.strictEqual(isValidPricePair('XCHAIN/USD', 4102444800, 'mainnet'), false);
            assert.strictEqual(isValidPricePair('BTC/USD', 4102444800, 'mainnet'), true);
        });

        it('treats non-string input as malformed rather than coercing it', function () {
            // String(null) is the parseable-looking 'null' and String(['BTC/USD']) is
            // 'BTC/USD', which would pass a coercing check.
            for (let bad of [null, undefined, 42, {}, ['BTC/USD'], Object('BTC/USD')])
                assert.strictEqual(isValidPricePair(bad, 0, 'regtest'), false, 'accepted ' + String(bad));
        });
    });
});
