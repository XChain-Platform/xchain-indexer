'use strict';

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
 * Instrumented block processor for performance tests.
 *
 * Blocks are applied by the integration launcher's processBlocks, so a perf run
 * executes production's own pass sequence and cannot measure a block the fleet
 * would not run. Timing comes from wrappers installed on the indexer instance for
 * the duration of the run and removed afterwards.
 */

const launcher = require('../../integration/setup/indexer-launcher');

// Phases MetricsCollector summarises, each timed across every call of the named
// method. decoderRead and commit bracket the block; actionProcessing is the whole
// opening group, which holds the block's transactions.
const METHOD_PHASES = [
    ['decoderDb', 'getDecoderBlockData', 'decoderRead'],
    ['decoderDb', 'getBlockTime',        'decoderRead'],
    ['decoderDb', 'getRawBlockTime',     'decoderRead'],
    ['util',      'processExpirations',  'expirations'],
    ['util',      'processCancellations', 'cancellations'],
    ['indexerDb', 'createBlock',         'blockCreation'],
    ['util',      'processMarketUpdates', 'marketUpdates'],
    ['indexerDb', 'sanityCheck',         'sanityCheck'],
    ['indexerDb', 'commitTransaction',   'commit'],
];
const OPENING_GROUP_PHASE = 'actionProcessing';

// Shadow target[method] with an own property and return the function that puts the
// original back, so a run leaves the instance exactly as it found it.
function shadow(target, method, wrap) {
    const hadOwn = Object.prototype.hasOwnProperty.call(target, method);
    const previous = target[method];
    if (typeof previous !== 'function')
        throw new Error('instrumented-processor: ' + method + ' is not a method of the indexer collaborator');
    target[method] = wrap(previous);
    return () => {
        if (hadOwn) target[method] = previous;
        else delete target[method];
    };
}

/**
 * Process all pending blocks with per-phase timing instrumentation.
 *
 * Each block's phases carry the MetricsCollector names plus one entry per production
 * pass group (launcher.PASS_GROUPS) and finalizeBlock, all in milliseconds.
 *
 * @param {object} indexer    - Initialized indexer from initIndexer()
 * @param {MetricsCollector} collector - A started MetricsCollector instance
 * @returns {{ blocksProcessed: number }}
 */
async function processBlocksInstrumented(indexer, collector) {
    // The block being timed. It opens on the block's first decoder read, which is the
    // launcher's first per-block call, and closes when that block's commit returns;
    // the reorg rollback's own commit happens before any block opens and is not timed.
    let block = null;
    let phases = null;
    const depth = new Map();

    // Add the call's elapsed time to `phase` on the open block. A nested call of a
    // phase already being timed is not counted twice.
    const timed = (phase, run) => async function (...args) {
        if (block === null || depth.get(phase)) return run.apply(this, args);
        depth.set(phase, 1);
        const t = process.hrtime.bigint();
        try {
            return await run.apply(this, args);
        } finally {
            depth.delete(phase);
            if (phases) phases[phase] = (phases[phase] || 0) + Number(process.hrtime.bigint() - t) / 1e6;
        }
    };

    const restores = [];
    try {
        // Timing wrappers go on first so the block opener and closer sit outside them: the
        // block's first decoder read is then timed, and endBlock follows the timed commit.
        for (const [owner, method, phase] of METHOD_PHASES)
            restores.push(shadow(indexer[owner], method, (run) => timed(phase, run)));
        restores.push(shadow(indexer.decoderDb, 'getDecoderBlockData', (read) => async function (blockIndex, ...rest) {
            if (block === null) {
                block = blockIndex;
                phases = {};
                collector.beginBlock(blockIndex);
            }
            return read.call(this, blockIndex, ...rest);
        }));
        restores.push(shadow(indexer.indexerDb, 'commitTransaction', (commit) => async function (...args) {
            const result = await commit.apply(this, args);
            if (block !== null) {
                collector.endBlock(block, phases);
                block = null;
                phases = null;
            }
            return result;
        }));
        // The pass groups are timed by wrapping the methods runBlockPasses calls, named by
        // the launcher from production's module, so no pass is listed here.
        for (const name of launcher.PASS_GROUPS) {
            restores.push(shadow(indexer, name, (run) => timed(name, run)));
            if (name === launcher.PASS_GROUPS[0])
                restores.push(shadow(indexer, name, (run) => timed(OPENING_GROUP_PHASE, run)));
        }
        restores.push(shadow(indexer, 'finalizeBlock', (run) => timed('finalizeBlock', run)));

        const blocksProcessed = await launcher.processBlocks(indexer);
        return { blocksProcessed };
    } catch (error) {
        if (block !== null) collector.recordError(block, error);
        throw error;
    } finally {
        for (const restore of restores.reverse()) restore();
    }
}

module.exports = { processBlocksInstrumented };
