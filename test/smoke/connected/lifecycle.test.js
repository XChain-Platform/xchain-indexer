/**
 * Smoke tests: Indexer lifecycle (SM-14, SM-15)
 *
 * Creates a real XChainIndexer instance connected to the live databases,
 * exercises the start/stop lifecycle, and verifies the synced flag.
 *
 * Requires running MariaDB instances with decoder and indexer databases
 * already created and populated (or empty — empty is fine).
 *
 * SM-14: stop() causes start() to resolve cleanly
 * SM-15: isSynced() becomes true when the indexer is caught up
 *
 * Notes:
 *   - start() runs an infinite while(true) loop; we fire it without await,
 *     then call stop() to break the loop, then await the promise.
 *   - The loop sleeps 5000ms (BLOCK_CHECK_INTERVAL) between iterations, so
 *     we wait 3 s for initialization + first iteration before asserting sync.
 *   - XChainIndexer has no destroy() method; after stop() we manually close
 *     the MariaDB pools (decoderDb.pool / indexerDb.pool) so Mocha can exit.
 */

'use strict';

// Load .env BEFORE setting test env vars
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

// npm_package_* vars are normally injected by `npm run`; set defaults so the
// indexer constructor doesn't log "undefined v undefined".
process.env.npm_package_version = process.env.npm_package_version || '0.0.0-smoke';
process.env.npm_package_name    = process.env.npm_package_name    || 'xchain-indexer';

const assert       = require('assert');
const XChainIndexer = require('../../../src/XChainIndexer.js');

// ---------------------------------------------------------------------------
// Helper: build a fresh indexer from env credentials
// ---------------------------------------------------------------------------
function buildIndexer() {
    return new XChainIndexer(
        process.env.DECODER_DB_HOST, process.env.DECODER_DB_PORT, process.env.DECODER_DB_NAME,
        process.env.DECODER_DB_USER, process.env.DECODER_DB_PASS,
        process.env.INDEXER_DB_HOST, process.env.INDEXER_DB_PORT, process.env.INDEXER_DB_NAME,
        process.env.INDEXER_DB_USER, process.env.INDEXER_DB_PASS
    );
}

// ---------------------------------------------------------------------------
// Helper: close the DB pools that start() opens inside the indexer
// ---------------------------------------------------------------------------
async function closeIndexerPools(indexer) {
    try {
        if (indexer.decoderDb && indexer.decoderDb.pool) await indexer.decoderDb.pool.end();
    } catch (_) { /* ignore — pool may already be closed */ }
    try {
        if (indexer.indexerDb && indexer.indexerDb.pool) await indexer.indexerDb.pool.end();
    } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Helper: wait up to `maxMs` for predicate() to return true, checking every
// `intervalMs`. Returns true if the predicate fired, false if it timed out.
// ---------------------------------------------------------------------------
async function waitFor(predicate, maxMs, intervalMs) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return predicate(); // one final check
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('Smoke: indexer lifecycle @regression @tier3', function () {

    // -------------------------------------------------------------------------
    // SM-14: stop() causes start() to resolve cleanly
    // -------------------------------------------------------------------------
    it('SM-14: stop() causes start() to resolve without rejecting', async function () {
        this.timeout(15000);

        const indexer = buildIndexer();

        // Fire the loop without awaiting — it runs until stopFlag is set
        const startPromise = indexer.start();

        // Allow time for DB init and the first loop iteration to complete
        await new Promise(r => setTimeout(r, 3000));

        // Signal the loop to exit on its next iteration
        indexer.stop();

        // start() should resolve (not reject) after the loop exits
        await startPromise;

        // Pools are still open; close them so Mocha can exit
        await closeIndexerPools(indexer);
    });

    // -------------------------------------------------------------------------
    // SM-15: isSynced() becomes true when caught up
    // -------------------------------------------------------------------------
    it('SM-15: isSynced() returns true once the indexer has caught up', async function () {
        this.timeout(15000);

        const indexer = buildIndexer();

        // Start the loop in the background
        const startPromise = indexer.start();

        // Poll for synced state — should happen quickly when decoder DB is empty
        // or already fully indexed. Give up to 10 s before asserting.
        const becameSynced = await waitFor(() => indexer.isSynced(), 10000, 200);

        assert.strictEqual(becameSynced, true,
            'Indexer did not reach synced state within 10 s. ' +
            'This can happen if the decoder DB has many un-indexed blocks or ' +
            'if the DB connection failed.');

        // Clean up: stop the loop and close pools
        indexer.stop();
        await startPromise;
        await closeIndexerPools(indexer);
    });
});
