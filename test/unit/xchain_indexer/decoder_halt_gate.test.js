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
 * test/unit/xchain_indexer/decoder_halt_gate.test.js
 *
 * A decoder carrying a durable REORG_HALT is condemned to a reset, and the rows it
 * holds above the fork point are not the node's chain. The poll pass still applies
 * every pending decoder reorg, so the indexer rolls back to what the decoder
 * retracted, and then indexes nothing new until the halt clears.
 *
 * The probe-transition cases drive the real checkDecoderReorgHalt through the real
 * pollDecoderOnce. Cases marked "control" hold on the ungated pass as well; they pin
 * the gate's open side (probe fault with nothing halted, no decoder DB, a malformed
 * probe answer) so a later change cannot close it by accident.
 */

'use strict';

const assert = require('assert');

const blockPollMethods = require('../../../src/XChainIndexer/block_poll');
const barrierClock     = require('../../../src/XChainIndexer/barrier_clock');
const decoderProbes    = require('../../../src/XChainIndexer/decoder_probes');

// A catch-up that reaches a block a barrier defers, the way a real pass behind the
// price mirror does: it names the barrier on the instance.
function deferringCatchUp(ix, calls) {
    return async () => {
        calls.catchUpToDecoder++;
        ix.stallReason = 'price_sync_barrier';
        ix.stallBlock  = 73;
        return { lastIndexerBlock: 72, lastDecoderBlock: 199 };
    };
}

function makeIndexer({ halted, unprocessedReorgs = [] }) {
    const calls = { applyPendingReorgs: 0, catchUpToDecoder: 0 };
    const ix = Object.assign({}, blockPollMethods, barrierClock, {
        util: { isNull: v => v === null || v === undefined, bcsub: (a, b) => a - b, bcadd: (a, b) => a + b,
                bclt: (a, b) => Number(a) < Number(b) },
        synced: true, stallReason: 'price_sync_barrier', stallClearsAt: null, barrierHold: null,
        barrierHoldCeilingMs: 0, barrierCeilingHits: 0,
        decoderDb: {},
        decoderReorgHalted: halted,
        readPollCursors: async () => ({ lastProcessedReorgId: 4, unprocessedReorgs,
                                        lastDecoderBlock: 72, lastIndexerBlock: 199 }),
        applyPendingReorgs: async () => { calls.applyPendingReorgs++; return { lastIndexerBlock: 72, lastProcessedReorgId: 9 }; },
    });
    ix.catchUpToDecoder = deferringCatchUp(ix, calls);
    return { ix, calls };
}

// The real probe and poll pass over a stubbed decoder DB whose halt probe is `probe`.
function makeProbedIndexer(probe, { decoderDb = true, last = false } = {}) {
    const calls = { applyPendingReorgs: 0, catchUpToDecoder: 0 };
    const ix = Object.assign({}, blockPollMethods, barrierClock, decoderProbes, {
        util: { isNull: v => v === null || v === undefined, bcsub: (a, b) => a - b, bcadd: (a, b) => a + b,
                bclt: (a, b) => Number(a) < Number(b) },
        synced: true, stallReason: null, stallClearsAt: null, barrierHold: null,
        barrierHoldCeilingMs: 0, barrierCeilingHits: 0,
        decoderReorgHalted: last,
        decoderDb: decoderDb ? {
            isReorgHalted: probe,
            getReorgsSince: async () => [],
            getBlockIndex: async () => 72,
        } : null,
        applyPendingReorgs: async () => { calls.applyPendingReorgs++; return { lastIndexerBlock: 70, lastProcessedReorgId: 1 }; },
        catchUpToDecoder: async () => { calls.catchUpToDecoder++; return { lastIndexerBlock: 72, lastDecoderBlock: 72 }; },
    });
    const view = { getLastProcessedReorgId: async () => null, getBlockIndex: async () => 70 };
    return { ix, calls, view };
}

describe('the poll pass stops advancing while the decoder reports a durable REORG_HALT @regression @tier1', function () {
    it('still applies the pending decoder reorgs, then indexes nothing new', async function () {
        const { ix, calls } = makeIndexer({ halted: true, unprocessedReorgs: [{ id: 9, block_index: 73 }] });
        await ix.pollDecoderOnce({}, 50);
        assert.strictEqual(calls.applyPendingReorgs, 1, 'the rollback to what the decoder retracted must land');
        assert.strictEqual(calls.catchUpToDecoder, 0, 'nothing above the decoder halt is indexed');
    });

    it('names no stall of its own, so the status surfaces read upstream_halted rather than wedged', async function () {
        // The catch-up stub names a barrier when it runs, so a pass that is not gated
        // ends with a stall reason and this assertion fails.
        const { ix } = makeIndexer({ halted: true });
        await ix.pollDecoderOnce({}, 50);
        assert.strictEqual(ix.stallReason, null);
        assert.strictEqual(ix.stallBlock, null);
    });

    it('control: catches up as before once the halt is gone', async function () {
        const { ix, calls } = makeIndexer({ halted: false });
        await ix.pollDecoderOnce({}, 50);
        assert.strictEqual(calls.catchUpToDecoder, 1);
    });
});

describe('the decoder-halt gate follows the halt probe across passes @regression @tier1', function () {
    it('halted, then a probe fault keeps it halted, then a cleared read resumes with no restart', async function () {
        let mode = 'halted';
        const probe = async () => {
            if (mode === 'throw') throw new Error('probe down');
            return { halted: mode === 'halted', payload: null };
        };
        const { ix, calls, view } = makeProbedIndexer(probe);
        await ix.pollDecoderOnce(view, 50);
        const afterHalted = calls.catchUpToDecoder;
        mode = 'throw';
        await ix.pollDecoderOnce(view, 50);
        const afterThrow = calls.catchUpToDecoder;
        mode = 'clear';
        await ix.pollDecoderOnce(view, 50);
        assert.deepStrictEqual([afterHalted, afterThrow, calls.catchUpToDecoder], [0, 0, 1]);
        assert.strictEqual(ix.decoderReorgHalted, false);
    });

    it('a halted pass applies the pending rollbacks and clears the stall it carried in', async function () {
        const { ix, calls, view } = makeProbedIndexer(async () => ({ halted: true, payload: 'x' }));
        ix.decoderDb.getReorgsSince = async () => [{ id: 3, block_index: 71 }];
        ix.stallReason = 'price_sync_barrier';
        ix.stallBlock  = 71;
        await ix.pollDecoderOnce(view, 50);
        assert.deepStrictEqual([calls.applyPendingReorgs, calls.catchUpToDecoder, ix.stallReason], [1, 0, null]);
    });

    it('control: a probe fault while nothing is known halted leaves the pass advancing', async function () {
        const { ix, calls, view } = makeProbedIndexer(async () => { throw new Error('probe down'); });
        await ix.pollDecoderOnce(view, 50);
        assert.strictEqual(calls.catchUpToDecoder, 1);
    });

    it('control: with no decoder DB the halt check answers the last known state and the gate is open', async function () {
        const { ix } = makeProbedIndexer(null, { decoderDb: false });
        assert.strictEqual(await ix.checkDecoderReorgHalt(), false);
    });

    it('control: a probe answer of the wrong shape (a bare true) reads as not halted', async function () {
        const { ix, calls, view } = makeProbedIndexer(async () => true);
        await ix.pollDecoderOnce(view, 50);
        assert.strictEqual(calls.catchUpToDecoder, 1);
    });
});
