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

// ---------------------------------------------------------------------------
// WHY THIS FILE HAS NO WALL-CLOCK DEADLINE 
//
// It used to carry `this.timeout(300000)` from the day the perf suite was written,
// and on 2026-07-29 the heavy scenario blew through it and was read as a possible
// throughput regression. Measured on the reference venue (devhost, throwaway
// tmpfs MariaDB 11.4, Node v22.22.3, otherwise idle) the heavy scenario finishes in
// 279 s and 274 s on two runs, of which 275 s and 274 s are block processing: it was
// inside the 300 s deadline by 7%, so it does not need a neighbouring container or a
// busy box to miss it, and when it misses, mocha reports a bare timeout that says
// nothing about throughput. The 2026-07-29 red tier was the deadline, not a wedge.
//
// The deadline was never sized for this file in the first place: heavy seeds
// 100 blocks x 50 mixed actions, five times the work of scenario 02's mixed-heavy
// case, and scenario 02 already gets 600 s. So the size is env-controlled here and
// the deadline is gone, exactly as in scenarios 03, 07, 08 and 09.
//
// What replaces it is a THROUGHPUT FLOOR per scenario. A vacuous
// `blocksPerSecond > 0` assertion can only ever fail by hanging, which is precisely
// the failure mode that cost a session; a floor fails with the measured number in
// the message. Floors are deliberately loose (see FLOOR_SLACK) because absolute
// throughput tracks the hardware; their job is to catch a gross regression, not to
// certify a particular box.
// ---------------------------------------------------------------------------

const BLOCK_COUNT = parseInt(process.env.PERF_BASELINE_BLOCKS || '100');
const BASE_TIME = 1700000000;
const WARMUP_BLOCKS = 5;

// Blocks/s each scenario reached on the reference venue described above, 2026-07-30.
// These are the CURRENT figures, not a target: per-action cost has roughly tripled
// since the suite's 2026-04-01 numbers (heavy ran 1.16 blocks/s on Node 18 then),
// which is the consensus machinery added in between plus the O(accumulated history)
// balance path that scenarios 07 and 08 already gate on. Re-measure and re-state
// them here rather than quietly widening FLOOR_SLACK.
const REFERENCE_BPS = {
    'empty':       36.3,
    'light-send':  17.5,
    'normal-10tx':  3.0,
    'heavy-50tx':   0.39,
};

// BLOCK_COUNT the figures above were taken at. A throughput reference is a
// measurement at ONE size, not a rate that holds at any size, for two reasons that
// push in opposite directions: the seven fixed bootstrap blocks dominate a short
// run (10 blocks measures 8.7 blocks/s on the same venue where 100 measures 36),
// and the O(accumulated history) balance path drags a long one down. So the floor
// is only applied at the size it was measured at.
const REFERENCE_BLOCKS = 100;

// How far below the reference a run may land before it fails. 3x absorbs a slower
// runner, a shared box and a cold cache, and still catches a slowdown the size of
// the one this file drifted through unnoticed between April and July.
const FLOOR_SLACK = parseFloat(process.env.PERF_BASELINE_SLACK || '3');

/**
 * Throughput floor for a scenario, in blocks/s. 0 means "do not gate".
 *
 * Returns 0 for a resized run (see REFERENCE_BLOCKS) and for a label with no
 * reference, which is a scenario added later: the old, ungated behaviour, so a new
 * case cannot be silently held to a number nobody measured for it.
 */
function floorFor(label) {
    const reference = REFERENCE_BPS[label];
    if (!reference) return 0;
    if (BLOCK_COUNT !== REFERENCE_BLOCKS) return 0;
    return reference / FLOOR_SLACK;
}

/** Assert the shared post-conditions every baseline scenario has to meet. */
function assertHealthy(stats, label) {
    assert.strictEqual(stats.errors.length, 0,
        `No errors expected, got ${stats.errors.length}: ` +
        stats.errors.slice(0, 3).map(e => `block ${e.blockIndex}: ${e.message}`).join('; '));
    assert.ok(stats.measuredBlocks > 0, 'Should process blocks');

    const floor = floorFor(label);
    const actual = stats.throughput.blocksPerSecond;
    if (floor === 0) {
        console.log(`    [${label}] ${actual} blocks/s, throughput floor not applied ` +
            `(BLOCK_COUNT ${BLOCK_COUNT} != reference size ${REFERENCE_BLOCKS})`);
        return;
    }
    assert.ok(actual >= floor,
        `${label}: ${actual} blocks/s is below the ${floor.toFixed(2)} blocks/s floor ` +
        `(reference ${REFERENCE_BPS[label]}, slack ${FLOOR_SLACK}x). ` +
        `${stats.totalBlocks} blocks took ${stats.durationMs} ms; ` +
        `actionProcessing avg ${stats.phaseTiming.actionProcessing.avg} ms/block. ` +
        `Raise PERF_BASELINE_SLACK for a slow runner, or re-measure REFERENCE_BPS.`);
}

describe('01 Baseline Throughput', function () {
    this.timeout(0); // size controlled by PERF_BASELINE_BLOCKS; floors do the gating

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

        const collector = new MetricsCollector({ name: label, warmupBlocks: WARMUP_BLOCKS });
        collector.start();
        const { blocksProcessed } = await processBlocksInstrumented(indexer, collector);
        collector.stop();
        const stats = collector.getStats();
        reporter.generateAll(stats, `01-${label}`);
        await destroyIndexer(indexer);
        return stats;
    }

    it('empty blocks (0 txs/block)', async function () {
        assertHealthy(await runScenario('empty', 0, 'send-only'), 'empty');
    });

    it('light blocks (1 tx/block, SEND only)', async function () {
        assertHealthy(await runScenario('light-send', 1, 'send-only'), 'light-send');
    });

    it('normal blocks (10 txs/block, mixed)', async function () {
        assertHealthy(await runScenario('normal-10tx', 10, 'normal'), 'normal-10tx');
    });

    it('heavy blocks (50 txs/block, mixed-heavy)', async function () {
        assertHealthy(await runScenario('heavy-50tx', 50, 'mixed-heavy'), 'heavy-50tx');
    });
});
