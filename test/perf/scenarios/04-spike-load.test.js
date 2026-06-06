'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');
const { decoderQuery, createDatabases, createDecoderSchema,
        resetDecoderDb, resetIndexerDb, closeAll } = require('../../integration/setup/db-connection');
const { initIndexer, destroyIndexer } = require('../../integration/setup/indexer-launcher');
const DataGenerator = require('../setup/data-generator');
const MetricsCollector = require('../setup/metrics-collector');
const { processBlocksInstrumented } = require('../setup/instrumented-processor');
const ReportGenerator = require('../setup/report-generator');

const BASE_TIME = 1700000000;

describe('04 Spike Load', function () {
    this.timeout(300000);

    const reporter = new ReportGenerator();

    before(async function () {
        await createDatabases();
        await createDecoderSchema();
    });

    after(async function () {
        await closeAll();
    });

    it('handles spike from 1 tx/block to 100 tx/block without errors', async function () {
        await resetDecoderDb();
        await resetIndexerDb();

        const gen = new DataGenerator(decoderQuery);
        const indexer = await initIndexer();
        const collector = new MetricsCollector({ name: 'spike-load', warmupBlocks: 2 });
        collector.start();

        const bootstrapEnd = await gen.bootstrap(1, BASE_TIME);
        let nextBlock = bootstrapEnd;
        let baseTime = BASE_TIME + bootstrapEnd * 600;

        // Process bootstrap
        await processBlocksInstrumented(indexer, collector);

        // Phase 1: Quiet — 20 blocks at 1 tx/block
        await gen.generateBlocks(20, 1, 'send-only', nextBlock, baseTime);
        nextBlock += 20; baseTime += 20 * 600;
        await processBlocksInstrumented(indexer, collector);

        // Phase 2: Spike — 20 blocks at 100 tx/block
        await gen.generateBlocks(20, 100, 'mixed-heavy', nextBlock, baseTime);
        nextBlock += 20; baseTime += 20 * 600;
        await processBlocksInstrumented(indexer, collector);

        // Phase 3: Return to quiet — 20 blocks at 1 tx/block
        await gen.generateBlocks(20, 1, 'send-only', nextBlock, baseTime);
        await processBlocksInstrumented(indexer, collector);

        collector.stop();
        const stats = collector.getStats();
        reporter.generateAll(stats, '04-spike-load');

        assert.strictEqual(stats.errors.length, 0, 'No errors during spike');
        await destroyIndexer(indexer);
    });

    it('handles repeated micro-spikes (bursty traffic)', async function () {
        await resetDecoderDb();
        await resetIndexerDb();

        const gen = new DataGenerator(decoderQuery);
        const indexer = await initIndexer();
        const collector = new MetricsCollector({ name: 'micro-spikes', warmupBlocks: 2 });
        collector.start();

        const bootstrapEnd = await gen.bootstrap(1, BASE_TIME);
        let nextBlock = bootstrapEnd;
        let baseTime = BASE_TIME + bootstrapEnd * 600;

        // Process bootstrap
        await processBlocksInstrumented(indexer, collector);

        // 5 burst cycles: quiet (5 blocks at 2 tx) → burst (5 blocks at 50 tx)
        for (let cycle = 0; cycle < 5; cycle++) {
            await gen.generateBlocks(5, 2, 'send-only', nextBlock, baseTime);
            nextBlock += 5; baseTime += 5 * 600;
            await gen.generateBlocks(5, 50, 'normal', nextBlock, baseTime);
            nextBlock += 5; baseTime += 5 * 600;
            await processBlocksInstrumented(indexer, collector);
        }

        collector.stop();
        const stats = collector.getStats();
        reporter.generateAll(stats, '04-micro-spikes');

        assert.strictEqual(stats.errors.length, 0, 'No errors during micro-spikes');
        await destroyIndexer(indexer);
    });
});
