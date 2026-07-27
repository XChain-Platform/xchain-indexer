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
//
// ---------------------------------------------------------------------------
// LOAD REGIME: fast chain (DOGE).
//
// Scenarios 01-05 all run a BTC-shaped chain: 600-second blocks, and the load
// dialed up by putting MORE TRANSACTIONS in a block. DOGE is the opposite shape.
// Its blocks are 60 seconds apart and mostly sparse of XChain traffic, and a
// replica catching up (or any node behind the tip) runs the block loop flat out
// at ~10 blocks/s. So the cost that decides whether a DOGE node keeps up is not
// per-ACTION work at all, it is the PER-BLOCK FIXED cost: the decoder read, the
// expiry and cancellation sweeps, block creation, market updates, the sanity
// check and the commit, every one of which runs whether or not the block carries
// a single action. At 10 blocks/s that whole fixed set has a 100 ms budget.
//
// That regime was unmodelled here, which is why it is filed as a coverage gap
// rather than a defect (, from the 2026-06-24 scale/perf deep review). The
// scenario drives a real DOGE-configured indexer (regtest shares BTC's P2PKH
// version byte, so the fixture addresses validate unchanged) over a long sparse
// chain at 60-second cadence, seeded ahead of the indexer so the loop never
// waits on the seeder, and asserts two things:
//
//   1. The median block fits the 10 blocks/s budget.
//   2. That budget does not erode as the chain lengthens. This is the fast-chain
//      face of the same risk scenario 07 gates on a grown database: DOGE accrues
//      ten times the blocks per unit of wall-clock time, so anything that scales
//      with HEIGHT bites here first and hardest.
//
// Both assertions are configurable; the drift one is a ratio measured inside a
// single run, so it does not care how fast the machine is.
// ---------------------------------------------------------------------------

// This is the one perf scenario that is NOT BTC, so it pins the chain in its own
// before/after hooks rather than at module load. Mocha loads every scenario file
// before running any of them, and the sibling scenarios set INDEXER_COIN at load
// time with a `|| 'BTC'` fallback, so a load-time assignment here would either be
// overwritten or would leak DOGE into whichever file loads next. config.getConfig()
// re-reads the environment on every call, so setting it in before() is what
// actually decides the chain the indexer is built for.
const COIN    = process.env.PERF_FASTCHAIN_COIN    || 'DOGE';
const NETWORK = process.env.PERF_FASTCHAIN_NETWORK || 'regtest';

const assert = require('assert');
const { decoderQuery, indexerQuery, createDatabases, createDecoderSchema,
        resetDecoderDb, resetIndexerDb, closeAll } = require('../../integration/setup/db-connection');
const { initIndexer, destroyIndexer } = require('../../integration/setup/indexer-launcher');
const { forceXchainFeeMode } = require('../../integration/setup/multi-chain');
const DataGenerator = require('../setup/data-generator');
const MetricsCollector = require('../setup/metrics-collector');
const { processBlocksInstrumented } = require('../setup/instrumented-processor');
const ReportGenerator = require('../setup/report-generator');

// DOGE's 60-second target block time and the ~10 blocks/s a catching-up node runs at.
const BLOCK_SPACING_SEC = parseInt(process.env.PERF_FASTCHAIN_SPACING_SEC || '60');
const TARGET_BLOCKS_SEC = parseInt(process.env.PERF_FASTCHAIN_TARGET_BPS  || '10');

const BLOCKS       = parseInt(process.env.PERF_FASTCHAIN_BLOCKS   || '400');
const TXS_PER_BLOCK = parseInt(process.env.PERF_FASTCHAIN_TXS     || '1');
// Per-block budget implied by the target rate. Overridable for slower CI runners.
const BUDGET_MS    = parseFloat(process.env.PERF_FASTCHAIN_BUDGET_MS || String(1000 / TARGET_BLOCKS_SEC));
// Ceiling on (median of the last quarter of blocks) / (median of the first quarter).
// Generous by design, like scenario 07's: the balance path is O(accumulated history)
// at HEAD (the deep review's Theme 1), so per-block cost genuinely drifts up a little
// even on a sparse chain. Observed ~1.5x over 400 blocks. The gate's job is to fail
// loudly on a gross regression -- an added N+1, a dropped composite index -- not to
// claim the block loop is already flat. Tighten it as those paths get indexed.
const DRIFT_CEILING = parseFloat(process.env.PERF_FASTCHAIN_DRIFT || '3.0');

const BASE_TIME = 1700000000;
const WARMUP_BLOCKS = 10;

/**
 * Put INDEXER_COIN/INDEXER_NETWORK back exactly as they were, so a sibling scenario
 * running later in the same mocha process is not silently re-chained to DOGE.
 * Assigning an undefined value would set the STRING "undefined", so unset instead.
 */
function restoreEnv(prior) {
    for (const [key, value] of [['INDEXER_COIN', prior.coin], ['INDEXER_NETWORK', prior.network]]) {
        if (value === undefined) delete process.env[key];
        else                     process.env[key] = value;
    }
}

function median(values) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return (sorted.length % 2 === 0) ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

