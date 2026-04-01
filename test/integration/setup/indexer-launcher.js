/**
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
process.env.INDEXER_COIN = process.env.INDEXER_COIN || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
process.env.npm_package_version = process.env.npm_package_version || '1.1.0';
process.env.npm_package_name = process.env.npm_package_name || 'xchain-indexer';

const XChainIndexer = require('../../../src/XChainIndexer.js');

/**
 * Create a configured XChainIndexer instance pointing at the test databases.
 * Does NOT start it — call start() or use the helper methods below.
 */
function createIndexer() {
    const p = getConnectionParams();
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
 */
async function initIndexer() {
    const indexer = createIndexer();

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

    const p = getConnectionParams();
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

    // Get reorg state
    const lastDecoderReorgBlock = await indexer.decoderDb.getBlockIndex('decoder', 'reorg');
    const lastIndexerReorgBlock = await indexer.indexerDb.getBlockIndex('indexer', 'reorg');

    // Get block positions
    let lastDecoderBlock = await indexer.decoderDb.getBlockIndex('decoder', 'last');
    let lastIndexerBlock = await indexer.indexerDb.getBlockIndex('indexer', 'last');

    // Handle reorgs: trigger if decoder has a new reorg event not yet reflected in indexer
    if (lastDecoderReorgBlock !== null &&
        (lastIndexerReorgBlock === null || lastDecoderReorgBlock !== lastIndexerReorgBlock)) {
        await indexer.indexerDb.createReorg(lastDecoderReorgBlock);
        if (lastIndexerBlock !== null && lastIndexerBlock >= lastDecoderReorgBlock) {
            await indexer.rollback.rollback(lastDecoderReorgBlock);
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
