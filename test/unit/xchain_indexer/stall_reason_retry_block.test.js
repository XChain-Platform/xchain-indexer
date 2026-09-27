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
 * test/unit/xchain_indexer/stall_reason_retry_block.test.js
 */

'use strict';

const assert = require('assert');

const blockCommitMethods = require('../../../src/XChainIndexer/block_commit');
const blockPollMethods   = require('../../../src/XChainIndexer/block_poll');
const barrierClock       = require('../../../src/XChainIndexer/barrier_clock');

function makeIndexer(catchUp) {
    const cursors = { lastProcessedReorgId: null, unprocessedReorgs: [],
                      lastDecoderBlock: 10, lastIndexerBlock: 9 };
    const ix = Object.assign({}, blockCommitMethods, blockPollMethods, barrierClock, {
        util: { isNull: v => v === null || v === undefined, bcsub: (a, b) => a - b, bcadd: (a, b) => a + b,
                bclt: (a, b) => Number(a) < Number(b) },
        synced: true, stallReason: null, stallClearsAt: null, stallBlock: null, barrierHold: null,
        barrierHoldCeilingMs: 0, barrierCeilingHits: 0,
        decoderDb: {},
        readPollCursors: async () => cursors,
        catchUpToDecoder: async function () { return catchUp.call(this); },
    });
    ix.cursors = cursors;
    return ix;
}

describe('stallReason across a same-block retry', function () {
    it('keeps the reason and deadline visible while the deferred block is retried', async function () {
        const clearsAt = Date.now() + 60000;
        let pass = 0;
        const ix = makeIndexer(async function () {
            pass++;
            if(pass === 1){
                this.stallReason = 'attest_response_sync_barrier';
                this.stallClearsAt = clearsAt;
            } else {
                assert.strictEqual(this.stallReason, 'attest_response_sync_barrier');
                assert.strictEqual(this.stallClearsAt, clearsAt);
            }
            return { lastIndexerBlock: 9, lastDecoderBlock: 10 };
        });

        await ix.pollDecoderOnce({}, 50);
        assert.strictEqual(ix.stallBlock, 10);
        await ix.pollDecoderOnce({}, 50);
        assert.strictEqual(pass, 2);
    });

    it('clears the reason when the cursor has moved to a different next block', async function () {
        let pass = 0;
        const ix = makeIndexer(async function () {
            pass++;
            if(pass === 1){
                this.stallReason = 'attest_response_sync_barrier';
                this.stallClearsAt = Date.now() + 60000;
                return { lastIndexerBlock: 9, lastDecoderBlock: 10 };
            }
            assert.strictEqual(this.stallReason, null);
            assert.strictEqual(this.stallClearsAt, null);
            assert.strictEqual(this.stallBlock, null);
            return { lastIndexerBlock: 10, lastDecoderBlock: 10 };
        });

        await ix.pollDecoderOnce({}, 50);
        ix.cursors.lastIndexerBlock = 10;
        ix.cursors.lastDecoderBlock = 11;
        await ix.pollDecoderOnce({}, 50);
    });

    it('clears a reason that has no recorded stall block', async function () {
        const ix = makeIndexer(async function () {
            assert.strictEqual(this.stallReason, null);
            assert.strictEqual(this.stallClearsAt, null);
            assert.strictEqual(this.stallBlock, null);
            return { lastIndexerBlock: 10, lastDecoderBlock: 10 };
        });
        ix.stallReason = 'attest_response_sync_barrier';
        ix.stallClearsAt = Date.now() + 60000;

        await ix.pollDecoderOnce({}, 50);
    });

    it('does not restore a reason cleared by a commit', async function () {
        const ix = makeIndexer(async function () {
            assert.strictEqual(this.stallReason, null);
            assert.strictEqual(this.stallClearsAt, null);
            return { lastIndexerBlock: 10, lastDecoderBlock: 10 };
        });
        ix.stallReason = 'attest_response_sync_barrier';
        ix.stallClearsAt = Date.now() + 60000;
        ix.noteBarrierHold(10);
        assert.strictEqual(ix.stallBlock, 10);
        ix.markBlockCommitted(10);

        await ix.pollDecoderOnce({}, 50);
        assert.strictEqual(ix.stallReason, null);
        assert.strictEqual(ix.stallBlock, null);
    });
});