describe('08 Fast Chain (DOGE cadence, 10 blocks/s)', function () {
    this.timeout(0); // size controlled by PERF_FASTCHAIN_BLOCKS

    const reporter = new ReportGenerator();
    let stats = null;
    let timings = [];   // measured blocks, in chain order
    let validSends = 0;
    const priorEnv = { coin: process.env.INDEXER_COIN, network: process.env.INDEXER_NETWORK };

    before(async function () {
        process.env.INDEXER_COIN    = COIN;
        process.env.INDEXER_NETWORK = NETWORK;

        await createDatabases();
        await createDecoderSchema();
        await resetDecoderDb();
        await resetIndexerDb();

        const gen = new DataGenerator(decoderQuery);
        const indexer = await initIndexer();
        // Pin the fee path to xchain-balance, the same way the integration parity
        // suites do. DOGE regtest ships a real FEE_DESTINATION, so the native-coin
        // fee rule applies and every action wants a coin output paying it -- but the
        // decoder fixture seeds action rows, not coin outputs, so the bootstrap
        // issuances would fail "insufficient fee (native coin output required)",
        // TOKENA would never exist, and the whole run would be timing REJECTIONS.
        // (The valid-sends assertion below is what catches that if it ever recurs.)
        forceXchainFeeMode(indexer);
        const collector = new MetricsCollector({ name: 'fast-chain', warmupBlocks: WARMUP_BLOCKS });

        // Seed the WHOLE chain before starting the clock. A live fast-chain node is
        // never waiting on its source (that is the definition of falling behind), so
        // seeding inline would measure the fixture, not the indexer.
        const bootstrapEnd = await gen.bootstrap(1, BASE_TIME);
        await gen.generateBlocks(BLOCKS, TXS_PER_BLOCK, 'send-only', bootstrapEnd,
            BASE_TIME + bootstrapEnd * BLOCK_SPACING_SEC,
            { spacingSeconds: BLOCK_SPACING_SEC, bulk: true });

        collector.start();
        await processBlocksInstrumented(indexer, collector);
        collector.stop();

        stats = collector.getStats();
        timings = collector.blockTimings.slice(WARMUP_BLOCKS).map(b => b.totalMs);
        const rows = await indexerQuery(
            `SELECT COUNT(*) AS c FROM sends
              WHERE status_id = (SELECT id FROM index_statuses WHERE status='valid')`);
        validSends = Number(rows[0].c);

        reporter.generateAll(stats, '08-fast-chain');
        console.log(` Regime           : ${COIN} ${NETWORK}, ${BLOCK_SPACING_SEC}s blocks, ${TXS_PER_BLOCK} tx/block, ` +
                    `target ${TARGET_BLOCKS_SEC} blocks/s (${BUDGET_MS.toFixed(1)} ms/block budget)`);
        console.log(` Median block     : ${median(timings).toFixed(2)} ms ` +
                    `(${(BUDGET_MS / median(timings)).toFixed(1)}x headroom)`);

        await destroyIndexer(indexer);
    });

    after(async function () {
        restoreEnv(priorEnv);
        await closeAll();
    });

    it('processes the fast chain without errors', function () {
        assert.strictEqual(stats.errors.length, 0,
            'Errors during the fast-chain run: ' + JSON.stringify(stats.errors.slice(0, 3)));
        assert.ok(stats.measuredBlocks >= BLOCKS - WARMUP_BLOCKS,
            `Only ${stats.measuredBlocks} of ${BLOCKS} blocks were measured`);
    });

    it('indexes the seeded traffic as VALID (guards against measuring rejections)', function () {
        // A rejected action is far cheaper to process than an accepted one, so a fixture
        // that quietly started producing invalid actions would report a flattering and
        // meaningless block time. Counting rows in `actions` is not enough: rejections
        // are recorded there too. Only the valid status proves the work was really done.
        const seeded = BLOCKS * TXS_PER_BLOCK;
        assert.ok(validSends >= seeded,
            `Only ${validSends} VALID sends indexed for ${seeded} seeded transactions ` +
            '(the run was timing rejections, not real work)');
    });

    it(`still holds the ${TARGET_BLOCKS_SEC} blocks/s per-block budget at the end of the run`, function () {
        // Measured on the LAST quarter of the run, not the whole of it: the useful
        // question is whether a node that has been keeping up for a while STILL fits
        // the budget, and the late window is where the chain is longest.
        const quarter = Math.max(1, Math.floor(timings.length / 4));
        const late = median(timings.slice(-quarter));
        assert.ok(late <= BUDGET_MS,
            `Late-run median block took ${late.toFixed(2)} ms, over the ${BUDGET_MS.toFixed(1)} ms ` +
            `budget implied by ${TARGET_BLOCKS_SEC} blocks/s (whole-run p95 ${stats.blockTiming.p95} ms)`);
    });

    it('does not let per-block cost drift upward as the fast chain lengthens', function () {
        const quarter = Math.floor(timings.length / 4);
        assert.ok(quarter >= 5, 'Need at least 20 measured blocks for the drift comparison');
        const early = median(timings.slice(0, quarter));
        const late  = median(timings.slice(-quarter));
        const ratio = early > 0 ? late / early : 0;
        console.log(` Drift            : early ${early.toFixed(2)} ms -> late ${late.toFixed(2)} ms ` +
                    `(${ratio.toFixed(2)}x, ceiling ${DRIFT_CEILING}x)`);
        assert.ok(ratio <= DRIFT_CEILING,
            `Per-block cost drifted ${ratio.toFixed(2)}x over ${BLOCKS} fast-chain blocks ` +
            `(${early.toFixed(2)} ms -> ${late.toFixed(2)} ms), above the ${DRIFT_CEILING}x ceiling`);
    });
});
