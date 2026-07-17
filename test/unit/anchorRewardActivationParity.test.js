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
 * test/unit/anchorRewardActivationParity.test.js
 *
 * CONSENSUS-CRITICAL twin parity for anchor_reward_activation.js.
 *
 * The hub SIGNS the anchor-publish reward into the XANCPUB attestation; the indexer
 * RE-DERIVES it (never from the wire) at/after the ANCHOR_REWARD flag-day. Both copies
 * must agree on the activation heights, the frozen reward amount, and the gate predicate,
 * or the two sides credit rewards on different anchors (fork). This suite enforces:
 *   1. export parity (map + amount + isAnchorRewardActive behavior), and
 *   2. source byte-identity APART FROM the single self-referential "twin lives in ..."
 *      header line, which legitimately names the OTHER copy and so differs per file.
 * The byte check is what catches accidental comment/logic drift between the twins.
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const indexer = require('../../src/anchor_reward_activation.js');

// The self-reference line each copy carries naming its twin (the OTHER file). It is
// intentionally different per copy and is the only permitted divergence.
const TWIN_REF = /twin lives in xchain-\S+/;

describe('anchor_reward_activation twin parity @regression @tier1', function () {

    it('indexer exports the frozen reward amount and armed BTC mainnet height', function () {
        assert.strictEqual(indexer.ANCHOR_REWARD_AMOUNT, '10.00000000');
        assert.strictEqual(indexer.ANCHOR_REWARD_ACTIVATION.mainnet, 961000);
        assert.strictEqual(indexer.ANCHOR_REWARD_ACTIVATION.regtest, 0);
    });

    it('indexer exports the frozen ARCHIVE reward amount and the  activation map', function () {
        assert.strictEqual(indexer.ARCHIVE_REWARD_AMOUNT, '10.00000000');
        assert.strictEqual(indexer.ARCHIVE_REWARD_ACTIVATION.mainnet, 969500);   //  armed 2026-07-16: BTC ~2026-10-01 ratified anchor
        assert.strictEqual(indexer.ARCHIVE_REWARD_ACTIVATION.regtest, 0);
    });

    it('archive gate predicate is height-gated per network (below off, at/above on, unknown off)', function () {
        assert.strictEqual(indexer.isArchiveRewardActive(969499, 'mainnet'), false);
        assert.strictEqual(indexer.isArchiveRewardActive(969500, 'mainnet'), true);
        assert.strictEqual(indexer.isArchiveRewardActive(0, 'regtest'), true);
        assert.strictEqual(indexer.isArchiveRewardActive(5, 'bogusnet'), false);
        assert.strictEqual(indexer.isArchiveRewardActive('not-a-number', 'mainnet'), false);
    });

    it('gate predicate is height-gated per network (below off, at/above on, unknown off)', function () {
        assert.strictEqual(indexer.isAnchorRewardActive(960999, 'mainnet'), false);
        assert.strictEqual(indexer.isAnchorRewardActive(961000, 'mainnet'), true);
        assert.strictEqual(indexer.isAnchorRewardActive(0, 'regtest'), true);
        assert.strictEqual(indexer.isAnchorRewardActive(5, 'bogusnet'), false);
        assert.strictEqual(indexer.isAnchorRewardActive('not-a-number', 'mainnet'), false);
    });

    // Cross-service parity: resolved by monorepo-relative path, so this only runs in the
    // monorepo/aggregator checkout; standalone single-repo CI skips (unless a required-
    // sibling job sets XCHAIN_REQUIRE_SIBLINGS=1, where a missing sibling hard-fails).
    describe('hub twin cross-check', function () {
        function loadHub(){
            const p = '../../../xchain-hub/src/anchor_reward_activation.js';
            return { mod: require(p), file: require.resolve(p) };
        }

        it('hub export map + amount + predicate match the indexer', function () {
            let hub;
            try { hub = loadHub(); }
            catch (e) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('anchor-reward twin parity cannot run: xchain-hub sibling missing (' + e.message + ')');
                return this.skip();
            }
            assert.deepStrictEqual(hub.mod.ANCHOR_REWARD_ACTIVATION, indexer.ANCHOR_REWARD_ACTIVATION, 'activation map');
            assert.strictEqual(hub.mod.ANCHOR_REWARD_AMOUNT, indexer.ANCHOR_REWARD_AMOUNT, 'reward amount');
            assert.deepStrictEqual(hub.mod.ARCHIVE_REWARD_ACTIVATION, indexer.ARCHIVE_REWARD_ACTIVATION, 'archive activation map');
            assert.strictEqual(hub.mod.ARCHIVE_REWARD_AMOUNT, indexer.ARCHIVE_REWARD_AMOUNT, 'archive reward amount');
            for(const [sb, net] of [[960999,'mainnet'],[961000,'mainnet'],[0,'regtest'],[5,'bogusnet']]){
                assert.strictEqual(hub.mod.isAnchorRewardActive(sb, net), indexer.isAnchorRewardActive(sb, net),
                    'predicate parity @ ' + net + ':' + sb);
            }
            for(const [sb, net] of [[969499,'mainnet'],[969500,'mainnet'],[0,'regtest'],[5,'bogusnet']]){
                assert.strictEqual(hub.mod.isArchiveRewardActive(sb, net), indexer.isArchiveRewardActive(sb, net),
                    'archive predicate parity @ ' + net + ':' + sb);
            }
        });

        it('hub and indexer source are byte-identical apart from the twin-reference line', function () {
            let hubFile;
            try { hubFile = loadHub().file; }
            catch (e) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('anchor-reward twin byte parity cannot run: xchain-hub sibling missing (' + e.message + ')');
                return this.skip();
            }
            const norm = (p) => fs.readFileSync(p, 'utf8')
                .split(/\r?\n/)
                .map(l => TWIN_REF.test(l) ? '<TWIN-REF>' : l)
                .join('\n');
            assert.strictEqual(
                norm(path.join(__dirname, '../../src/anchor_reward_activation.js')),
                norm(hubFile),
                'anchor_reward_activation.js drifted between hub and indexer (only the "twin lives in ..." line may differ)'
            );
        });
    });
});
