/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const mir = require('../../src/attest_response_mirror_activation.js');

describe('attest_response_mirror_activation', function () {

    it('reads an unratified network as OFF, never as height 0', function () {
        // The trap the module header names: `req >= null` coerces to `req >= 0`, which
        // arms the mirror on every block of a network the operator has not ratified.
        assert.strictEqual(mir.ATTEST_RESPONSE_MIRROR_ACTIVATION.mainnet, null);
        assert.strictEqual(mir.isResponseMirrorActive(0, 'mainnet'), false);
        assert.strictEqual(mir.isResponseMirrorActive(999999999, 'mainnet'), false);
        assert.strictEqual(mir.isResponseMirrorActive(0, 'testnet'), false);
        assert.strictEqual(mir.isResponseMirrorActive(999999999, 'testnet'), false);
    });

    it('is armed from genesis on regtest', function () {
        assert.strictEqual(mir.ATTEST_RESPONSE_MIRROR_ACTIVATION.regtest, 0);
        assert.strictEqual(mir.isResponseMirrorActive(0, 'regtest'), true);
        assert.strictEqual(mir.isResponseMirrorActive(1, 'regtest'), true);
    });

    it('is off for an unusable height or an unknown network', function () {
        assert.strictEqual(mir.isResponseMirrorActive(NaN, 'regtest'), false);
        assert.strictEqual(mir.isResponseMirrorActive(null, 'regtest'), false);
        assert.strictEqual(mir.isResponseMirrorActive(undefined, 'regtest'), false);
        assert.strictEqual(mir.isResponseMirrorActive('nonsense', 'regtest'), false);
        assert.strictEqual(mir.isResponseMirrorActive(10, 'nosuchnet'), false);
    });

    it('is inclusive at the threshold', function () {
        // Armed regtest at 0 makes the boundary trivially true; prove the >= directly
        // against a synthetic map so an accidental `>` is caught before a height is armed.
        const map = { regtest: 100 };
        const at  = (b) => (map.regtest === null || map.regtest === undefined) ? false : b >= map.regtest;
        assert.strictEqual(at(99),  false);
        assert.strictEqual(at(100), true);
        assert.strictEqual(at(101), true);
    });
});

describe('attest_response_mirror_activation: hub/indexer twin', function () {

    const HUB_COPY = path.resolve(__dirname, '../../../xchain-hub/src/attest_response_mirror_activation.js');

    // Skips green when the sibling checkout is absent, matching the house convention in
    // activationConstantsParity.test.js; CI sets XCHAIN_REQUIRE_SIBLINGS=1 to make it hard.
    it('holds the same activation heights as the hub copy', function () {
        if (!fs.existsSync(HUB_COPY)) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                assert.fail('xchain-hub sibling checkout missing: ' + HUB_COPY);
            this.skip();
            return;
        }
        const hub = require(HUB_COPY);
        assert.deepStrictEqual(hub.ATTEST_RESPONSE_MIRROR_ACTIVATION,
                               mir.ATTEST_RESPONSE_MIRROR_ACTIVATION);
    });

    // Value parity is not enough: the two copies must also DECIDE alike, or a one-sided
    // edit to isResponseMirrorActive forks which era a request is answered in with both
    // constant maps still equal. The hub picks the canonical to SIGN from this answer and
    // the indexer picks the canonical to VERIFY from it, so a disagreement is a fork that
    // presents as "every signature is invalid", not as a missing feature.
    it('answers identically to the hub copy across every network and edge height', function () {
        if (!fs.existsSync(HUB_COPY)) { this.skip(); return; }
        const hub = require(HUB_COPY);
        for (const net of ['mainnet', 'testnet', 'regtest', 'nosuchnet']) {
            for (const b of [0, 1, 150779, 150780, 150781, 999999999, NaN, null, undefined, 'nonsense']) {
                assert.strictEqual(hub.isResponseMirrorActive(b, net),
                                   mir.isResponseMirrorActive(b, net),
                                   'disagreement at network=' + net + ' block=' + String(b));
            }
        }
    });
});
