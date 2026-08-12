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
 * test/unit/price_sig_tally_activation.test.js
 *
 * PRICE v0 signature-tally ordering flag-day, predicate-level pins.
 *
 * The predicate decides which of two consensus tally rules a PRICE round is
 * judged under, so its edge cases are consensus surface in their own right: a
 * node that reads a missing anchor as 0 would flip the rule early on every
 * genesis-on network, and a node that read an unknown network as active would
 * flip alone. Both directions have to fail CLOSED, onto the legacy ordering the
 * deployed fleet already enforces.
 */

'use strict';

const assert = require('assert');
const gate   = require('../../src/price_sig_tally_activation.js');

describe('PRICE v0 signature-tally flag-day @regression', function () {

    describe('activation map', function () {
        it('mainnet is armed to the ratified 963000 BTC anchor, not the shipped 961000 train', function () {
            // 961000 is ~2026-08-04 and its deploy train shipped 2026-07-23, so arming
            // there would require a second fleet-wide deploy inside a week; a node that
            // missed it forks on the first round with a garbage sig ahead of a real one.
            assert.strictEqual(gate.PRICE_SIG_TALLY_ACTIVATION.mainnet, 963000);
        });

        it('testnet and regtest are genesis-on', function () {
            assert.strictEqual(gate.PRICE_SIG_TALLY_ACTIVATION.testnet, 0);
            assert.strictEqual(gate.PRICE_SIG_TALLY_ACTIVATION.regtest, 0);
        });
    });

    describe('isPriceSigTallyVerifyFirstActive', function () {
        it('is inactive below the mainnet anchor and active at/above it', function () {
            assert.strictEqual(gate.isPriceSigTallyVerifyFirstActive(962999, 'mainnet'), false);
            assert.strictEqual(gate.isPriceSigTallyVerifyFirstActive(963000, 'mainnet'), true);
            assert.strictEqual(gate.isPriceSigTallyVerifyFirstActive(963001, 'mainnet'), true);
        });

        it('is active from genesis on testnet and regtest', function () {
            assert.strictEqual(gate.isPriceSigTallyVerifyFirstActive(0, 'testnet'), true);
            assert.strictEqual(gate.isPriceSigTallyVerifyFirstActive(0, 'regtest'), true);
        });

        it('accepts the numeric-string heights the wire actually carries', function () {
            // PRICE v0 params arrive as strings; BTC_BLOCK_HEIGHT is parsed but the
            // predicate must not depend on the caller having done so.
            assert.strictEqual(gate.isPriceSigTallyVerifyFirstActive('963000', 'mainnet'), true);
            assert.strictEqual(gate.isPriceSigTallyVerifyFirstActive('962999', 'mainnet'), false);
        });

        it('fails closed on an unknown network', function () {
            assert.strictEqual(gate.isPriceSigTallyVerifyFirstActive(9999999, 'devnet'), false);
            assert.strictEqual(gate.isPriceSigTallyVerifyFirstActive(9999999, undefined), false);
        });

        it('fails closed on an unreadable height, including on a genesis-on network', function () {
            // The trap this guard exists for: Number(null) / Number('') / Number(false)
            // are all a perfectly finite 0, which on a threshold-0 network would read as
            // ACTIVE and flip the tally on a round whose anchor could not be read.
            for (const bad of [null, undefined, '', false, true, 'abc', NaN]) {
                assert.strictEqual(gate.isPriceSigTallyVerifyFirstActive(bad, 'regtest'), false,
                    'genesis-on network must still fail closed on ' + String(bad));
                assert.strictEqual(gate.isPriceSigTallyVerifyFirstActive(bad, 'mainnet'), false);
            }
        });

        it('fails closed on a deliberately disarmed (null) threshold', function () {
            const saved = gate.PRICE_SIG_TALLY_ACTIVATION.testnet;
            gate.PRICE_SIG_TALLY_ACTIVATION.testnet = null;
            try {
                assert.strictEqual(gate.isPriceSigTallyVerifyFirstActive(99999999, 'testnet'), false);
            } finally {
                gate.PRICE_SIG_TALLY_ACTIVATION.testnet = saved;
            }
        });
    });
});
