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
// (every network from genesis) and the safe-side answers, so a threshold cannot
// drift without a CI failure.

const assert = require('assert');

const gate = require('../../src/gated_handoff_ref_activation.js');
const { GATED_HANDOFF_REF_ACTIVATION, isGatedHandoffRefActive } = gate;

// Both spellings of "not armed yet". The GoLiveGate readback treats either as an
// unarmed mainnet position, so neither may reappear here.
const HOUSE_SENTINEL  = 9999999999;
const HEIGHT_SENTINEL = 999999999;

describe('gated-SEND handoff ref activation @regression @tier1', function () {

    it('mainnet is ARMED AT GENESIS by the 2026-09-09 ruling', function () {
        assert.strictEqual(GATED_HANDOFF_REF_ACTIVATION.mainnet, 0,
            'armed at genesis: mainnet history is ISSUE and ANCHOR only, so 0 SEND ' +
            '(measured 2026-09-09) leaves the resolved compare identity over it');
        assert.notStrictEqual(GATED_HANDOFF_REF_ACTIVATION.mainnet, HOUSE_SENTINEL);
        assert.notStrictEqual(GATED_HANDOFF_REF_ACTIVATION.mainnet, HEIGHT_SENTINEL);
    });

    it('testnet and regtest run from genesis', function () {
        assert.strictEqual(GATED_HANDOFF_REF_ACTIVATION.testnet, 0);
        assert.strictEqual(GATED_HANDOFF_REF_ACTIVATION.regtest, 0);
    });

    it('is on at the threshold and at every block time above it', function () {
        const t = GATED_HANDOFF_REF_ACTIVATION.mainnet;
        assert.strictEqual(isGatedHandoffRefActive(t,     'mainnet'), true);
        assert.strictEqual(isGatedHandoffRefActive(t + 1, 'mainnet'), true);
        assert.strictEqual(isGatedHandoffRefActive(HOUSE_SENTINEL, 'mainnet'), true);
    });

    it('a present-day mainnet block is at or above the threshold, so the rule binds', function () {
        // 2026-09-06. The mirror of the old sentinel check: an armed genesis height is
        // only real if the live chain's own block times resolve ACTIVE against it.
        assert.strictEqual(isGatedHandoffRefActive(1788000000, 'mainnet'), true);
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
