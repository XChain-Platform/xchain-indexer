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
 * test/unit/consensus/equivocation_header.test.js
 *
 * Indexer-side mirror of xchain-hub/test/unit/consensus/equivocation_header.test.js.
 *
 * CONSENSUS-CRITICAL: the EQUIV equivocation header is prefixed onto every signed
 * consensus canonical at/above the flag-day; the indexer re-derives those canonicals
 * to re-verify quorum signatures (cross_settle, xexec, xcall, anchor, price, attest)
 * and to verify SLASH equivocation proofs. The hub keeps a byte-equivalent copy; the
 * final block asserts the indexer's activation map equals the canonical in
 * xchain-documentation/protocol/constants.js (a divergence forks the chain).
 ********************************************************************/

'use strict';

const assert = require('assert');
const path   = require('path');
const eq     = require('../../../../src/consensus/equivocation_header.js');
// Decides whether each sibling path may be trusted before the parity guards require it.
const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');

const DOCS_DIR = process.env.XCHAIN_DOCS_DIR
    ? path.resolve(process.env.XCHAIN_DOCS_DIR)
    : path.resolve(__dirname, '../../../../../xchain-documentation');
const SIBLING_COPIES = {
    hub: path.join(process.env.XCHAIN_HUB_DIR
        ? path.resolve(process.env.XCHAIN_HUB_DIR)
        : path.resolve(__dirname, '../../../../../xchain-hub'), 'src', 'consensus', 'equivocation_header.js'),
    sdk: path.join(process.env.XCHAIN_SDK_PATH
        ? path.resolve(process.env.XCHAIN_SDK_PATH)
        : path.resolve(__dirname, '../../../../../xchain-sdk'), 'src', 'consensus', 'equivocation_header.js'),
    explorer: path.join(process.env.XCHAIN_EXPLORER_DIR
        ? path.resolve(process.env.XCHAIN_EXPLORER_DIR)
        : path.resolve(__dirname, '../../../../../xchain-explorer'), 'src', 'consensus', 'equivocation_header.js')
};

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
});

describe('equivocation_header (indexer)', function () {
    describe('cross-service activation parity', function () {
        // These cross-service checks resolve the canonical/sibling sources by
        // monorepo-relative path, so they only run in the monorepo (or aggregator)
        // checkout; in standalone single-repo CI the siblings are absent and the test
        // skips. The authoritative cross-repo byte-identity is enforced by the dedicated
        // consensus-primitive conformance gate, so the skip is not a false green.
        it('indexer activation map == canonical constants.js', function () {
            // Judged before the require: a lane symlink into a live main checkout would
            // load uncommitted constants and pass against them.
            const constantsPath = path.join(DOCS_DIR, 'protocol', 'constants.js');
            const docs = siblingCheckout(__dirname, constantsPath);
            if (!docs.usable) return skipOrFail(this, docs, 'the canonical constants.js equivocation activation parity');
            let canonical;
            // A trusted file that fails to load is a broken sibling: fail it under XCHAIN_REQUIRE_SIBLINGS=1.
            try { canonical = require(constantsPath).EQUIV_HEADER_ACTIVATION; }
            catch (e) {
                return skipOrFail(this, { usable: false, reason: 'canonical constants.js is present but failed to load: ' + e.message },
                    'the canonical constants.js equivocation activation parity');
            }
            assert.deepStrictEqual(eq.EQUIV_HEADER_ACTIVATION, canonical);
        });
        it('all 5 copies == indexer (map + tags + builder bytes)', function () {
            // hub + indexer (server consensus) + sdk + explorer (client checkpoint
            // verifiers). A drift in ANY copy flips the header on different blocks → fork.
            // Every copy must be a trusted checkout, as the require block below needs all three.
            for (const copyPath of Object.values(SIBLING_COPIES)) {
                const copy = siblingCheckout(__dirname, copyPath);
                if (!copy.usable) return skipOrFail(this, copy, 'the five-copy equivocation_header parity');
            }
            let copies;
            // Every copy passed the precheck, so a load failure here is a broken sibling, never an absent one.
            try {
                copies = {
                    hub:      require(SIBLING_COPIES.hub),
                    sdk:      require(SIBLING_COPIES.sdk),
                    explorer: require(SIBLING_COPIES.explorer),
                };
            } catch (e) {
                return skipOrFail(this, { usable: false, reason: 'a sibling equivocation_header.js is present but failed to load: ' + e.message },
                    'the five-copy equivocation_header parity');
            }
            const ref = eq.buildEquivCanonical('XDEX', 'mid', 2, 'XMATCH|mid|x');
            for(const name of Object.keys(copies)){
                const copy = copies[name];
                assert.deepStrictEqual(copy.EQUIV_HEADER_ACTIVATION, eq.EQUIV_HEADER_ACTIVATION, name + ' activation map');
                assert.deepStrictEqual(copy.ENGINE_TAGS, eq.ENGINE_TAGS, name + ' engine tags');
                assert.strictEqual(copy.buildEquivCanonical('XDEX', 'mid', 2, 'XMATCH|mid|x'), ref, name + ' builder bytes');
            }
        });
    });
});
