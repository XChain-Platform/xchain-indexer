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
const MEASUREMENT_BLOCKS = 20;

describe('05 Scaling Tests', function () {
    this.timeout(600000);

    const reporter = new ReportGenerator();
    const allStats = {};

    before(async function () {
        await createDatabases();
        await createDecoderSchema();
    });

    after(async function () {
        if (Object.keys(allStats).length > 0) {
            reporter.writeJson({ allStats }, '05-scaling-combined');
        }
        await closeAll();
    });

    async function runScalingPoint(tokenCount, label) {
        await resetDecoderDb();
        await resetIndexerDb();

        const gen = new DataGenerator(decoderQuery);
        const indexer = await initIndexer();
        const collector = new MetricsCollector({ name: label, warmupBlocks: 2 });
        collector.start();

        // Bootstrap gas token + base tokens
        let nextBlock = 1;
        let baseTime = BASE_TIME;
        const bootstrapEnd = await gen.bootstrap(nextBlock, baseTime);
        nextBlock = bootstrapEnd;
        baseTime += bootstrapEnd * 600;

        // Process bootstrap blocks
        await processBlocksInstrumented(indexer, collector);

        // Issue and mint {tokenCount} unique tokens
        const addrs = gen.state.addresses;
        for (let i = 0; i < tokenCount; i++) {
            const tick = 'S' + String(i).padStart(5, '0');
            await gen.seedBlock(nextBlock++, baseTime, [
                { source: addrs[i % addrs.length], data: `ISSUE|0|${tick}|1000000|10000|0` }
            ]);
            baseTime += 600;
            await gen.seedBlock(nextBlock++, baseTime, [
                { source: addrs[i % addrs.length], data: `MINT|0|${tick}|1000` }
            ]);
            baseTime += 600;
        }

        // Process all token setup blocks
        await processBlocksInstrumented(indexer, collector);

        // Now run measurement blocks with activity across tokens
        await gen.generateBlocks(MEASUREMENT_BLOCKS, 10, 'send-only', nextBlock, baseTime);
        await processBlocksInstrumented(indexer, collector);

        collector.stop();
        const stats = collector.getStats();
        reporter.generateAll(stats, `05-${label}`);
        allStats[label] = {
            tokenCount,
            sanityCheckAvg: stats.phaseTiming.sanityCheck.avg,
            sanityCheckP95: stats.phaseTiming.sanityCheck.p95,
            marketUpdatesAvg: stats.phaseTiming.marketUpdates.avg,
            marketUpdatesP95: stats.phaseTiming.marketUpdates.p95,
            blockTimingAvg: stats.blockTiming.avg,
        };
        await destroyIndexer(indexer);
        return stats;
    }

    it('10 tokens', async function () {
        const stats = await runScalingPoint(10, '10-tokens');
        assert.strictEqual(stats.errors.length, 0);
    });

    it('50 tokens', async function () {
        const stats = await runScalingPoint(50, '50-tokens');
        assert.strictEqual(stats.errors.length, 0);
    });

    it('100 tokens', async function () {
        const stats = await runScalingPoint(100, '100-tokens');
        assert.strictEqual(stats.errors.length, 0);
    });

    it('200 tokens', async function () {
        const stats = await runScalingPoint(200, '200-tokens');
        assert.strictEqual(stats.errors.length, 0);
    });
});
