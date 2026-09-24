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
 * test/unit/xchain_indexer/stall_reason_current.test.js
 *
 * stallReason is set by the defer sites and was cleared only by a commit, so a
 * reason from an earlier pass kept showing on /status after the block moved to a
 * different hold or the pass never reached a block. Each poll pass now starts
 * with no stall named, while the barrier hold stays keyed on the block.
 */

'use strict';

const assert = require('assert');

const blockPollMethods = require('../../../src/XChainIndexer/block_poll');
const barrierClock     = require('../../../src/XChainIndexer/barrier_clock');

function makeIndexer(catchUp) {
    return Object.assign({}, blockPollMethods, barrierClock, {
        util: { isNull: v => v === null || v === undefined, bcsub: (a, b) => a - b, bcadd: (a, b) => a + b,
                bclt: (a, b) => Number(a) < Number(b) },
        synced: true, stallReason: null, stallClearsAt: null, barrierHold: null,
        barrierHoldCeilingMs: 0, barrierCeilingHits: 0,
        decoderDb: {},
        readPollCursors: async () => ({ lastProcessedReorgId: null, unprocessedReorgs: [],
                                        lastDecoderBlock: 10, lastIndexerBlock: 9 }),
        catchUpToDecoder: async function () { return catchUp.call(this); },
    });
}

describe('stallReason names only the current hold', function () {
    it('drops a reason left over from an earlier pass when this pass defers nothing', async function () {
        const ix = makeIndexer(async () => ({ lastIndexerBlock: 10, lastDecoderBlock: 10 }));
        ix.stallReason = 'price_sync_barrier';
        ix.stallClearsAt = Date.now() + 5000;
        await ix.pollDecoderOnce({}, 50);
        assert.strictEqual(ix.stallReason, null);
        assert.strictEqual(ix.stallClearsAt, null);
        assert.strictEqual(ix.barrierHold, null);
    });

    it('reports the new reason when the block moves to a different hold', async function () {
        const ix = makeIndexer(async function () {
            assert.strictEqual(this.stallReason, null, 'pass must start with no stall named');
            this.stallReason = 'call_sync_barrier';
            return { lastIndexerBlock: 9, lastDecoderBlock: 10 };
        });
        ix.stallReason = 'price_sync_barrier';
        await ix.pollDecoderOnce({}, 50);
        assert.strictEqual(ix.stallReason, 'call_sync_barrier');
    });

    it('keeps the hold keyed on the block across passes that re-defer it', async function () {
        const ix = makeIndexer(async function () {
            this.stallReason = 'price_sync_barrier';
            return { lastIndexerBlock: 9, lastDecoderBlock: 10 };
        });
        await ix.pollDecoderOnce({}, 50);
        const since = ix.barrierHold.since;
        assert.strictEqual(ix.barrierHold.block, 10);
        await ix.pollDecoderOnce({}, 50);
        assert.strictEqual(ix.barrierHold.since, since);
        assert.strictEqual(ix.barrierHold.block, 10);
    });
});
