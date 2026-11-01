/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Block-time sentinel guard in parseBlock.
 *
 * The decoder block-time readers return literal `false` for an absent blocks
 * row. Number(false) is 0, which is finite, so a clock-keyed mirror barrier
 * compares its watermark against 0 and opens. parseBlock must defer such a block
 * before any barrier or pass sees it, under a stall reason that is not a mirror
 * barrier, since a mirror resync cannot restore a decoder row.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const blockParse = require('../../../../src/XChainIndexer/block_parse.js');
const { isMirrorBarrierReason } = require('../../../../src/XChainIndexer/stall_health.js');

const GOOD_TIME = 1700000000;

function indexerWith(blockTime, rawBlockTime) {
    return {
        stallReason: null,
        stallClearsAt: 12345,
        checkTrainActivation: sinon.stub().resolves(false),
        readBlockInputs: sinon.stub().resolves({
            blockTransactions: [], anchorHorizonBound: null, blockTime: blockTime, rawBlockTime: rawBlockTime,
        }),
        deferOnSyncBarriers: sinon.stub().resolves(false),
        processBlock: sinon.stub().resolves({ committed: true, stop: false, lastDecoderBlock: 20 }),
    };
}

describe('parseBlock block-time sentinel guard @regression @tier1', function () {

    const UNUSABLE = [false, true, null, undefined, NaN, 0, -5, '', 'not-a-time', Infinity];

    for (const bad of UNUSABLE) {
        it('defers before the barriers when the protocol block time is ' + String(bad), async function () {
            const indexer = indexerWith(bad, GOOD_TIME);
            const step = await blockParse.parseBlock.call(indexer, 11, 10, 20, null);
            assert.deepStrictEqual(step, { committed: false, stop: true, lastDecoderBlock: 20 });
            assert.strictEqual(indexer.stallReason, 'decoder_block_time_unavailable');
            assert.strictEqual(indexer.stallClearsAt, null);
            sinon.assert.notCalled(indexer.deferOnSyncBarriers);
            sinon.assert.notCalled(indexer.processBlock);
        });

        it('defers before the barriers when the raw block time is ' + String(bad), async function () {
            const indexer = indexerWith(GOOD_TIME, bad);
            const step = await blockParse.parseBlock.call(indexer, 11, 10, 20, null);
            assert.strictEqual(step.committed, false);
            assert.strictEqual(step.stop, true);
            assert.strictEqual(indexer.stallReason, 'decoder_block_time_unavailable');
            sinon.assert.notCalled(indexer.deferOnSyncBarriers);
            sinon.assert.notCalled(indexer.processBlock);
        });
    }

    it('passes a numeric block time through to the barriers and the passes unchanged', async function () {
        const indexer = indexerWith(GOOD_TIME, GOOD_TIME + 30);
        const step = await blockParse.parseBlock.call(indexer, 11, 10, 20, null);
        assert.strictEqual(step.committed, true);
        sinon.assert.calledOnceWithExactly(indexer.deferOnSyncBarriers, 11, GOOD_TIME, [], null);
        assert.strictEqual(indexer.processBlock.firstCall.args[0].rawBlockTime, GOOD_TIME + 30);
        assert.strictEqual(indexer.stallReason, null);
    });

    it('accepts a digit-string block time, the form a BIGINT column can arrive in', async function () {
        const indexer = indexerWith(String(GOOD_TIME), String(GOOD_TIME));
        await blockParse.parseBlock.call(indexer, 11, 10, 20, null);
        sinon.assert.calledOnceWithExactly(indexer.deferOnSyncBarriers, 11, String(GOOD_TIME), [], null);
        sinon.assert.calledOnce(indexer.processBlock);
    });

    it('names a stall reason that never requests a hub-mirror resync', function () {
        assert.strictEqual(isMirrorBarrierReason('decoder_block_time_unavailable'), false);
    });
});
