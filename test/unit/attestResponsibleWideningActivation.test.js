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
 * test/unit/attestResponsibleWidening.test.js
 *
 * The indexer half of the ATTEST responsible-set liveness ladder. The hub's
 * copy of these ladder assertions lives in
 * xchain-hub/test/unit/attest_responsible_widening.test.js; both must hold or
 * the two sides admit different signature sets at the flag-day, so the twin
 * check below is the load-bearing one and the ladder cases guard against a
 * one-sided retune that happens to keep the two files textually similar.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const wid    = require('../../src/attest_responsible_widening_activation.js');
const zc     = require('../../src/attest_zero_conf_activation.js');

// The measured incident: BTC testnet4 request 77f37a86..., admitted at 150699
// with deadlineBlocks 10 and redundancy 3, whose responsible set held one
// validator that had never connected to the federation.
const REQ      = 150699;
const DEADLINE = 150709;

// Stage-1 (pre-zero-conf) heights: regtest arms ATTEST_ZERO_CONF_ACTIVATION at 0
// (D91), so every regtest request now runs the V2 ladder below. Stage-1 numbers are
// asserted on testnet instead, at or above the widening height (150780) where
// zero-conf stays the null (unratified) sentinel.
const REQ_S1      = 150780;
const DEADLINE_S1 = 150790;

describe('attest_responsible_widening (indexer copy)', function () {

    // Derived from the map rather than naming networks, so pinning a height cannot
    // leave this asserting something that is no longer true. It caught exactly that:
    // the first cut hardcoded testnet as unratified and went stale the moment the
    // testnet height was armed.
    const unratified = () => Object.keys(wid.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION)
        .filter(n => wid.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION[n] === null);

    it('is inert on every network whose height is the null sentinel, at any height', function () {
        const nets = unratified().concat(['nosuchnet', undefined]);
        assert.ok(unratified().length > 0, 'no unratified network left: this test would be vacuous');
        for (const net of nets) {
            for (const at of [REQ, REQ + 8, REQ + 5000]) {
                assert.strictEqual(wid.widenSlots(at, REQ, DEADLINE, net), 0, String(net) + '@' + at);
            }
        }
    });

    it('keeps the null sentinel from coercing into height 0', function () {
        // Without the explicit null test in widenSlots, `req >= null` coerces to
        // `req >= 0` and the ladder arms on every block of an unratified network.
        for (const net of unratified()) {
            assert.strictEqual(wid.widenSlots(0, 0, 10, net), 0, net + ' armed at block 0');
            assert.strictEqual(wid.widenSlots(1e9, 0, 10, net), 0, net + ' armed at a high block');
        }
    });

    it('gates an armed network on the REQUEST block, not the response block', function () {
        const armed = Object.entries(wid.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION)
            .filter(([, h]) => typeof h === 'number');
        assert.ok(armed.length > 0, 'no armed network to check');
        for (const [net, height] of armed) {
            // One block below the flag day: never widens, however far the chain runs on.
            assert.strictEqual(wid.widenSlots(height + 500, height - 1, height + 29, net), 0,
                net + ': a request below the height must never widen');
            // At the flag day: the ladder runs normally. Derived from the maps, never a
            // hardcoded network list (D91): where zero-conf is armed on the request's own
            // block the ladder runs V2 and the ceiling is headroom + maxSlots; where it is
            // not, the ceiling is stage-1's bare maxSlots.
            const zcActive = zc.isZeroConfActive(height, net);
            const expected = zcActive
                ? wid.ATTEST_RESPONSIBLE_WIDENING_V2.headroom + wid.ATTEST_RESPONSIBLE_WIDENING_V2.maxSlots
                : wid.ATTEST_RESPONSIBLE_WIDENING.maxSlots;
            assert.strictEqual(wid.widenSlots(height + 21, height, height + 30, net),
                expected, net + ': a request at the height must widen');
        }
    });

    it('stage 1 (testnet, widening armed, request below the zero-conf flip): grants nothing in the first segment and both slots before the deadline', function () {
        assert.strictEqual(wid.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION.testnet, 150780);
        assert.strictEqual(typeof zc.ATTEST_ZERO_CONF_ACTIVATION.testnet, 'number');
        assert.ok(REQ_S1 < zc.ATTEST_ZERO_CONF_ACTIVATION.testnet, 'stage 1 is asserted on a request below the zero-conf flip (D106)');
        for (const at of [REQ_S1, REQ_S1 + 3, REQ_S1 + 4])
            assert.strictEqual(wid.widenSlots(at, REQ_S1, DEADLINE_S1, 'testnet'), 0, 'block ' + at);
        assert.strictEqual(wid.widenSlots(REQ_S1 + 6, REQ_S1, DEADLINE_S1, 'testnet'), 1);
        assert.strictEqual(wid.widenSlots(REQ_S1 + 8, REQ_S1, DEADLINE_S1, 'testnet'), 2);
        assert.strictEqual(wid.widenSlots(DEADLINE_S1, REQ_S1, DEADLINE_S1, 'testnet'), 2);
    });

    // The property the two sides rely on to agree: the hub derives its slots from the
    // indexer tip it polled, this file derives them from the block the response landed
    // in, and a response cannot be mined below that tip. Monotonicity therefore makes
    // the indexer's set a superset of the signing hub's, never a subset.
    it('is monotone non-decreasing in height (stage 1, testnet)', function () {
        let prev = 0;
        for (let at = REQ_S1; at <= DEADLINE_S1 + 20; at++) {
            const v = wid.widenSlots(at, REQ_S1, DEADLINE_S1, 'testnet');
            assert.ok(v >= prev, 'went backwards at block ' + at);
            prev = v;
        }
        assert.strictEqual(prev, wid.ATTEST_RESPONSIBLE_WIDENING.maxSlots);
    });

    it('grants nothing on a degenerate span or an unusable height (stage 1, testnet)', function () {
        assert.strictEqual(wid.widenSlots(REQ_S1 + 50, REQ_S1, REQ_S1, 'testnet'), 0);
        assert.strictEqual(wid.widenSlots(REQ_S1 + 50, REQ_S1, REQ_S1 + 3, 'testnet'), 0);
        assert.strictEqual(wid.widenSlots(NaN, REQ_S1, DEADLINE_S1, 'testnet'), 0);
        assert.strictEqual(wid.widenSlots(REQ_S1 + 8, REQ_S1, null, 'testnet'), 0);
    });
});

