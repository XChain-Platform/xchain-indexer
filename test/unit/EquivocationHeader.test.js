/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/EquivocationHeader.test.js
 *
 * Indexer-side mirror of xchain-hub/test/unit/EquivocationHeader.test.js.
 *
 * CONSENSUS-CRITICAL: the EQUIV header (WI-2 bump 2) is prefixed onto every signed
 * consensus canonical at/above the flag-day; the indexer re-derives those canonicals
 * to re-verify quorum signatures (cross_settle, xexec, xcall, anchor, price, attest)
 * and to verify SLASH equivocation proofs. The hub keeps a byte-equivalent copy; the
 * final block asserts the indexer's activation map equals the canonical in
 * xchain-documentation/protocol/constants.js (a divergence forks the chain).
 ********************************************************************/

'use strict';

const assert = require('assert');
const eq     = require('../../src/equivocation_header.js');

describe('equivocation_header (indexer)', function () {

    describe('isEquivHeaderActive', function () {
        it('regtest activates at genesis (block 0)', function () {
            assert.strictEqual(eq.isEquivHeaderActive(0, 'regtest'), true);
            assert.strictEqual(eq.isEquivHeaderActive(500, 'regtest'), true);
        });
        it('mainnet is placeholder-disabled below the far-future height', function () {
            assert.strictEqual(eq.isEquivHeaderActive(5, 'mainnet'), false);
        });
        it('unknown network is OFF (safe default)', function () {
            assert.strictEqual(eq.isEquivHeaderActive(5, 'bogus'), false);
        });
        it('non-numeric block is OFF', function () {
            assert.strictEqual(eq.isEquivHeaderActive(undefined, 'regtest'), false);
            assert.strictEqual(eq.isEquivHeaderActive('xx', 'regtest'), false);
        });
    });

    describe('buildEquivCanonical / equivPrefix / equivKey', function () {
        it('prefix round-trips even when ROUND_ID contains "|" (checkpoint case)', function () {
            const tag = eq.ENGINE_TAGS.CHECKPOINT;
            const roundId = 'BTC|regtest|500|7';
            const content = 'XCHECKPOINT|BTC|regtest|500|aa|bb|cc|dd|7|100';
            const canon = eq.buildEquivCanonical(tag, roundId, 0, content);
            const prefix = eq.equivPrefix(eq.equivKey(tag, roundId, 0));
            assert.strictEqual(canon.startsWith(prefix), true);
            assert.strictEqual(canon.slice(prefix.length), content);
        });
        it('different VIEW => different prefix (equivocation/honest-view boundary)', function () {
            assert.notStrictEqual(eq.equivKey('XDEX', 'mid', 0), eq.equivKey('XDEX', 'mid', 1));
        });
    });

    describe('cross-service activation parity', function () {
        it('indexer activation map == canonical constants.js', function () {
            const canonical = require('../../../xchain-documentation/protocol/constants.js')
                .EQUIV_HEADER_ACTIVATION;
            assert.deepStrictEqual(eq.EQUIV_HEADER_ACTIVATION, canonical);
        });
    });
});
