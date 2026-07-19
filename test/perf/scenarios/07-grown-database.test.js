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

// The other scaling/throughput scenarios each reset the DB between measurement
// points, so every sample runs against a young, nearly-empty database. That
// blinds them to the dominant scale risk in this codebase: the per-block sweeps
// (processExpirations -> getExpiredItems, cross-chain settlement, cooldown
// completion) re-scan a growth-unbounded standing set on EVERY block, so their
// cost rises with accumulated history rather than with the current block's work.
// See claude/reports/review/2026-06-24-scale-perf/2026-06-24-deep-review.md (P1-P6).
//
// This scenario deliberately does NOT reset. It measures block-time on a young
// database, GROWS the standing set (thousands of still-open DEX orders that the
// expiry sweep must scan every block), measures again on the grown database, and
// asserts a block-time regression metric: the grown-window median block time must
// stay within MAX_RATIO of the young-window median. Current code is O(accumulated)
// on these paths, so the ceiling is set generously (it passes today at this scale);
// its job is to fail loudly when a change makes the per-block cost grow far faster
// than data -- an accidental N+1, a dropped composite index, a filesort added to
// the hot loop -- which the reset-per-point scenarios cannot see.

const BASE_TIME     = 1700000000;
// Measurement window (blocks sampled young, then again grown). Warmup blocks are
// discarded from each window to drop cold-cache / JIT outliers.
const MEASURE_BLOCKS = parseInt(process.env.PERF_GROWN_MEASURE_BLOCKS || '25');
const WARMUP_BLOCKS  = parseInt(process.env.PERF_GROWN_WARMUP_BLOCKS  || '5');
// Growth phase: how many blocks of standing orders to pile up between windows.
const GROW_BLOCKS    = parseInt(process.env.PERF_GROWN_GROW_BLOCKS    || '175');
// Open orders created per block (never matched -> they stay open and accumulate).
const ORDERS_PER_BLOCK = parseInt(process.env.PERF_GROWN_ORDERS_PER_BLOCK || '20');
// Primary regression ceiling: grown / young median TOTAL block time. Generous by
// design (see header): current code is O(accumulated) on several per-block paths
// (expiry sweep P1, per-ticker supply SUM P5), so total block time genuinely rises
// with the standing set. Observed ~1.5x at this scale; the ceiling exists to catch
// a gross regression (an added N+1, a dropped composite index), not to assert the
// paths are already O(1). Override to tighten once those sweeps are indexed.
const MAX_RATIO      = parseFloat(process.env.PERF_GROWN_MAX_RATIO || '6');
// Secondary ceiling on the expiry-sweep phase alone (db.getExpiredItems). This is
// the sharpest single signal -- it scans the whole open order/swap/dispenser set
// every block -- so it grows faster in ratio than the diluted total. Observed ~4-5x
// at this scale (its small ms baseline makes the ratio noisier than the total);
// ceiling generous so it is a real guard without being flaky, yet a reintroduced
// N+1 (20x+) still trips it.
const MAX_EXPIRY_RATIO = parseFloat(process.env.PERF_GROWN_MAX_EXPIRY_RATIO || '12');

// A ratio is only meaningful when the young-window baseline is above the runner's
// timing noise. On a very fast, idle machine a window can land in sub-millisecond
// jitter where any ratio is noise, not signal; below the floor the corresponding
// ratio gate is skipped. The total-block floor is higher than the phase floor
// because total block time is many ms even on fast hardware.
const MIN_TOTAL_MS   = parseFloat(process.env.PERF_GROWN_MIN_TOTAL_MS  || '2');
const MIN_EXPIRY_MS  = parseFloat(process.env.PERF_GROWN_MIN_EXPIRY_MS || '1');
// Absolute fallback ceiling on grown-window median (ms), applied ONLY when the young
// baseline was below MIN_TOTAL_MS (too fast for the ratio to mean anything). Very
// generous so it trips only on a catastrophic per-block hang, never on a slow runner.
const MAX_GROWN_MS   = parseFloat(process.env.PERF_GROWN_MAX_GROWN_MS || '15000');

