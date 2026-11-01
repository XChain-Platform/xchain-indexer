'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const { performance } = require('perf_hooks');
const HubDbSync = require('../../src/hub/hub_db_sync.js');

const ROW_COUNT = 2000;
const LOCAL_COLUMNS = new Set([
    'id', 'round_number', 'coin_pair', 'price', 'reference_block', 'reference_chain',
    'block_timestamp', 'validator_count', 'consensus_round', 'consensus_proof', 'status',
    'source_chain', 'source_action_index', 'push_generation', 'batch_block_time',
    'admit_block_btc', 'admit_block_ltc', 'admit_block_doge', 'created_at',
]);

function rows() {
    return Array.from({ length: ROW_COUNT }, (_, i) => ({
        id: i + 1,
        round_number: i + 1,
        coin_pair: 'XCHAIN/USD',
        price: '1.00000000',
        reference_block: 100000 + i,
        reference_chain: 'BTC',
        block_timestamp: 1999900000 + i,
        validator_count: 4,
        consensus_round: 1,
        consensus_proof: '[]',
        status: 'finalized',
        source_chain: 'DOGE',
        source_action_index: i + 1,
        push_generation: 0,
        batch_block_time: 1999900000 + i,
        admit_block_btc: 100000 + i,
        admit_block_ltc: 200000 + i,
        admit_block_doge: 300000 + i,
        created_at: '2026-10-24T00:00:00.000Z',
    }));
}

function drain(page) {
    const now = Date.now();
    return {
        table: 'price_snapshots',
        pending: page.map(row => ({ row })),
        lastId: 0,
        priceHorizon: 2000000000,
        priceFloor: 1900000000,
        priceSkipped: 0,
        applied: 0,
        applyErrors: 0,
        minAppliedWireId: Infinity,
        preHorizonServed: new Set(),
        preHorizonRetained: new Set(),
        pricePairHeld: new Map(),
        pricePairCovered: new Set(),
        servedPriceKeys: new Set(),
        priceKeysComplete: true,
        maxServedRound: 0,
        fetched: page.length,
        pagesFetched: 1,
        drainStartedAt: now,
        lastProgressAt: now,
    };
}

async function measure(batchApply) {
    let transactions = 0;
    const db = {
        async doQueryStrict() {
            transactions++;
            await new Promise(resolve => setTimeout(resolve, 1));
            return { affectedRows: 1 };
        },
    };
    db.doQuery = db.doQueryStrict;
    const sync = new HubDbSync(db, {
        hubUrl: 'http://hub.test',
        batchApply: batchApply,
        bootstrapProgressMs: 0,
    });
    sync.localColumns = async () => LOCAL_COLUMNS;
    const state = drain(rows());
    const started = performance.now();
    assert.strictEqual(await sync.flushPendingRows(state), true);
    const elapsedMs = performance.now() - started;
    assert.strictEqual(state.applied, ROW_COUNT);
    assert.strictEqual(state.lastId, ROW_COUNT);
    return { elapsedMs, transactions };
}

async function main() {
    const before = await measure(false);
    const after = await measure(true);
    const speedup = before.elapsedMs / after.elapsedMs;
    process.stdout.write(JSON.stringify({
        rows: ROW_COUNT,
        synthetic_transaction_latency_ms: 1,
        before: { elapsed_ms: Number(before.elapsedMs.toFixed(2)), transactions: before.transactions },
        after: { elapsed_ms: Number(after.elapsedMs.toFixed(2)), transactions: after.transactions },
        speedup_x: Number(speedup.toFixed(2)),
    }, null, 2) + '\n');
}

main().catch(err => {
    process.stderr.write(String(err && err.stack || err) + '\n');
    process.exitCode = 1;
});
