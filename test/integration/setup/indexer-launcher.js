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
 * Indexer launcher for integration tests.
 *
 * Provides two modes:
 *   1. processBlocks(): processes all pending blocks synchronously, then returns
 *   2. startAndWaitForSync(): starts the full loop, waits for sync, then stops
 *
 * Both modes use the real XChainIndexer code against real MariaDB databases.
 */

const { getConnectionParams, activeFileKey, fileKey } = require('./db-connection');

// Instances handed out by initIndexer() and not yet destroyed, each against the
// test file whose schemas were active when it was made. Ownership matters:
// 07-expiry-ordering and 27-expiry-pushdown build their indexer in a ROOT hook,
// which mocha runs before any suite, so those instances are live for the whole
// tier and must survive every other file's teardown. See destroyFileIndexers().
const liveIndexers = new Map();

// Ensure env is set before requiring indexer modules
process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
// Protocol activation gates on the running version (protocol_changes.js
// reads npm_package_version). npm sets it automatically; DIRECT mocha
// invocations do not; a stale hardcoded default ('1.1.0') silently
// flipped such runs into the pre-UNIFIED_FEES legacy era, where fees are
// per-coin and newer actions (STAKE 2.0.0+) are "not yet activated".
// Default to the REAL package version so both invocations behave the same.
process.env.npm_package_version = process.env.npm_package_version
    || require('../../../package.json').version;
process.env.npm_package_name = process.env.npm_package_name || 'xchain-indexer';

const XChainIndexer = require('../../../src/XChainIndexer.js');
// Same module the production block loop uses, so the harness cannot drift from
// the collapse rule it is meant to model (see processBlocks below).
const { collapseOutputFanout } = require('../../../src/output_fanout.js');

