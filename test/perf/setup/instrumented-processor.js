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
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Instrumented block processor for performance tests.
 *
 * THIS FUNCTION IS A VERBATIM COPY of processBlocks() in
 * test/integration/setup/indexer-launcher.js with per-phase
 * timing instrumentation added. If processBlocks() changes,
 * this file must be updated to match.
 */

/**
 * Process all pending blocks with per-phase timing instrumentation.
 *
 * @param {object} indexer    - Initialized indexer from initIndexer()
 * @param {MetricsCollector} collector - A started MetricsCollector instance
 * @returns {{ blocksProcessed: number, stats: object }}
 */
async function processBlocksInstrumented(indexer, collector) {
    let blocksProcessed = 0;

    // --- Reorg handling (identical to processBlocks) ---
    // Match the decoder's reorg event by IDENTITY (events.id), not block-height
    // magnitude, so consecutive higher-block reorgs are not missed.
    const decoderReorg         = await indexer.decoderDb.getLatestReorg();
    const lastProcessedReorgId = await indexer.indexerDb.getLastProcessedReorgId();

    let lastDecoderBlock = await indexer.decoderDb.getBlockIndex('decoder', 'last');
    let lastIndexerBlock = await indexer.indexerDb.getBlockIndex('indexer', 'last');

    if (decoderReorg !== null && decoderReorg.id !== lastProcessedReorgId) {
        await indexer.indexerDb.createReorg(decoderReorg.block_index, decoderReorg.id);
        if (lastIndexerBlock !== null && lastIndexerBlock >= decoderReorg.block_index) {
            await indexer.rollback.rollback(decoderReorg.block_index);
        }
        lastIndexerBlock = await indexer.indexerDb.getBlockIndex('indexer', 'last');
    }

    // Initialize start position if indexer is empty
    if (lastIndexerBlock === null) {
        const firstDecoderBlock = await indexer.decoderDb.getBlockIndex('decoder', 'first');
        if (firstDecoderBlock !== null) {
            lastIndexerBlock = firstDecoderBlock - 1;
        }
    }

    // Process all pending blocks with instrumentation
    while (lastIndexerBlock !== null && lastDecoderBlock !== null &&
           lastIndexerBlock < lastDecoderBlock) {

        lastIndexerBlock++;
        collector.beginBlock(lastIndexerBlock);

        const phases = {};
        let t;

        // Phase: decoderRead
        t = process.hrtime.bigint();
        const blockTransactions = await indexer.decoderDb.getDecoderBlockData(lastIndexerBlock);
        const blockTime = await indexer.decoderDb.getBlockTime(lastIndexerBlock);
        phases.decoderRead = Number(process.hrtime.bigint() - t) / 1e6;

        await indexer.indexerDb.beginTransaction();
        try {
            // Phase: actionProcessing
            t = process.hrtime.bigint();
            for (const tx of blockTransactions) {
                await indexer.actions.processTransaction(tx);
            }
            phases.actionProcessing = Number(process.hrtime.bigint() - t) / 1e6;

            // Phase: expirations
            t = process.hrtime.bigint();
            await indexer.util.processExpirations(indexer.actions, indexer.indexerDb, lastIndexerBlock, blockTime);
            phases.expirations = Number(process.hrtime.bigint() - t) / 1e6;

            // Phase: cancellations
            t = process.hrtime.bigint();
            await indexer.util.processCancellations(indexer.actions, indexer.indexerDb, lastIndexerBlock, blockTime);
            phases.cancellations = Number(process.hrtime.bigint() - t) / 1e6;

            // Phase: blockCreation
            t = process.hrtime.bigint();
            await indexer.indexerDb.createBlock(lastIndexerBlock, blockTime);
            phases.blockCreation = Number(process.hrtime.bigint() - t) / 1e6;

            // Phase: marketUpdates
            t = process.hrtime.bigint();
            await indexer.util.processMarketUpdates(indexer.indexerDb, lastIndexerBlock, blockTime);
            phases.marketUpdates = Number(process.hrtime.bigint() - t) / 1e6;

            // Phase: sanityCheck
            t = process.hrtime.bigint();
            await indexer.indexerDb.sanityCheck(lastIndexerBlock);
            phases.sanityCheck = Number(process.hrtime.bigint() - t) / 1e6;

            // Phase: commit
            t = process.hrtime.bigint();
            await indexer.indexerDb.commitTransaction();
            phases.commit = Number(process.hrtime.bigint() - t) / 1e6;

            collector.endBlock(lastIndexerBlock, phases);
            blocksProcessed++;

        } catch (error) {
            await indexer.indexerDb.rollbackTransaction();
            collector.recordError(lastIndexerBlock, error);
            throw error;
        }
    }

    indexer.synced = true;
    return { blocksProcessed };
}

module.exports = { processBlocksInstrumented };
