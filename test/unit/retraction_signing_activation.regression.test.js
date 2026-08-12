/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/retraction_signing_activation.regression.test.js
 *
 * Signed-retraction flag-day, consensus-surface regression pins.
 *
 * isRetractionSigningActive decides whether a quorum-class retraction
 * broadcast must carry a 2f+1 `cross_chain` co-signature or may still be
 * accepted unsigned under the generation fences. It is consensus
 * surface: two mirrors that disagree on the answer for the same
 * snapshot_block diverge on which retractions they honour. These tests pin
 * the two directions that fork a fleet — the mainnet arming height itself,
 * and the fail-CLOSED (accept-legacy) behaviour on every unreadable or
 * unknown input — so a silent edit to either shows up as a red test rather
 * than a chain split. Byte-identical twins live in xchain-hub/src and
 * xchain-explorer/src; a drift here is a drift across all three consumers.
 */

'use strict';

const assert = require('assert');
const gate   = require('../../src/retraction_signing_activation.js');

describe('Signed-retraction flag-day @regression @tier1', function () {

    describe('activation map (arming heights are a fleet-wide contract)', function () {
        it('mainnet is armed to the ratified 963000 BTC snapshot_block anchor', function () {
            // 963000 is the ratified anchor every hub/indexer/explorer deploy is
            // pinned to. Re-pointing it silently would arm the co-signature gate on
            // a different era than the rest of the fleet expects, so the first
            // quorum-class retraction across the seam forks signed vs unsigned.
            assert.strictEqual(gate.RETRACTION_SIGNING_ACTIVATION.mainnet, 963000);
        });

        it('testnet and regtest are genesis-on (threshold 0)', function () {
            assert.strictEqual(gate.RETRACTION_SIGNING_ACTIVATION.testnet, 0);
            assert.strictEqual(gate.RETRACTION_SIGNING_ACTIVATION.regtest, 0);
        });
    });

    describe('isRetractionSigningActive', function () {
        it('is inactive strictly below the mainnet anchor and active at/above it (inclusive flag-day)', function () {
            const m = gate.RETRACTION_SIGNING_ACTIVATION.mainnet;
            assert.strictEqual(gate.isRetractionSigningActive(m - 1, 'mainnet'), false);
            assert.strictEqual(gate.isRetractionSigningActive(m, 'mainnet'), true, 'gate is inclusive at the flag-day era');
            assert.strictEqual(gate.isRetractionSigningActive(m + 1000, 'mainnet'), true);
        });

        it('is active from genesis on testnet and regtest', function () {
            assert.strictEqual(gate.isRetractionSigningActive(0, 'testnet'), true);
            assert.strictEqual(gate.isRetractionSigningActive(0, 'regtest'), true);
        });

        it('accepts the numeric-string snapshot_block the wire actually carries', function () {
            const m = gate.RETRACTION_SIGNING_ACTIVATION.mainnet;
            assert.strictEqual(gate.isRetractionSigningActive(String(m), 'mainnet'), true);
            assert.strictEqual(gate.isRetractionSigningActive(String(m - 1), 'mainnet'), false);
        });

        it('fails CLOSED (accept-legacy) on an unknown network', function () {
            // Unknown network -> off, so an unrecognised network label can never be
            // the thing that flips a mirror into demanding co-signatures alone.
            assert.strictEqual(gate.isRetractionSigningActive(10_000_000, 'devnet'), false);
            assert.strictEqual(gate.isRetractionSigningActive(10_000_000, undefined), false);
        });

        it('fails CLOSED on every unreadable snapshot_block, including on a genesis-on network', function () {
            // The dangerous trap for a threshold-0 network: any value the guard reads
            // as a finite number >= 0 would activate. parseInt(null)/parseInt('')/
            // parseInt(false) are all NaN (not 0), so the guard must reject them; a
            // regression that let any of these through would flip regtest/testnet
            // active on a round whose anchor could not be read.
            for (const bad of [null, undefined, '', false, true, 'abc', NaN]) {
                assert.strictEqual(gate.isRetractionSigningActive(bad, 'regtest'), false,
                    'genesis-on network must still fail closed on ' + String(bad));
                assert.strictEqual(gate.isRetractionSigningActive(bad, 'mainnet'), false,
                    'mainnet must fail closed on ' + String(bad));
            }
        });

        it('fails CLOSED on a deliberately disarmed (undefined) threshold', function () {
            // If an operator disarms a network by deleting its entry, the guard must
            // read the missing threshold as off, never as a 0 that activates genesis.
            const saved = gate.RETRACTION_SIGNING_ACTIVATION.testnet;
            delete gate.RETRACTION_SIGNING_ACTIVATION.testnet;
            try {
                assert.strictEqual(gate.isRetractionSigningActive(99_999_999, 'testnet'), false);
            } finally {
                gate.RETRACTION_SIGNING_ACTIVATION.testnet = saved;
            }
        });
    });
});