describe('07 Grown-Database Regression', function () {
    this.timeout(0); // controlled by block counts, not a wall-clock deadline

    const reporter = new ReportGenerator();

    before(async function () {
        await createDatabases();
        await createDecoderSchema();
    });

    after(async function () {
        await closeAll();
    });

    it('block time does not regress beyond MAX_RATIO as the standing set grows', async function () {
        // ONE database, ONE indexer, no reset between phases: the whole point is an
        // aged database whose standing set accumulates across every block.
        await resetDecoderDb();
        await resetIndexerDb();

        const gen = new DataGenerator(decoderQuery);
        const indexer = await initIndexer();

        let nextBlock = 1;
        let baseTime  = BASE_TIME;

        try {
            // --- Bootstrap gas + base tokens (not measured) ---
            const bootstrapEnd = await gen.bootstrap(nextBlock, baseTime);
            nextBlock = bootstrapEnd;
            baseTime += bootstrapEnd * 600;

            const bootstrapCollector = new MetricsCollector({ name: 'grown-bootstrap' });
            bootstrapCollector.start();
            await processBlocksInstrumented(indexer, bootstrapCollector);
            bootstrapCollector.stop();

            // --- Window A: measure on the YOUNG database ---
            await gen.generateBlocks(MEASURE_BLOCKS, ORDERS_PER_BLOCK, 'standing-orders', nextBlock, baseTime);
            nextBlock += MEASURE_BLOCKS;
            baseTime  += MEASURE_BLOCKS * 600;

            const youngCollector = new MetricsCollector({ name: 'grown-young', warmupBlocks: WARMUP_BLOCKS });
            youngCollector.start();
            await processBlocksInstrumented(indexer, youngCollector);
            youngCollector.stop();
            const youngStats = youngCollector.getStats();

            // --- Grow phase: pile up a large standing set (not measured) ---
            // Each block adds ORDERS_PER_BLOCK still-open orders that the expiry sweep
            // re-scans forever; after this the getExpiredItems working set is much larger.
            for (let seeded = 0; seeded < GROW_BLOCKS; ) {
                const batch = Math.min(50, GROW_BLOCKS - seeded);
                await gen.generateBlocks(batch, ORDERS_PER_BLOCK, 'standing-orders', nextBlock, baseTime);
                nextBlock += batch;
                baseTime  += batch * 600;
                const growCollector = new MetricsCollector({ name: 'grown-grow' });
                growCollector.start();
                await processBlocksInstrumented(indexer, growCollector);
                growCollector.stop();
                seeded += batch;
            }

            // --- Window B: measure again on the GROWN database ---
            await gen.generateBlocks(MEASURE_BLOCKS, ORDERS_PER_BLOCK, 'standing-orders', nextBlock, baseTime);
            nextBlock += MEASURE_BLOCKS;
            baseTime  += MEASURE_BLOCKS * 600;

            const grownCollector = new MetricsCollector({ name: 'grown-grown', warmupBlocks: WARMUP_BLOCKS });
            grownCollector.start();
            await processBlocksInstrumented(indexer, grownCollector);
            grownCollector.stop();
            const grownStats = grownCollector.getStats();

            // --- Block-time regression metric ---
            const youngMedian = youngStats.blockTiming.p50;
            const grownMedian = grownStats.blockTiming.p50;
            const youngExpiry = youngStats.phaseTiming.expirations.p50;
            const grownExpiry = grownStats.phaseTiming.expirations.p50;
            const blockRatio  = youngMedian > 0 ? +(grownMedian / youngMedian).toFixed(3) : null;
            const expiryRatio = youngExpiry > 0 ? +(grownExpiry / youngExpiry).toFixed(3) : null;

            const metric = {
                measureBlocks: MEASURE_BLOCKS,
                warmupBlocks: WARMUP_BLOCKS,
                growBlocks: GROW_BLOCKS,
                ordersPerBlock: ORDERS_PER_BLOCK,
                youngMeasuredBlocks: youngStats.measuredBlocks,
                grownMeasuredBlocks: grownStats.measuredBlocks,
                youngMedianMs: youngMedian,
                grownMedianMs: grownMedian,
                blockTimeRegressionRatio: blockRatio,
                youngExpiryMedianMs: youngExpiry,
                grownExpiryMedianMs: grownExpiry,
                expirySweepRegressionRatio: expiryRatio,
                maxRatio: MAX_RATIO,
                maxExpiryRatio: MAX_EXPIRY_RATIO,
                youngErrors: youngStats.errors.length,
                grownErrors: grownStats.errors.length,
            };

            console.log('');
            console.log('='.repeat(70));
            console.log(' Grown-Database Block-Time Regression Metric');
            console.log('='.repeat(70));
            console.log(` grow phase        : +${GROW_BLOCKS} blocks x ${ORDERS_PER_BLOCK} open orders`);
            console.log(` young median      : ${youngMedian} ms (${youngStats.measuredBlocks} blocks)`);
            console.log(` grown median      : ${grownMedian} ms (${grownStats.measuredBlocks} blocks)`);
            console.log(` block-time ratio  : ${blockRatio}x (ceiling ${MAX_RATIO}x)`);
            console.log(` expiry sweep ratio: ${expiryRatio}x (young ${youngExpiry} -> grown ${grownExpiry} ms)`);
            console.log('='.repeat(70));
            console.log('');

            reporter.writeJson({ name: 'grown-database', metric, young: youngStats, grown: grownStats },
                '07-grown-database');

            // --- Assertions ---
            assert.strictEqual(youngStats.errors.length, 0, 'young window had processing errors');
            assert.strictEqual(grownStats.errors.length, 0, 'grown window had processing errors');
            assert.ok(youngStats.measuredBlocks >= 5,
                `young window measured too few blocks (${youngStats.measuredBlocks})`);
            assert.ok(grownStats.measuredBlocks >= 5,
                `grown window measured too few blocks (${grownStats.measuredBlocks})`);

            // Primary gate: total block-time ratio, applied only when the young baseline
            // is above the runner's timing noise. On a very fast idle machine a window can
            // land in sub-millisecond jitter where any ratio is noise, not signal; there
            // the absolute fallback ceiling below governs instead.
            if (youngMedian >= MIN_TOTAL_MS && blockRatio !== null) {
                assert.ok(blockRatio <= MAX_RATIO,
                    `block-time regression: grown median (${grownMedian}ms) / young median ` +
                    `(${youngMedian}ms) = ${blockRatio}x exceeded ceiling ${MAX_RATIO}x. ` +
                    `The per-block cost is growing far faster than the standing set; check for a ` +
                    `new N+1, a dropped composite index, or a filesort in the block loop.`);
            } else {
                console.log(`[07-grown-database] young median ${youngMedian}ms below ` +
                    `${MIN_TOTAL_MS}ms noise floor; total-block ratio gate skipped, ` +
                    `absolute ceiling only.`);
                assert.ok(grownMedian <= MAX_GROWN_MS,
                    `grown-window median block time ${grownMedian}ms exceeded absolute ` +
                    `fallback ceiling ${MAX_GROWN_MS}ms`);
            }

            // Secondary gate: the expiry-sweep phase in isolation, the sharpest signal
            // (getExpiredItems re-scans the whole open set every block). Same noise-floor
            // guard, on the phase baseline.
            if (youngExpiry >= MIN_EXPIRY_MS && expiryRatio !== null) {
                assert.ok(expiryRatio <= MAX_EXPIRY_RATIO,
                    `expiry-sweep regression: grown (${grownExpiry}ms) / young (${youngExpiry}ms) ` +
                    `= ${expiryRatio}x exceeded ceiling ${MAX_EXPIRY_RATIO}x. The per-block open-item ` +
                    `sweep (db.getExpiredItems) is scaling far worse than the standing set; check ` +
                    `for a lost index or a reintroduced N+1 in the expiry path.`);
            } else {
                console.log(`[07-grown-database] young expiry ${youngExpiry}ms below ` +
                    `${MIN_EXPIRY_MS}ms noise floor; expiry-sweep ratio gate skipped.`);
            }
        } finally {
            await destroyIndexer(indexer);
        }
    });
});
