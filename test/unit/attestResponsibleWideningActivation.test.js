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

// The measured incident: BTC testnet4 request 77f37a86..., admitted at 150699
// with deadlineBlocks 10 and redundancy 3, whose responsible set held one
// validator that had never connected to the federation.
const REQ      = 150699;
const DEADLINE = 150709;

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
            // At the flag day: the ladder runs normally.
            assert.strictEqual(wid.widenSlots(height + 21, height, height + 30, net),
                wid.ATTEST_RESPONSIBLE_WIDENING.maxSlots, net + ': a request at the height must widen');
        }
    });

    it('grants nothing in the first segment and both slots before the deadline', function () {
        for (const at of [REQ, REQ + 3, 150704]) assert.strictEqual(wid.widenSlots(at, REQ, DEADLINE, 'regtest'), 0, 'block ' + at);
        assert.strictEqual(wid.widenSlots(150705, REQ, DEADLINE, 'regtest'), 1);
        assert.strictEqual(wid.widenSlots(150707, REQ, DEADLINE, 'regtest'), 2);
        assert.strictEqual(wid.widenSlots(DEADLINE, REQ, DEADLINE, 'regtest'), 2);
    });

    // The property the two sides rely on to agree: the hub derives its slots from the
    // indexer tip it polled, this file derives them from the block the response landed
    // in, and a response cannot be mined below that tip. Monotonicity therefore makes
    // the indexer's set a superset of the signing hub's, never a subset.
    it('is monotone non-decreasing in height', function () {
        let prev = 0;
        for (let at = REQ; at <= DEADLINE + 20; at++) {
            const v = wid.widenSlots(at, REQ, DEADLINE, 'regtest');
            assert.ok(v >= prev, 'went backwards at block ' + at);
            prev = v;
        }
        assert.strictEqual(prev, wid.ATTEST_RESPONSIBLE_WIDENING.maxSlots);
    });

    it('grants nothing on a degenerate span or an unusable height', function () {
        assert.strictEqual(wid.widenSlots(REQ + 50, REQ, REQ, 'regtest'), 0);
        assert.strictEqual(wid.widenSlots(REQ + 50, REQ, REQ + 3, 'regtest'), 0);
        assert.strictEqual(wid.widenSlots(NaN, REQ, DEADLINE, 'regtest'), 0);
        assert.strictEqual(wid.widenSlots(REQ + 8, REQ, null, 'regtest'), 0);
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
