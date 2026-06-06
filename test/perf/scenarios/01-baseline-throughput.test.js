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

const BLOCK_COUNT = 100;
const BASE_TIME = 1700000000;

describe('01 Baseline Throughput', function () {
    this.timeout(300000);

    const reporter = new ReportGenerator();

    before(async function () {
        await createDatabases();
        await createDecoderSchema();
    });

    after(async function () {
        await closeAll();
    });

    async function runScenario(label, txsPerBlock, profile) {
        await resetDecoderDb();
        await resetIndexerDb();
        const gen = new DataGenerator(decoderQuery);
        const indexer = await initIndexer();

        const bootstrapEnd = await gen.bootstrap(1, BASE_TIME);
        if (txsPerBlock > 0) {
            await gen.generateBlocks(BLOCK_COUNT, txsPerBlock, profile,
                bootstrapEnd, BASE_TIME + bootstrapEnd * 600);
        } else {
            // Seed empty blocks
            for (let i = 0; i < BLOCK_COUNT; i++) {
                await gen.seedBlock(bootstrapEnd + i, BASE_TIME + (bootstrapEnd + i) * 600, []);
            }
        }

        const collector = new MetricsCollector({ name: label, warmupBlocks: 5 });
        collector.start();
        const { blocksProcessed } = await processBlocksInstrumented(indexer, collector);
        collector.stop();
        const stats = collector.getStats();
        reporter.generateAll(stats, `01-${label}`);
        await destroyIndexer(indexer);
        return stats;
    }

    it('empty blocks (0 txs/block)', async function () {
        const stats = await runScenario('empty', 0, 'send-only');
        assert.ok(stats.throughput.blocksPerSecond > 0, 'Should process blocks');
        assert.strictEqual(stats.errors.length, 0, 'No errors expected');
    });

    it('light blocks (1 tx/block, SEND only)', async function () {
        const stats = await runScenario('light-send', 1, 'send-only');
        assert.ok(stats.throughput.blocksPerSecond > 0, 'Should process blocks');
        assert.strictEqual(stats.errors.length, 0, 'No errors expected');
    });

    it('normal blocks (10 txs/block, mixed)', async function () {
        const stats = await runScenario('normal-10tx', 10, 'normal');
        assert.ok(stats.throughput.blocksPerSecond > 0, 'Should process blocks');
        assert.strictEqual(stats.errors.length, 0, 'No errors expected');
    });

    it('heavy blocks (50 txs/block, mixed-heavy)', async function () {
        const stats = await runScenario('heavy-50tx', 50, 'mixed-heavy');
        assert.ok(stats.throughput.blocksPerSecond > 0, 'Should process blocks');
        assert.strictEqual(stats.errors.length, 0, 'No errors expected');
    });
});