describe('attest_responsible_widening: the V2 ladder (zero-conf armed, D27, D28)', function () {

    before(function () {
        // regtest arms ATTEST_ZERO_CONF_ACTIVATION at 0 (D91), so REQ/DEADLINE (BTC
        // testnet4's measured incident block numbers, reused here as arbitrary regtest
        // heights) run the V2 branch of widenSlots.
        assert.strictEqual(zc.isZeroConfActive(REQ, 'regtest'), true);
    });

    it('grants headroom at the request block, where elapsed is 0 (D27)', function () {
        assert.strictEqual(wid.widenSlots(REQ, REQ, DEADLINE, 'regtest'), wid.ATTEST_RESPONSIBLE_WIDENING_V2.headroom);
    });

    it('grants headroom at elapsed 0 generally, including before the request block', function () {
        assert.strictEqual(wid.widenSlots(REQ - 2, REQ, DEADLINE, 'regtest'), wid.ATTEST_RESPONSIBLE_WIDENING_V2.headroom);
    });

    it('grants headroom, never 0, on a degenerate span (D27)', function () {
        assert.strictEqual(wid.widenSlots(REQ + 50, REQ, REQ, 'regtest'), wid.ATTEST_RESPONSIBLE_WIDENING_V2.headroom);
        assert.strictEqual(wid.widenSlots(REQ + 50, REQ, REQ - 5, 'regtest'), wid.ATTEST_RESPONSIBLE_WIDENING_V2.headroom);
    });

    it('reaches headroom+1 and headroom+2 before the deadline on the measured 10-block window', function () {
        // start=REQ, span=10, segment=10/3=3.333: idx 1 at elapsed>=3.333 (elapsed 4),
        // idx 2 (clamped to maxSlots) at elapsed>=6.667 (elapsed 7).
        assert.strictEqual(wid.widenSlots(REQ + 4, REQ, DEADLINE, 'regtest'),
            wid.ATTEST_RESPONSIBLE_WIDENING_V2.headroom + 1);
        assert.strictEqual(wid.widenSlots(REQ + 7, REQ, DEADLINE, 'regtest'),
            wid.ATTEST_RESPONSIBLE_WIDENING_V2.headroom + wid.ATTEST_RESPONSIBLE_WIDENING_V2.maxSlots);
        assert.strictEqual(wid.widenSlots(DEADLINE, REQ, DEADLINE, 'regtest'),
            wid.ATTEST_RESPONSIBLE_WIDENING_V2.headroom + wid.ATTEST_RESPONSIBLE_WIDENING_V2.maxSlots);
    });

    it('clamps to headroom+maxSlots (3) past the deadline, however far past it', function () {
        const ceiling = wid.ATTEST_RESPONSIBLE_WIDENING_V2.headroom + wid.ATTEST_RESPONSIBLE_WIDENING_V2.maxSlots;
        assert.strictEqual(ceiling, 3);
        for (const at of [DEADLINE + 1, DEADLINE + 100, DEADLINE + 100000])
            assert.strictEqual(wid.widenSlots(at, REQ, DEADLINE, 'regtest'), ceiling);
    });

    it('is monotone non-decreasing in atBlock', function () {
        let prev = 0;
        for (let at = REQ - 5; at <= DEADLINE + 20; at++) {
            const v = wid.widenSlots(at, REQ, DEADLINE, 'regtest');
            assert.ok(v >= prev, 'went backwards at block ' + at);
            prev = v;
        }
    });
});

