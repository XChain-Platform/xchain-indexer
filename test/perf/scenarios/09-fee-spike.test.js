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
// LOAD REGIME: fee spike (a large mempool backlog draining into the chain).
//
// Scenario 04 already models a spike, but a small and short one: 20 blocks of
// 100 transactions, ~2k in total, all from the same ten bootstrap addresses. A
// real fee spike differs in kind, not just size:
//
//   * VOLUME. The backlog does not clear inside one block, it drains over a long
//     run of back-to-back full blocks, so the question is whether per-transaction
//     cost stays flat for the whole drain or creeps as the ledger swells under it.
//   * SENDER CARDINALITY. The backlog comes from many unrelated senders, each one
//     a fresh address row and a fresh balance row -- exactly the working set the
//     ten-address profiles keep artificially tiny.
//   * AFTERMATH. The operationally important question is not only "does the node
//     survive the spike" but "is the node still fast once the spike clears".
//
// That regime was unmodelled here, which is why it is filed as a coverage gap
// rather than a defect (, from the 2026-06-24 scale/perf deep review).
//
// The run is ONE continuous chain in three legs, so every comparison is a ratio
// measured inside a single run and stays valid on any machine:
//
//   baseline (quiet)  ->  drain (the backlog)  ->  recovery (quiet again)
//
// HOW THE GATES ARE CHOSEN. Per-transaction cost in this codebase is O(accumulated
// history) today: the balance path resolves a balance by SUMming the whole debits
// and credits history (the deep review's Theme 1), so absolute per-transaction cost
// genuinely rises as the drain proceeds, and by an amount that depends on how big a
// backlog you configure. A fixed ratio ceiling would therefore be a knob-dependent
// coin flip. Both timing gates are instead expressed RELATIVE TO LEDGER GROWTH:
// cost may grow as fast as the ledger does (linear, which is what HEAD does), and
// the gate trips when it grows FASTER (something super-linear was introduced).
// The sharp, scale-free gate is the third one: the number of queries the indexer
// issues per transaction must not grow at all. That is the review's P14 fan-out,
// and it is what an accidental N+1 moves first.
//
// SIZING. The review's headline figure is a 50k-transaction mempool. Because the
// drain is quadratic in backlog size at HEAD (per-transaction cost is linear in
// accumulated history), a literal 50k run takes hours; that is a finding, not a
// harness limit. The default here is a runnable slice of the same regime, and
// PERF_FEESPIKE_TXS=50000 reproduces the full-scale figure when someone wants to
// spend the wall clock on it.
// ---------------------------------------------------------------------------

// Set in before(), not at module load: the fast-chain scenario runs on DOGE, and
// mocha loads every scenario file before running any of them, so a load-time
// assignment here is not what decides the chain. config.getConfig() re-reads the
// environment on every call, so the hook is the reliable place.
const COIN    = process.env.PERF_FEESPIKE_COIN    || 'BTC';
const NETWORK = process.env.PERF_FEESPIKE_NETWORK || 'regtest';

const assert = require('assert');
const { decoderQuery, indexerQuery, createDatabases, createDecoderSchema,
        resetDecoderDb, resetIndexerDb, closeAll } = require('../../integration/setup/db-connection');
const { initIndexer, destroyIndexer } = require('../../integration/setup/indexer-launcher');
const { forceXchainFeeMode } = require('../../integration/setup/multi-chain');
const DataGenerator = require('../setup/data-generator');
const MetricsCollector = require('../setup/metrics-collector');
const { processBlocksInstrumented } = require('../setup/instrumented-processor');
const ReportGenerator = require('../setup/report-generator');

// Backlog size. See SIZING above for why the default is not the review's 50000.
const SPIKE_TXS     = parseInt(process.env.PERF_FEESPIKE_TXS          || '6000');
// Transactions per drained block: a block stuffed with XChain traffic, orders of
// magnitude past anything the chains carry today.
const TXS_PER_BLOCK = parseInt(process.env.PERF_FEESPIKE_TX_PER_BLOCK || '500');
// Distinct senders behind the backlog.
const SENDERS       = parseInt(process.env.PERF_FEESPIKE_SENDERS      || '500');
// Quiet blocks either side of the spike, and their transaction count.
const QUIET_BLOCKS  = parseInt(process.env.PERF_FEESPIKE_QUIET_BLOCKS || '10');
const QUIET_TXS     = 5;

