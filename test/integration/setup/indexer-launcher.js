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
 * Indexer launcher for integration tests.
 *
 * Provides two modes:
 *   1. processBlocks() — processes all pending blocks synchronously, then returns
 *   2. startAndWaitForSync() — starts the full loop, waits for sync, then stops
 *
 * Both modes use the real XChainIndexer code against real MariaDB databases.
 */

const { getConnectionParams } = require('./db-connection');

// Ensure env is set before requiring indexer modules
process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
// Protocol activation gates on the running version (protocol_changes.js
// reads npm_package_version). npm sets it automatically; DIRECT mocha
// invocations do not — and a stale hardcoded default ('1.1.0') silently
// flipped such runs into the pre-UNIFIED_FEES legacy era, where fees are
// per-coin and newer actions (STAKE 2.0.0+) are "not yet activated".
// Default to the REAL package version so both invocations behave the same.
process.env.npm_package_version = process.env.npm_package_version
    || require('../../../package.json').version;
process.env.npm_package_name = process.env.npm_package_name || 'xchain-indexer';

const XChainIndexer = require('../../../src/XChainIndexer.js');

/**
 * Create a configured XChainIndexer instance pointing at the test databases.
 * Does NOT start it — call start() or use the helper methods below.
 *
 * @param {object} [opts]
 * @param {string} [opts.indexerName] - indexer DB name override (a second
 *   "node" for cross-node equivalence tests; the decoder DB is always shared).
 */
function createIndexer(opts = {}) {
    const p = getConnectionParams(opts.indexerName);
    return new XChainIndexer(
        p.decoderHost, p.decoderPort, p.decoderName, p.decoderUser, p.decoderPass,
        p.indexerHost, p.indexerPort, p.indexerName, p.indexerUser, p.indexerPass
    );
}

/**
 * Initialize an indexer (create DB connections, verify/create tables)
 * without entering the main processing loop.
 *
 * Returns the initialized indexer instance with all classes ready.
 * Accepts the same opts as createIndexer (indexerName override).
 */
async function initIndexer(opts = {}) {
    const indexer = createIndexer(opts);

    // Replicate the initialization portion of start() without the while(true) loop
    const config   = require('../../../src/config.js');
    const Database = require('../../../src/db.js');
    const Utility  = require('../../../src/utility.js');
    const ProtocolChanges = require('../../../src/protocol_changes.js');
    const Mapper   = require('../../../src/mapper.js');
    const Actions  = require('../../../src/actions.js');
    const Rollback = require('../../../src/rollback.js');

    indexer.config = config.getConfig();
    indexer.util = new Utility();

    const p = getConnectionParams(opts.indexerName);
    indexer.decoderDb = new Database(p.decoderHost, p.decoderPort, p.decoderName, p.decoderUser, p.decoderPass, indexer);
    indexer.indexerDb = new Database(p.indexerHost, p.indexerPort, p.indexerName, p.indexerUser, p.indexerPass, indexer);

    indexer.protocolChanges = new ProtocolChanges(indexer);
    indexer.mapper = new Mapper(indexer);
    indexer.actions = new Actions(indexer);
    indexer.rollback = new Rollback(indexer);

    // Create and verify databases and tables
    await indexer.indexerDb.createDatabase();
    await indexer.indexerDb.verifyTables();

    return indexer;
}

/**
 * Process all pending blocks from the decoder DB.
 *
 * This mimics the inner while-loop of XChainIndexer.start() but exits
 * once caught up instead of polling forever. Handles reorgs too.
 *
 * @param {XChainIndexer} indexer - An initialized indexer (from initIndexer)
 * @returns {number} Number of blocks processed
 */
async function processBlocks(indexer) {
    let blocksProcessed = 0;

    // Get reorg state — match the decoder's reorg event by IDENTITY (events.id),
    // not block-height magnitude, so consecutive higher-block reorgs are not missed.
    const decoderReorg         = await indexer.decoderDb.getLatestReorg();
    const lastProcessedReorgId = await indexer.indexerDb.getLastProcessedReorgId();

    // Get block positions
    let lastDecoderBlock = await indexer.decoderDb.getBlockIndex('decoder', 'last');
    let lastIndexerBlock = await indexer.indexerDb.getBlockIndex('indexer', 'last');

    // Handle reorgs: trigger if the decoder's latest reorg event is one the indexer
    // has not yet recorded (identity check, mirroring XChainIndexer.start()).
    if (decoderReorg !== null && decoderReorg.id !== lastProcessedReorgId) {
        await indexer.indexerDb.createReorg(decoderReorg.block_index, decoderReorg.id);
        if (lastIndexerBlock !== null && lastIndexerBlock >= decoderReorg.block_index) {
            await indexer.rollback.rollback(decoderReorg.block_index);
        }
        // Re-query after rollback
        lastIndexerBlock = await indexer.indexerDb.getBlockIndex('indexer', 'last');
    }

    // Initialize start position if indexer is empty
    if (lastIndexerBlock === null) {
        const firstDecoderBlock = await indexer.decoderDb.getBlockIndex('decoder', 'first');
        if (firstDecoderBlock !== null) {
            lastIndexerBlock = firstDecoderBlock - 1;
        }
    }

    // Process all pending blocks
    while (lastIndexerBlock !== null && lastDecoderBlock !== null &&
           lastIndexerBlock < lastDecoderBlock) {
        lastIndexerBlock++;

        const blockTransactions = await indexer.decoderDb.getDecoderBlockData(lastIndexerBlock);
        const blockTime = await indexer.decoderDb.getBlockTime(lastIndexerBlock);

        await indexer.indexerDb.beginTransaction();
        try {
            for (const tx of blockTransactions) {
                await indexer.actions.processTransaction(tx);
            }

            await indexer.util.processExpirations(indexer.actions, indexer.indexerDb, lastIndexerBlock, blockTime);
            await indexer.util.processCancellations(indexer.actions, indexer.indexerDb, lastIndexerBlock, blockTime);
            await indexer.indexerDb.createBlock(lastIndexerBlock, blockTime);
            await indexer.util.processMarketUpdates(indexer.indexerDb, lastIndexerBlock, blockTime);
            await indexer.indexerDb.sanityCheck(lastIndexerBlock);

            await indexer.indexerDb.commitTransaction();
            blocksProcessed++;
        } catch (error) {
            await indexer.indexerDb.rollbackTransaction();
            throw error; // In tests, let errors propagate
        }
    }

    indexer.synced = true;
    return blocksProcessed;
}

/**
 * Clean up an indexer's database connections.
 */
async function destroyIndexer(indexer) {
    if (!indexer) return;
    try {
        if (indexer.decoderDb && indexer.decoderDb.pool) await indexer.decoderDb.pool.end();
    } catch (e) { /* ignore */ }
    try {
        if (indexer.indexerDb && indexer.indexerDb.pool) await indexer.indexerDb.pool.end();
    } catch (e) { /* ignore */ }
}

module.exports = { createIndexer, initIndexer, processBlocks, destroyIndexer };
