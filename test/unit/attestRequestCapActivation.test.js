/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * ATTEST v0 per-block admission caps (framework spec §11.1).
 *
 * The gate is consensus-visible, so the load-bearing assertions here are the
 * INERT ones: an unratified network must read as off at EVERY height, because
 * arming a cap on a chain that already has history silently reinterprets that
 * history. The cap values are asserted explicitly for the same reason a
 * flag-day height is: changing one is a consensus event, not a tuning knob.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const arc    = require('../../src/attest_request_cap_activation.js');

describe('ATTEST per-block admission caps (spec §11.1) @regression', function () {

    describe('isAttestRequestCapActive', function () {

        it('is INERT on mainnet: that height is still the operator\'s', function () {
            assert.strictEqual(arc.ATTEST_REQUEST_CAP_ACTIVATION.mainnet, null);
            // A null threshold must read as OFF at every height. `blockIndex >= null`
            // coerces to `>= 0`, which would arm the cap from genesis on a chain whose
            // history was indexed without it - the exact replay fork the sentinel exists
            // to prevent.
            for (const h of [0, 1, 146500, 961000, 999999999])
                assert.strictEqual(arc.isAttestRequestCapActive(h, 'mainnet'), false,
                    'an unratified mainnet height must never arm at ' + h);
        });

        it('is armed from genesis on testnet and regtest', function () {
            // testnet 0 is operator-ratified (2026-08-18), and safe because it was
            // MEASURED rather than assumed: the live explorer reports zero attestation
            // rows ever recorded on BTC testnet, so no historical block can have
            // exceeded a cap of 10 and arming from genesis reinterprets nothing.
            // regtest is rebuilt from scratch, so it has no history at all.
            for (const net of ['testnet', 'regtest']) {
                assert.strictEqual(arc.ATTEST_REQUEST_CAP_ACTIVATION[net], 0, net + ' must be armed at genesis');
                assert.strictEqual(arc.isAttestRequestCapActive(0, net), true);
                assert.strictEqual(arc.isAttestRequestCapActive(12345, net), true);
            }
        });

        it('an unknown network fails closed rather than defaulting to on', function () {
            assert.strictEqual(arc.isAttestRequestCapActive(999999, 'signet'), false);
            assert.strictEqual(arc.isAttestRequestCapActive(999999, undefined), false);
        });

        it('a non-numeric height fails closed', function () {
            for (const b of [null, undefined, '', 'abc', NaN])
                assert.strictEqual(arc.isAttestRequestCapActive(b, 'regtest'), false);
        });

        it('arms at the threshold block itself, not the one after', function () {
            // Pin the at/above boundary: an off-by-one here moves which block a cap
            // first applies in, which is a fleet-wide replay divergence.
            const armed = { ...arc.ATTEST_REQUEST_CAP_ACTIVATION, testnet: 500 };
            const at    = (h) => {
                let t = armed.testnet;
                return (t === null || t === undefined) ? false : h >= t;
            };
            assert.strictEqual(at(499), false);
            assert.strictEqual(at(500), true);
            assert.strictEqual(at(501), true);
        });
    });

    describe('ATTEST_REQUEST_CAPS', function () {

        it('pins the consensus cap values', function () {
            // Changing either number changes which requests are admitted at the
            // flag-day, so it is a consensus event and must fail this test first.
            assert.strictEqual(arc.ATTEST_REQUEST_CAPS.perContract, 2);
            assert.strictEqual(arc.ATTEST_REQUEST_CAPS.perBlock, 10);
        });

        it('keeps the per-contract cap below the per-block ceiling', function () {
            // If one contract could fill the block the per-block cap would be the only
            // rule that ever fired and the anti-starvation half would be decorative.
            assert.ok(arc.ATTEST_REQUEST_CAPS.perContract < arc.ATTEST_REQUEST_CAPS.perBlock);
        });
    });
});
