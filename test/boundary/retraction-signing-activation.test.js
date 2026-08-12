'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Boundary coverage for src/retraction_signing_activation.js: the BTC-anchored
// snapshot_block gate that decides whether a quorum-class retraction broadcast
// must carry a 2f+1 co-signature. The gate is consensus-critical and fail-safe
// by construction (below threshold / on garbage input it returns false so
// legacy unsigned events stay accepted for a rolling deploy). These cases pin
// the limits, off-by-one edges, zero/negative values, overflow magnitudes and
// malformed-but-plausible wire strings that a unit happy-path suite skips.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const {
    RETRACTION_SIGNING_ACTIVATION,
    isRetractionSigningActive,
} = require('../../src/retraction_signing_activation.js');

// Resolve the armed mainnet flag-day from the module so these edges follow the
// gate if it is re-armed, rather than hard-coding a height that would rot.
const M = RETRACTION_SIGNING_ACTIVATION.mainnet;

describe('retraction_signing_activation boundary tests @regression @tier1', function () {

    // -----------------------------------------------------------------------
    // RSA-B01: off-by-one across the mainnet flag-day (inclusive at threshold)
    // -----------------------------------------------------------------------
    describe('RSA-B01: flag-day off-by-one', function () {
        it('one block below the threshold is inactive', function () {
            assert.strictEqual(isRetractionSigningActive(M - 1, 'mainnet'), false);
        });
        it('exactly at the threshold is active (gate is inclusive)', function () {
            assert.strictEqual(isRetractionSigningActive(M, 'mainnet'), true);
        });
        it('one block above the threshold is active', function () {
            assert.strictEqual(isRetractionSigningActive(M + 1, 'mainnet'), true);
        });
    });

    // -----------------------------------------------------------------------
    // RSA-B02: zero and negative snapshot_block
    // -----------------------------------------------------------------------
    describe('RSA-B02: zero / negative snapshot_block', function () {
        it('block 0 is below a positive mainnet threshold → inactive', function () {
            assert.strictEqual(isRetractionSigningActive(0, 'mainnet'), false);
        });
        it('block 0 meets a genesis threshold (0) on regtest → active (inclusive)', function () {
            assert.strictEqual(RETRACTION_SIGNING_ACTIVATION.regtest, 0);
            assert.strictEqual(isRetractionSigningActive(0, 'regtest'), true);
        });
        it('a negative block is below any threshold → inactive on every network', function () {
            assert.strictEqual(isRetractionSigningActive(-1, 'regtest'), false);
            assert.strictEqual(isRetractionSigningActive(-1, 'mainnet'), false);
            assert.strictEqual(isRetractionSigningActive(Number.MIN_SAFE_INTEGER, 'mainnet'), false);
        });
    });

    // -----------------------------------------------------------------------
    // RSA-B03: fractional truncation at the threshold (parseInt drops the
    // fraction, so the effective boundary is the integer part)
    // -----------------------------------------------------------------------
    describe('RSA-B03: fractional values truncate toward the integer part', function () {
        it('threshold + 0.9 truncates to the threshold → active', function () {
            assert.strictEqual(isRetractionSigningActive(M + 0.9, 'mainnet'), true);
            assert.strictEqual(isRetractionSigningActive(String(M) + '.9', 'mainnet'), true);
        });
        it('threshold - 0.5 truncates to threshold-1 → inactive', function () {
            assert.strictEqual(isRetractionSigningActive(M - 0.5, 'mainnet'), false);
            assert.strictEqual(isRetractionSigningActive(String(M - 1) + '.9', 'mainnet'), false);
        });
    });

    // -----------------------------------------------------------------------
    // RSA-B04: malformed-but-plausible wire strings (values arrive as strings)
    // -----------------------------------------------------------------------
    describe('RSA-B04: malformed-but-plausible strings', function () {
        it('leading/trailing whitespace around a valid height still parses', function () {
            assert.strictEqual(isRetractionSigningActive('  ' + M + '  ', 'mainnet'), true);
        });
        it('trailing non-numeric garbage is dropped by parseInt', function () {
            assert.strictEqual(isRetractionSigningActive(M + 'xyz', 'mainnet'), true);
            assert.strictEqual(isRetractionSigningActive((M - 1) + 'xyz', 'mainnet'), false);
        });
        it('empty string / non-numeric string fail safe → inactive', function () {
            assert.strictEqual(isRetractionSigningActive('', 'mainnet'), false);
            assert.strictEqual(isRetractionSigningActive('not-a-number', 'regtest'), false);
        });
    });

    // -----------------------------------------------------------------------
    // RSA-B05: overflow / extreme magnitudes
    // -----------------------------------------------------------------------
    describe('RSA-B05: extreme magnitudes', function () {
        it('MAX_SAFE_INTEGER and a huge decimal string are far above the threshold → active', function () {
            assert.strictEqual(isRetractionSigningActive(Number.MAX_SAFE_INTEGER, 'mainnet'), true);
            assert.strictEqual(isRetractionSigningActive('9'.repeat(30), 'mainnet'), true);
        });
        it('Infinity is not a finite block → fails safe to inactive', function () {
            assert.strictEqual(isRetractionSigningActive(Infinity, 'regtest'), false);
            assert.strictEqual(isRetractionSigningActive(-Infinity, 'regtest'), false);
            assert.strictEqual(isRetractionSigningActive('Infinity', 'regtest'), false);
        });
        it('NaN / undefined snapshot_block fail safe to inactive', function () {
            assert.strictEqual(isRetractionSigningActive(NaN, 'mainnet'), false);
            assert.strictEqual(isRetractionSigningActive(undefined, 'mainnet'), false);
        });
    });

    // -----------------------------------------------------------------------
    // RSA-B06: unknown / malformed network fails safe even at an extreme block
    // -----------------------------------------------------------------------
    describe('RSA-B06: unknown / malformed network', function () {
        it('an unknown network is off even far above any threshold', function () {
            assert.strictEqual(isRetractionSigningActive(Number.MAX_SAFE_INTEGER, 'devnet'), false);
        });
        it('empty-string / undefined / null network fail safe → inactive', function () {
            assert.strictEqual(isRetractionSigningActive(10_000_000, ''), false);
            assert.strictEqual(isRetractionSigningActive(10_000_000, undefined), false);
            assert.strictEqual(isRetractionSigningActive(10_000_000, null), false);
        });
    });
});
