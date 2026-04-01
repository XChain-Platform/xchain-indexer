'use strict';

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

const BLOCK_COUNT = 50;
const TXS_PER_BLOCK = 20;
const BASE_TIME = 1700000000;

describe('02 Action Benchmarks', function () {
    this.timeout(600000);

    const reporter = new ReportGenerator();
    const allStats = {};

    before(async function () {
        await createDatabases();
        await createDecoderSchema();
    });

    after(async function () {
        // Write combined comparison report
        if (Object.keys(allStats).length > 0) {
            reporter.writeJson({ allStats }, '02-action-benchmarks-combined');
        }
        await closeAll();
    });

    async function benchmarkProfile(label, profile) {
        await resetDecoderDb();
        await resetIndexerDb();
        const gen = new DataGenerator(decoderQuery);
        const indexer = await initIndexer();

        const bootstrapEnd = await gen.bootstrap(1, BASE_TIME);
        await gen.generateBlocks(BLOCK_COUNT, TXS_PER_BLOCK, profile,
            bootstrapEnd, BASE_TIME + bootstrapEnd * 600);

        const collector = new MetricsCollector({ name: label, warmupBlocks: 3 });
        collector.start();
        const { blocksProcessed } = await processBlocksInstrumented(indexer, collector);
        collector.stop();
        const stats = collector.getStats();
        reporter.generateAll(stats, `02-${label}`);
        allStats[label] = { ...stats, _rawBlockTimings: undefined };
        await destroyIndexer(indexer);
        return stats;
    }

    it('SEND-only blocks', async function () {
        const stats = await benchmarkProfile('send-only', 'send-only');
        assert.strictEqual(stats.errors.length, 0);
    });

    it('token-launch (ISSUE + MINT)', async function () {
        const stats = await benchmarkProfile('token-launch', 'token-launch');
        assert.strictEqual(stats.errors.length, 0);
    });

    it('heavy-dex (ORDER creates)', async function () {
        const stats = await benchmarkProfile('heavy-dex', 'heavy-dex');
        assert.strictEqual(stats.errors.length, 0);
    });

    it('mixed-heavy (all action types)', async function () {
        const stats = await benchmarkProfile('mixed-heavy', 'mixed-heavy');
        assert.strictEqual(stats.errors.length, 0);
    });
});
