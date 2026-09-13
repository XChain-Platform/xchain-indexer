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
 * Unit: XChainIndexer._priceMirrorHorizon()
 *
 * The consumer half of the hub price-mirror bound. It answers ONE question -
 * how far back can a price read of any block this node will process reach -
 * and HubDbSync bootstraps price_snapshots from there up instead of replaying
 * the oracle's entire history before the price barrier can arm.
 *
 * Every failure mode here has to answer null, meaning "mirror everything":
 * the bound may make a bootstrap slow, never short.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert        = require('assert');
const sinon         = require('sinon');
const XChainIndexer = require('../../src/XChainIndexer.js');

const BLOCK_TIME = 2000000000;

// A bare indexer with just the two DB handles the horizon reads. lastIndexed null
// models a node with nothing parsed yet, which must fall back to the decoder's
// FIRST block (genesis on a clean reindex).
function makeIndexer(lastIndexed, firstDecoderBlock, times){
    let indexer = new XChainIndexer();
    // config is populated by start(); this method runs after that, so give it the one
    // key it reads rather than depending on constructor internals.
    indexer.config    = {};
    indexer.indexerDb = {
        getBlockIndex:   sinon.stub().resolves(lastIndexed),
        getRawBlockTime: sinon.stub().callsFake(async (b) => (b in times) ? times[b] : false)
    };
    indexer.decoderDb = {
        getBlockIndex:   sinon.stub().resolves(firstDecoderBlock),
        getRawBlockTime: sinon.stub().callsFake(async (b) => (b in times) ? times[b] : false)
    };
    return indexer;
}

describe('XChainIndexer._priceMirrorHorizon @regression @tier2', function () {

    afterEach(function () { sinon.restore(); });

    it('sets the horizon back from the tip by both read windows and a day of slop', async function () {
        // reverseOraclePriceMatch reaches (blockTime - window) - window behind the block it
        // settles, so one window is not enough; the extra day covers block-time
        // non-monotonicity and a reorg below the resume point without a restart.
        let indexer = makeIndexer(500, null, { 500: BLOCK_TIME });
        indexer.config['FIAT_DISPENSER_PRICE_WINDOW'] = 3600;

        assert.strictEqual(await indexer._priceMirrorHorizon(),
            BLOCK_TIME - (2 * 3600) - 86400);
    });

    it('defaults the window to a day when the config does not set one', async function () {
        let indexer = makeIndexer(500, null, { 500: BLOCK_TIME });
        delete indexer.config['FIAT_DISPENSER_PRICE_WINDOW'];

        assert.strictEqual(await indexer._priceMirrorHorizon(),
            BLOCK_TIME - (2 * 86400) - 86400);
    });

    it('anchors on the decoder first block when nothing is indexed yet', async function () {
        // A clean reindex starts at genesis, so the horizon is old enough that the bound
        // holds back nothing at all and the full history is mirrored - by construction,
        // not by a special case.
        let indexer = makeIndexer(null, 12, { 12: 1500000000 });
        indexer.config['FIAT_DISPENSER_PRICE_WINDOW'] = 86400;

        assert.strictEqual(await indexer._priceMirrorHorizon(),
            1500000000 - (2 * 86400) - 86400);
    });

    it('answers null when no chain has any blocks yet', async function () {
        let indexer = makeIndexer(null, null, {});
        assert.strictEqual(await indexer._priceMirrorHorizon(), null);
    });

    it('answers null when the anchor block has no readable time', async function () {
        // getRawBlockTime returns the `false` sentinel for a block it cannot resolve.
        let indexer = makeIndexer(500, null, {});
        assert.strictEqual(await indexer._priceMirrorHorizon(), null);
    });

    it('answers null rather than throwing when a read faults', async function () {
        let indexer = makeIndexer(500, null, { 500: BLOCK_TIME });
        indexer.indexerDb.getRawBlockTime = sinon.stub().rejects(new Error('lock wait timeout'));

        assert.strictEqual(await indexer._priceMirrorHorizon(), null);
    });
});
