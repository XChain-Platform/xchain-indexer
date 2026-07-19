// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// Unit coverage for src/retraction_signing_activation.js: the BTC-anchored
// snapshot_block gate deciding whether quorum-class retraction broadcasts must
// carry a 2f+1 co-signature. Fail-safe by design (below the threshold and on
// unknown/garbage input it returns false, so legacy unsigned events stay
// accepted for a rolling deploy); testnet/regtest activate at genesis.

const assert = require('assert');
const { RETRACTION_SIGNING_ACTIVATION, isRetractionSigningActive } = require('../../src/retraction_signing_activation.js');

describe('retraction_signing_activation', function () {
    it('activates testnet and regtest from genesis (threshold 0)', function () {
        assert.strictEqual(RETRACTION_SIGNING_ACTIVATION.testnet, 0);
        assert.strictEqual(RETRACTION_SIGNING_ACTIVATION.regtest, 0);
        assert.strictEqual(isRetractionSigningActive(0, 'regtest'), true);
        assert.strictEqual(isRetractionSigningActive(0, 'testnet'), true);
    });

    it('mainnet is armed to a concrete positive height', function () {
        const m = RETRACTION_SIGNING_ACTIVATION.mainnet;
        assert.ok(Number.isInteger(m) && m > 0, 'mainnet must be an armed positive block height');
    });

    it('is inactive strictly below the mainnet threshold and active at/above it', function () {
        const m = RETRACTION_SIGNING_ACTIVATION.mainnet;
        assert.strictEqual(isRetractionSigningActive(m - 1, 'mainnet'), false);
        assert.strictEqual(isRetractionSigningActive(m, 'mainnet'), true, 'gate is inclusive at the flag-day');
        assert.strictEqual(isRetractionSigningActive(m + 1000, 'mainnet'), true);
    });

    it('accepts numeric-string snapshot_block (wire values arrive as strings)', function () {
        const m = RETRACTION_SIGNING_ACTIVATION.mainnet;
        assert.strictEqual(isRetractionSigningActive(String(m), 'mainnet'), true);
        assert.strictEqual(isRetractionSigningActive(String(m - 1), 'mainnet'), false);
    });

    it('fails safe (false) on an unknown network', function () {
        assert.strictEqual(isRetractionSigningActive(10_000_000, 'devnet'), false);
        assert.strictEqual(isRetractionSigningActive(10_000_000, undefined), false);
    });

    it('fails safe (false) on a non-finite snapshot_block', function () {
        assert.strictEqual(isRetractionSigningActive('not-a-number', 'regtest'), false);
        assert.strictEqual(isRetractionSigningActive(NaN, 'mainnet'), false);
        assert.strictEqual(isRetractionSigningActive(undefined, 'mainnet'), false);
    });
});