/**
 * Create a configured XChainIndexer instance pointing at the test databases.
 * Does NOT start it. Call start() or use the helper methods below.
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
    const Genesis  = require('../../../src/genesis.js');

    indexer.config = config.getConfig();
    // Share the ONE config snapshot exactly like XChainIndexer.start() does: a bare
    // new Utility() self-loads a second snapshot, and tests that mutate the live
    // config (multi-chain.js forceXchainFeeMode) would silently miss the util copy.
    indexer.util = new Utility(indexer.config);

    const p = getConnectionParams(opts.indexerName);
    indexer.decoderDb = new Database(p.decoderHost, p.decoderPort, p.decoderName, p.decoderUser, p.decoderPass, indexer);
    indexer.indexerDb = new Database(p.indexerHost, p.indexerPort, p.indexerName, p.indexerUser, p.indexerPass, indexer);

    indexer.protocolChanges = new ProtocolChanges(indexer);
    indexer.mapper = new Mapper(indexer);
    indexer.actions = new Actions(indexer);
    indexer.rollback = new Rollback(indexer);
    indexer.genesis = new Genesis(indexer.actions, indexer.indexerDb, indexer.config, indexer.util);

    // Create and verify databases and tables
    liveIndexers.set(indexer, activeFileKey());
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

    // Get reorg state: process EVERY decoder reorg the indexer has not yet recorded
    // (not just the newest), matched by event IDENTITY (events.id) not block-height
    // magnitude, so consecutive higher-block reorgs are not missed. Mirrors the live
    // loop in XChainIndexer.start().
    const lastProcessedReorgId = await indexer.indexerDb.getLastProcessedReorgId();
    const unprocessedReorgs    = await indexer.decoderDb.getReorgsSince(lastProcessedReorgId);

    // Get block positions
    let lastDecoderBlock = await indexer.decoderDb.getBlockIndex('decoder', 'last');
    let lastIndexerBlock = await indexer.indexerDb.getBlockIndex('indexer', 'last');

    // Handle reorgs: roll back once to the DEEPEST (minimum) block across every
    // unprocessed reorg, then record each event in id order so the processed-id
    // cursor advances to the newest decoder event. Record markers only after any
    // rollback commits (mirroring XChainIndexer.start()).
    if (unprocessedReorgs.length > 0) {
        let minReorgBlock = null;
        for (const reorg of unprocessedReorgs) {
            if (minReorgBlock === null || reorg.block_index < minReorgBlock)
                minReorgBlock = reorg.block_index;
        }
        if (lastIndexerBlock !== null && lastIndexerBlock >= minReorgBlock) {
            await indexer.rollback.rollback(minReorgBlock);
            // Re-query after rollback (lastIndexerBlock was read before it).
            lastIndexerBlock = await indexer.indexerDb.getBlockIndex('indexer', 'last');
        }
        for (const reorg of unprocessedReorgs)
            await indexer.indexerDb.createReorg(reorg.block_index, reorg.id);
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

        let blockTransactions = await indexer.decoderDb.getDecoderBlockData(lastIndexerBlock);
        // Mirror production (XChainIndexer.start, the collapseOutputFanout call beside
        // getDecoderBlockData): getDecoderBlockData emits ONE row per stored native-coin
        // output, so without this collapse a data-bearing non-COINPAY transaction paying
        // more than one address is executed once PER OUTPUT here while the fleet executes
        // it once. A harness that disagrees with production about how many times a
        // transaction runs can certify a doubled ledger effect as correct. The gate is
        // read per block from the same ProtocolChanges the block is parsed under, not
        // hardcoded, so a scenario that moves the flag-day gets production's behaviour on
        // both sides of it (regtest activates at genesis, so the collapse is in force).
        const fanoutFixActive = await indexer.protocolChanges.isEnabled('FIX_OUTPUT_FANOUT', lastIndexerBlock);
        blockTransactions = collapseOutputFanout(blockTransactions, fanoutFixActive, (m) => indexer.util.logError(m));
        const blockTime = await indexer.decoderDb.getBlockTime(lastIndexerBlock);

        await indexer.indexerDb.beginTransaction();
        // Mirror production (XChainIndexer sets indexerDb.blockIndex before parsing a
        // block): createAddress/createTicker default block_index to this.blockIndex,
        // so without this the harness stamps block_index=NULL and the reorg rollback
        // (DELETE WHERE block_index >= ?) matches nothing, blinding the 05-reorg suite
        // to the F-1/F-2 index-id bug class.
        indexer.indexerDb.blockIndex = lastIndexerBlock;
        try {
            // Mirror production (XChainIndexer.js, first statement inside the block's
            // transaction): install a fresh per-block VM compilation cache. Without it
            // vm._blockCache stays null for the whole harness run, so every VM-touching
            // scenario executes contracts on a cache rhythm the fleet never runs: cold
            // compile per execute instead of compile-once-per-block. That hides both the
            // cache's own bugs (a stale entry surviving into the next block) and any
            // consensus-visible difference between a cached and an uncached execute.
            if (indexer.actions.vm)
                indexer.actions.vm.beginBlock();

            // Mirror production: genesis ledger bootstrap runs before the block's real
            // transactions at the configured genesis block (no-op otherwise). See genesis.js.
            if (indexer.genesis && Number(lastIndexerBlock) === Number(indexer.config['GENESIS_BLOCK']))
                await indexer.genesis.inject(lastIndexerBlock, blockTime);
            for (const tx of blockTransactions) {
                await indexer.actions.processTransaction(tx);
            }

            await indexer.util.processExpirations(indexer.actions, indexer.indexerDb, lastIndexerBlock, blockTime);
            // Mirror production (XChainIndexer.start): settle this chain's leg of any
            // effective validator-signed cross-chain match. No-op for scenarios without
            // cross_chain_matches rows; scenario 26 injects signed matches directly.
            await indexer.util.processCrossChainSettlements(indexer.actions, indexer.indexerDb, lastIndexerBlock, blockTime);
            await indexer.util.processCancellations(indexer.actions, indexer.indexerDb, lastIndexerBlock, blockTime);
            // Mirror production: clear the per-block VM compilation cache after the last
            // pass that can execute contract code and BEFORE createBlock, so nothing
            // compiled this block can be reused by the next one. A block that throws
            // skips this exactly as production does; the next block's beginBlock installs
            // a fresh cache either way.
            if (indexer.actions.vm)
                indexer.actions.vm.endBlock();
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
    liveIndexers.delete(indexer);
    try {
        if (indexer.decoderDb && indexer.decoderDb.pool) await indexer.decoderDb.pool.end();
    } catch (e) { /* ignore */ }
    try {
        if (indexer.indexerDb && indexer.indexerDb.pool) await indexer.indexerDb.pool.end();
    } catch (e) { /* ignore */ }
}

/**
 * Destroy every instance this test file made and did not destroy. Pass
 * __filename, and call it from the file's after hook.
 *
 * Scenarios init and destroy in sequence rather than try/finally, so a test
 * that throws or times out between the two leaves the instance and its pool
 * live. Sweeping at the end of the file makes teardown complete no matter which
 * test failed, so no connection pool and no in-flight schema work is still
 * holding the file's schemas when the next file starts.
 */
async function destroyFileIndexers(testFile) {
    const owner = fileKey(testFile);
    for (const [indexer, key] of Array.from(liveIndexers))
        if (key === owner) await destroyIndexer(indexer);
}

module.exports = { createIndexer, initIndexer, processBlocks, destroyIndexer, destroyFileIndexers };