// How much faster than the ledger itself per-transaction (and quiet-block) cost is
// allowed to grow. 1.0 would mean "exactly linear in accumulated history", which is
// what HEAD does; the slack absorbs cache and timing noise. Raise only with a reason.
const GROWTH_SLACK  = parseFloat(process.env.PERF_FEESPIKE_GROWTH_SLACK || '1.5');
// Ceiling on (queries per transaction late in the drain) / (early in the drain).
// This one is scale-free and sharp: the fan-out is a fixed number of statements per
// action, so anything above ~1 is a new N+1.
const FANOUT_CEILING = parseFloat(process.env.PERF_FEESPIKE_FANOUT || '1.2');

const BASE_TIME = 1700000000;
const SPACING   = 600;
const DRAIN_BLOCKS = Math.ceil(SPIKE_TXS / TXS_PER_BLOCK);

/**
 * Put INDEXER_COIN/INDEXER_NETWORK back exactly as they were, so a sibling scenario
 * running later in the same mocha process keeps the chain it expects. Assigning an
 * undefined value would set the STRING "undefined", so unset instead.
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

describe('09 Fee Spike (mempool backlog drain)', function () {
    this.timeout(0); // size controlled by PERF_FEESPIKE_TXS

    const reporter = new ReportGenerator();
    let stats = null;
    let legs = null;               // { baseline, drain, recovery } as { from, to }
    let blockTimings = [];
    let queriesPerBlock = new Map(); // blockIndex -> indexer-DB queries issued
    let validSends = 0;
    let drainMs = 0;
    const priorEnv = { coin: process.env.INDEXER_COIN, network: process.env.INDEXER_NETWORK };

    /** Block timings whose blockIndex falls in [from, to]. */
    const inRange = (from, to) => blockTimings.filter(b => b.blockIndex >= from && b.blockIndex <= to);

    /**
     * Seeded transactions in every block BELOW `blockIndex`, read from the decoder DB.
     * Stands in for "how big is the ledger the balance path has to sum over" at the
     * moment that block is processed, which is what the growth-relative gates divide by.
     */
    const ledgerSizeBefore = async (blockIndex) => {
        const rows = await decoderQuery('SELECT COUNT(*) AS c FROM transactions WHERE block_index < ?', [blockIndex]);
        return Number(rows[0].c);
    };

    before(async function () {
        process.env.INDEXER_COIN    = COIN;
        process.env.INDEXER_NETWORK = NETWORK;

        await createDatabases();
        await createDecoderSchema();
        await resetDecoderDb();
        await resetIndexerDb();

        const gen = new DataGenerator(decoderQuery);
        const indexer = await initIndexer();
        // Pin the fee path to xchain-balance (see 08-fast-chain for the full note):
        // the decoder fixture seeds action rows, not coin outputs, so a configured
        // native FEE_DESTINATION would reject every fee-bearing action and the drain
        // would be timing rejections instead of work.
        forceXchainFeeMode(indexer);
        const collector = new MetricsCollector({ name: 'fee-spike', warmupBlocks: 0 });

        // --- Seed the whole three-leg chain up front ---------------------------------
        let block = await gen.bootstrap(1, BASE_TIME);
        let time  = BASE_TIME + block * SPACING;

        block = await gen.seedWideAddressPool(SENDERS, block, time, { spacingSeconds: SPACING });
        time  = BASE_TIME + block * SPACING;

        const baselineFrom = block;
        await gen.generateBlocks(QUIET_BLOCKS, QUIET_TXS, 'send-only', block, time,
            { spacingSeconds: SPACING, bulk: true });
        block += QUIET_BLOCKS; time = BASE_TIME + block * SPACING;

        const drainFrom = block;
        await gen.generateBlocks(DRAIN_BLOCKS, TXS_PER_BLOCK, 'fee-spike', block, time,
            { spacingSeconds: SPACING, bulk: true });
        block += DRAIN_BLOCKS; time = BASE_TIME + block * SPACING;

        const recoveryFrom = block;
        await gen.generateBlocks(QUIET_BLOCKS, QUIET_TXS, 'send-only', block, time,
            { spacingSeconds: SPACING, bulk: true });
        block += QUIET_BLOCKS;

        legs = {
            baseline: { from: baselineFrom, to: drainFrom - 1 },
            drain:    { from: drainFrom,    to: recoveryFrom - 1 },
            recovery: { from: recoveryFrom, to: block - 1 }
        };

        // --- Count the per-block query fan-out ---------------------------------------
        // Every indexer-DB statement routes through doQuery(), so one instance-level
        // wrapper sees the whole fan-out. Bracketed off the collector's own block
        // callbacks so the count lines up exactly with the block being timed.
        let queries = 0, atBlockStart = 0;
        const passThrough = indexer.indexerDb.doQuery.bind(indexer.indexerDb);
        indexer.indexerDb.doQuery = async (query, args) => { queries++; return passThrough(query, args); };
        const beginBlock = collector.beginBlock.bind(collector);
        const endBlock   = collector.endBlock.bind(collector);
        collector.beginBlock = (i)    => { atBlockStart = queries; beginBlock(i); };
        collector.endBlock   = (i, p) => { queriesPerBlock.set(i, queries - atBlockStart); endBlock(i, p); };

        // --- Run the chain -----------------------------------------------------------
        collector.start();
        await processBlocksInstrumented(indexer, collector);
        collector.stop();

        stats = collector.getStats();
        blockTimings = collector.blockTimings;
        drainMs = inRange(legs.drain.from, legs.drain.to).reduce((sum, b) => sum + b.totalMs, 0);
        const rows = await indexerQuery(
            `SELECT COUNT(*) AS c FROM sends
              WHERE status_id = (SELECT id FROM index_statuses WHERE status='valid')`);
        validSends = Number(rows[0].c);

        reporter.generateAll(stats, '09-fee-spike');
        console.log(` Regime           : ${COIN} ${NETWORK}, ${SPIKE_TXS.toLocaleString()} tx backlog ` +
                    `from ${SENDERS} senders, ` +
                    `drained over ${DRAIN_BLOCKS} blocks of ${TXS_PER_BLOCK}`);
        console.log(` Drain            : ${(drainMs / 1000).toFixed(1)} s ` +
                    `(${Math.round(SPIKE_TXS / (drainMs / 1000)).toLocaleString()} tx/s)`);

        await destroyIndexer(indexer);
    });

    after(async function () {
        restoreEnv(priorEnv);
        await closeAll();
    });

    it('drains the backlog without errors', function () {
        assert.strictEqual(stats.errors.length, 0,
            'Errors during the fee-spike drain: ' + JSON.stringify(stats.errors.slice(0, 3)));
        const drained = inRange(legs.drain.from, legs.drain.to).length;
        assert.strictEqual(drained, DRAIN_BLOCKS,
            `Only ${drained} of ${DRAIN_BLOCKS} drain blocks were processed`);
    });

    it('indexes the whole backlog as VALID (guards against measuring rejections)', function () {
        // Every fee-spike transaction is a SEND, so the sends table is the honest count,
        // but ONLY when filtered to the valid status: rejections land in these tables too
        // and are far cheaper to process than acceptances, so an underfunded or misconfigured
        // fixture would otherwise report flattering, meaningless timings.
        assert.ok(validSends >= SPIKE_TXS,
            `Only ${validSends} VALID sends indexed for a ${SPIKE_TXS} transaction backlog ` +
            '(the drain was timing rejections, not real work)');
    });

    it('does not increase the per-transaction query fan-out across the drain', function () {
        const drain = inRange(legs.drain.from, legs.drain.to).map(b => queriesPerBlock.get(b.blockIndex) / TXS_PER_BLOCK);
        const quarter = Math.max(1, Math.floor(drain.length / 4));
        const early = median(drain.slice(0, quarter));
        const late  = median(drain.slice(-quarter));
        const ratio = early > 0 ? late / early : 0;
        console.log(` Query fan-out    : ${early.toFixed(1)} -> ${late.toFixed(1)} queries/tx ` +
                    `(${ratio.toFixed(2)}x, ceiling ${FANOUT_CEILING}x)`);
        assert.ok(early > 0, 'No indexer-DB queries were counted; the fan-out probe is not wired');
        assert.ok(ratio <= FANOUT_CEILING,
            `Query fan-out per transaction grew ${ratio.toFixed(2)}x while draining the backlog ` +
            `(${early.toFixed(1)} -> ${late.toFixed(1)} queries/tx), which is an N+1, not a data-size effect`);
    });

    it('keeps per-transaction cost growing no faster than the ledger', async function () {
        const drain = inRange(legs.drain.from, legs.drain.to);
        const quarter = Math.max(1, Math.floor(drain.length / 4));
        const earlyBlocks = drain.slice(0, quarter);
        const lateBlocks  = drain.slice(-quarter);
        const early = median(earlyBlocks.map(b => b.totalMs / TXS_PER_BLOCK));
        const late  = median(lateBlocks.map(b => b.totalMs / TXS_PER_BLOCK));

        const ledgerEarly = await ledgerSizeBefore(earlyBlocks[0].blockIndex);
        const ledgerLate  = await ledgerSizeBefore(lateBlocks[0].blockIndex);
        const ledgerGrowth = ledgerEarly > 0 ? ledgerLate / ledgerEarly : 1;
        const costGrowth   = early > 0 ? late / early : 0;

        console.log(` Drain cost       : ${early.toFixed(3)} -> ${late.toFixed(3)} ms/tx ` +
                    `(${costGrowth.toFixed(2)}x) against ${ledgerGrowth.toFixed(2)}x ledger growth ` +
                    `(ceiling ${(ledgerGrowth * GROWTH_SLACK).toFixed(2)}x)`);
        assert.ok(costGrowth <= ledgerGrowth * GROWTH_SLACK,
            `Per-transaction cost grew ${costGrowth.toFixed(2)}x while the ledger grew only ` +
            `${ledgerGrowth.toFixed(2)}x (${early.toFixed(3)} -> ${late.toFixed(3)} ms/tx), which is super-linear`);
    });

    it('leaves quiet blocks no slower than the ledger growth explains', async function () {
        const baselineBlocks = inRange(legs.baseline.from, legs.baseline.to);
        const recoveryBlocks = inRange(legs.recovery.from, legs.recovery.to);
        const baseline = median(baselineBlocks.map(b => b.totalMs));
        const recovery = median(recoveryBlocks.map(b => b.totalMs));

        const ledgerBaseline = await ledgerSizeBefore(legs.baseline.from);
        const ledgerRecovery = await ledgerSizeBefore(legs.recovery.from);
        const ledgerGrowth = ledgerBaseline > 0 ? ledgerRecovery / ledgerBaseline : 1;
        const costGrowth   = baseline > 0 ? recovery / baseline : 0;

        console.log(` Recovery         : ${baseline.toFixed(2)} -> ${recovery.toFixed(2)} ms/block ` +
                    `(${costGrowth.toFixed(2)}x) against ${ledgerGrowth.toFixed(2)}x ledger growth ` +
                    `(ceiling ${(ledgerGrowth * GROWTH_SLACK).toFixed(2)}x)`);
        assert.ok(costGrowth <= ledgerGrowth * GROWTH_SLACK,
            `Quiet blocks after the spike are ${costGrowth.toFixed(2)}x slower than before it while the ` +
            `ledger grew ${ledgerGrowth.toFixed(2)}x (${baseline.toFixed(2)} -> ${recovery.toFixed(2)} ms)`);
    });
});
