'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The gated-SEND handoff address-resolution flag day. Pins the arming state
// (mainnet on the house sentinel, testnet/regtest from genesis) and the
// safe-side answers, so a threshold cannot drift without a CI failure.

const assert = require('assert');

const gate = require('../../src/gated_handoff_ref_activation.js');
const { GATED_HANDOFF_REF_ACTIVATION, isGatedHandoffRefActive } = gate;

const HOUSE_SENTINEL = 9999999999;

describe('gated-SEND handoff ref activation @regression @tier1', function () {

    it('mainnet is UNARMED on the house sentinel', function () {
        assert.strictEqual(GATED_HANDOFF_REF_ACTIVATION.mainnet, HOUSE_SENTINEL,
            'arming mainnet is an operator act; a real height here must arrive with its measurement');
    });

    it('testnet and regtest run from genesis', function () {
        assert.strictEqual(GATED_HANDOFF_REF_ACTIVATION.testnet, 0);
        assert.strictEqual(GATED_HANDOFF_REF_ACTIVATION.regtest, 0);
    });

    it('is off below the threshold and on at or above it', function () {
        const t = GATED_HANDOFF_REF_ACTIVATION.mainnet;
        assert.strictEqual(isGatedHandoffRefActive(t - 1, 'mainnet'), false);
        assert.strictEqual(isGatedHandoffRefActive(t,     'mainnet'), true);
        assert.strictEqual(isGatedHandoffRefActive(t + 1, 'mainnet'), true);
    });

    it('a present-day mainnet block is below the sentinel', function () {
        // 2026-09-06. The sentinel is only a real UNARMED marker while live blocks
        // fall under it; a threshold that today's chain has passed is armed by accident.
        assert.strictEqual(isGatedHandoffRefActive(1788000000, 'mainnet'), false);
    });

    it('genesis-active networks are on for any real block time', function () {
        assert.strictEqual(isGatedHandoffRefActive(0, 'regtest'), true);
        assert.strictEqual(isGatedHandoffRefActive(1700000000, 'regtest'), true);
        assert.strictEqual(isGatedHandoffRefActive(1700000000, 'testnet'), true);
    });

    it('an unknown network or unparseable timestamp stays off', function () {
        assert.strictEqual(isGatedHandoffRefActive(1700000000, 'nosuchnet'), false);
        assert.strictEqual(isGatedHandoffRefActive(null,      'regtest'), false);
        assert.strictEqual(isGatedHandoffRefActive(undefined, 'regtest'), false);
        assert.strictEqual(isGatedHandoffRefActive('abc',     'regtest'), false);
    });
});
