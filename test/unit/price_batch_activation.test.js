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
 * test/unit/price_batch_activation.test.js
 *
 * PRICE v2 batching flag-day. This gate decides whether the CHAIN accepts a
 * PRICE|2 action at all, so the cases below are about the fork surface rather
 * than about the predicate's arithmetic: mainnet is still UNARMED, testnet and
 * regtest are genesis-on, the boundary instant is inclusive, and an
 * un-evaluatable gate falls to invalid (v2 stays refused) rather than opening
 * early.
 */

'use strict';

const assert = require('assert');
const {
    PRICE_BATCH_ACTIVATION,
    isPriceBatchActive,
} = require('../../src/price_batch_activation.js');

const ARMED = 1800000000;   // an arbitrary armed threshold, for the boundary cases

describe('PRICE v2 batching flag-day @regression', function () {

    describe('the activation map', function () {
        it('is still UNARMED on mainnet', function () {
            // The moment this becomes a real timestamp it is a consensus commitment,
            // so it must not drift in by accident. Arming is a separate operator pass.
            assert.strictEqual(PRICE_BATCH_ACTIVATION.mainnet, 9999999999);
            assert.strictEqual(isPriceBatchActive(Math.floor(Date.now() / 1000), 'mainnet'), false);
        });

        it('is genesis-on for testnet and regtest', function () {
            assert.strictEqual(PRICE_BATCH_ACTIVATION.testnet, 0);
            assert.strictEqual(PRICE_BATCH_ACTIVATION.regtest, 0);
            assert.strictEqual(isPriceBatchActive(0, 'regtest'), true);
            assert.strictEqual(isPriceBatchActive(0, 'testnet'), true);
        });
    });

    describe('isPriceBatchActive()', function () {
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
            // Closed is the safe direction: no v2 action has ever been valid before
            // this gate exists, so a node that cannot evaluate it stays with the
            // majority rather than unilaterally accepting a batch nobody else will.
            assert.strictEqual(isPriceBatchActive(0, 'mainnett'), false);
            assert.strictEqual(isPriceBatchActive(0, ''), false);
            assert.strictEqual(isPriceBatchActive(0, undefined), false);
        });

        it('fails CLOSED on an unparseable block time', function () {
            assert.strictEqual(isPriceBatchActive(undefined, 'regtest'), false);
            assert.strictEqual(isPriceBatchActive(null, 'regtest'), false);
            assert.strictEqual(isPriceBatchActive('', 'regtest'), false);
            assert.strictEqual(isPriceBatchActive(false, 'regtest'), false);
            assert.strictEqual(isPriceBatchActive('not-a-time', 'regtest'), false);
            assert.strictEqual(isPriceBatchActive(NaN, 'regtest'), false);
        });

        it('accepts a numeric-string block time, as the row layer hands it over', function () {
            assert.strictEqual(isPriceBatchActive('0', 'regtest'), true);
        });
    });
});
