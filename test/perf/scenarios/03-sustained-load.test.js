'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
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

// Configurable via environment variables
const DURATION_MS      = parseInt(process.env.PERF_SUSTAINED_MS  || '60000');
const TXS_PER_BLOCK    = parseInt(process.env.PERF_SUSTAINED_TPS || '20');
const BLOCKS_PER_BATCH = 50;
const BASE_TIME        = 1700000000;

describe('03 Sustained Load', function () {
    this.timeout(0); // no timeout — duration controlled by PERF_SUSTAINED_MS

    const reporter = new ReportGenerator();

    before(async function () {
        await createDatabases();
        await createDecoderSchema();
    });

    after(async function () {
        await closeAll();
    });

    it(`processes blocks continuously for ${DURATION_MS}ms without degradation`, async function () {
        await resetDecoderDb();
        await resetIndexerDb();

        const gen = new DataGenerator(decoderQuery);
        const indexer = await initIndexer();
        const collector = new MetricsCollector({ name: 'sustained-load', warmupBlocks: 10 });
        collector.start();

        const endTime = Date.now() + DURATION_MS;
        let currentBlock = 1;
        let baseTime = BASE_TIME;

        // Bootstrap once
        const bootstrapEnd = await gen.bootstrap(currentBlock, baseTime);
        currentBlock = bootstrapEnd;
        baseTime += bootstrapEnd * 600;

        // Process bootstrap blocks
        await processBlocksInstrumented(indexer, collector);

        // Run in batches until time expires
        while (Date.now() < endTime) {
            await gen.generateBlocks(BLOCKS_PER_BATCH, TXS_PER_BLOCK, 'normal',
                currentBlock, baseTime);
            await processBlocksInstrumented(indexer, collector);
            currentBlock += BLOCKS_PER_BATCH;
            baseTime += BLOCKS_PER_BATCH * 600;
        }

        collector.stop();
        const stats = collector.getStats();
        reporter.generateAll(stats, '03-sustained-load');

        // Must have processed enough blocks for meaningful analysis
        const timings = stats._rawBlockTimings;
        assert.ok(timings.length >= 20, `Expected >= 20 measured blocks, got ${timings.length}`);
        assert.strictEqual(stats.errors.length, 0, 'No processing errors expected');

        // Degradation check: second-half p99 should not be >3x first-half p99
        if (timings.length >= 20) {
            const half = Math.floor(timings.length / 2);
            const firstHalf = [...timings.slice(0, half)].sort((a, b) => a - b);
            const secondHalf = [...timings.slice(half)].sort((a, b) => a - b);
            const p99First = firstHalf[Math.ceil(0.99 * firstHalf.length) - 1];
            const p99Second = secondHalf[Math.ceil(0.99 * secondHalf.length) - 1];
            assert.ok(p99Second < p99First * 3,
                `Degradation: second-half p99 (${p99Second.toFixed(1)}ms) > 3x first-half p99 (${p99First.toFixed(1)}ms)`);
        }

        await destroyIndexer(indexer);
    });
});
