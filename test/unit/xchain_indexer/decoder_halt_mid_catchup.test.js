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
 * A catch-up loop re-probes the decoder halt marker on the bounded reorg
 * cadence. REORG_HALT does not need a matching REORG event, so the loop must
 * surface the halt and stop before draining a long backlog.
 */

'use strict';

const assert = require('assert');

const XChainIndexer = require('../../../src/XChainIndexer');
const blockPollMethods = require('../../../src/XChainIndexer/block_poll');
const decoderProbes = require('../../../src/XChainIndexer/decoder_probes');
const { readinessVerdict } = require('../../../src/XChainIndexer/readiness/verdict');

function buildCatchUp({ haltAfter = Infinity, faultAfter = Infinity, tip = 200 } = {}) {
    const parsed = [];
    let haltProbes = 0;
    const ix = Object.assign({}, blockPollMethods, decoderProbes, {
        stopFlag: false,
        synced: true,
        decoderReorgHalted: false,
        util: {
            isNull: value => value === null || value === undefined,
            bclt: (left, right) => Number(left) < Number(right),
            startTimer: () => null,
        },
        decoderDb: {
            getReorgsSince: async () => [],
            isReorgHalted: async () => {
                haltProbes++;
                if(parsed.length >= faultAfter) throw new Error('halt probe unavailable');
                return { halted: parsed.length >= haltAfter };
            },
        },
        parseBlock: async block => {
            parsed.push(block);
            return { committed: true, lastDecoderBlock: tip, stop: false };
        },
        replayWitnessChunkCommitted: async () => false,
    });
    ix.catchUpToDecoder = XChainIndexer.prototype.catchUpToDecoder;
    return { ix, parsed, haltProbes: () => haltProbes };
}

const reorgView = {
    getLastProcessedReorgWitness: async () => null,
};

describe('decoder REORG_HALT during catch-up @regression @tier1', function () {
    it('stops on the next cadence probe and makes readiness fail closed', async function () {
        const { ix, parsed, haltProbes } = buildCatchUp({ haltAfter: 60 });
        const result = await ix.catchUpToDecoder(reorgView, 50, null, 0, 200);

        assert.strictEqual(result.lastIndexerBlock, 100);
        assert.strictEqual(parsed.includes(101), false, 'no block after the detecting probe is parsed');
        assert.strictEqual(ix.decoderReorgHalted, true);
        assert.strictEqual(haltProbes(), 3, 'the halt marker is read only at blocks 0, 50, and 100');
        const verdict = readinessVerdict({ decoderReorgHalted: ix.decoderReorgHalted });
        assert.strictEqual(verdict.ready, false);
        assert.deepStrictEqual(verdict.reasons, ['decoder_reorg_halt']);
    });

    it('control: reaches the tip and probes only on cadence when no halt lands', async function () {
        const { ix, parsed, haltProbes } = buildCatchUp();
        const result = await ix.catchUpToDecoder(reorgView, 50, null, 0, 200);

        assert.strictEqual(result.lastIndexerBlock, 200);
        assert.strictEqual(parsed.length, 200);
        assert.strictEqual(haltProbes(), 4, 'the halt marker is read at blocks 0, 50, 100, and 150');
        assert.strictEqual(ix.decoderReorgHalted, false);
    });

    it('control: a probe fault keeps the last known state and catch-up continues', async function () {
        const { ix, parsed, haltProbes } = buildCatchUp({ faultAfter: 60 });
        const result = await ix.catchUpToDecoder(reorgView, 50, null, 0, 200);

        assert.strictEqual(result.lastIndexerBlock, 200);
        assert.strictEqual(parsed.length, 200);
        assert.strictEqual(haltProbes(), 4);
        assert.strictEqual(ix.decoderReorgHalted, false);
    });
});