describe('attest_responsible_widening: hub/indexer twin', function () {

    const HUB_COPY = path.resolve(__dirname, '../../../xchain-hub/src/attest_responsible_widening_activation.js');

    // Skips green when the sibling checkout is absent, matching the house convention in
    // activationConstantsParity.test.js; CI sets XCHAIN_REQUIRE_SIBLINGS=1 to make it hard.
    it('holds the same activation heights and ladder constants as the hub copy', function () {
        if (!fs.existsSync(HUB_COPY)) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                assert.fail('xchain-hub sibling checkout missing: ' + HUB_COPY);
            this.skip();
            return;
        }
        const hub = require(HUB_COPY);
        assert.deepStrictEqual(hub.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION,
                               wid.ATTEST_RESPONSIBLE_WIDENING_ACTIVATION);
        assert.deepStrictEqual(hub.ATTEST_RESPONSIBLE_WIDENING,
                               wid.ATTEST_RESPONSIBLE_WIDENING);
    });

    // Value parity is not enough: the two copies must also DECIDE alike, or a
    // one-sided edit to widenSlots itself forks the set with both constant maps
    // still equal.
    it('answers identically to the hub copy across the whole ladder', function () {
        if (!fs.existsSync(HUB_COPY)) { this.skip(); return; }
        const hub = require(HUB_COPY);
        for (const net of ['mainnet', 'testnet', 'regtest']) {
            for (const dl of [REQ, REQ + 3, REQ + 10, REQ + 100]) {
                for (let at = REQ - 2; at <= dl + 5; at++) {
                    assert.strictEqual(hub.widenSlots(at, REQ, dl, net),
                                       wid.widenSlots(at, REQ, dl, net),
                                       'diverged at ' + net + ' at=' + at + ' deadline=' + dl);
                }
            }
        }
    });
});
