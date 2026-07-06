/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Integration test - 15: SDK<->indexer fee-fragment parity (drift guard).
 *
 * The SDK ships its own isValidAmountFormat for client-side pre-submission
 * checks. It is NOT auto-synced with the indexer's (and the indexer has extra
 * object/negative guards), but the FRACTIONAL-PRECISION-CAP fragment must
 * agree so the SDK never builds an amount the consensus-authoritative indexer
 * would reject (item 5346). No sync script exists, so this fragment-parity
 * suite is the drift guard.
 *
 * It lives in the integration tier (not test/unit) because it needs a REAL
 * xchain-sdk checkout: in the local monorepo layout that is the sibling
 * directory; in CI the integration workflow checks the private sdk repo out
 * to .xchain-sdk and points XCHAIN_SDK_PATH at it. The unit tier runs in the
 * shared reusable workflow with only this repo checked out, which is exactly
 * why this file cannot live there. No database is required.
 *
 * A missing sdk checkout is a hard FAILURE, never a skip: a silently skipped
 * drift guard is a false green (the drift it exists to catch would ship).
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Set env before requiring Utility (it loads config in its constructor).
process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility = require('../../../src/utility.js');

// Resolve the sdk checkout: explicit XCHAIN_SDK_PATH (CI) first, then the
// sibling monorepo layout (local dev).
function resolveSdkUtilityPath() {
    const candidates = [
        process.env.XCHAIN_SDK_PATH,
        path.join(__dirname, '..', '..', '..', '..', 'xchain-sdk'),
    ].filter(Boolean);
    for (const root of candidates) {
        const p = path.join(root, 'src', 'utility.js');
        if (fs.existsSync(p)) return p;
    }
    throw new Error(
        'xchain-sdk checkout not found (tried XCHAIN_SDK_PATH and the sibling ' +
        'monorepo layout). This parity suite is a consensus drift guard and must ' +
        'not be skipped: point XCHAIN_SDK_PATH at an xchain-sdk checkout.');
}

describe('15 – SDK<->indexer fee-fragment parity @regression @tier1', function () {

    describe('isValidAmountFormat() fractional-cap parity', function () {
        const util = new Utility();
        const SdkUtility = require(resolveSdkUtilityPath());
        const sdkUtil = new SdkUtility();
        const cases = [
            [0, '100', true], [0, '1.5', false],
            [8, '1.00000001', true], [8, '1.000000001', false],
            [8, '1.5', true], [2, '1.123', false], [2, '1.12', true],
            [8, '100', true],
        ];
        cases.forEach(function ([decimals, amount, expected]) {
            it(`decimals=${decimals} amount=${amount} -> ${expected} (both)`, function () {
                assert.strictEqual(util.isValidAmountFormat(decimals, amount), expected, 'indexer');
                assert.strictEqual(sdkUtil.isValidAmountFormat(decimals, amount), expected, 'sdk');
            });
        });
    });
});
