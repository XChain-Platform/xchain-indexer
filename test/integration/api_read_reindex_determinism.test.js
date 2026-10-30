'use strict';

const assert = require('assert');

const {
    decoderQuery, indexerQuery, createDatabases, createDecoderSchema,
    resetDecoderDb, resetIndexerDb, closeAll, DB_PASS,
} = require('./setup/db-connection');
const DecoderSeeder = require('./setup/decoder-seeder');
const {
    initIndexer, processBlocks, destroyIndexer, destroyFileIndexers,
} = require('./setup/indexer-launcher');
const { seedGas } = require('./setup/gas-seeder');
const { buildTokenPolicyRpc } = require('../../src/api/rpc/token_policy.js');

const OWNER = 'mq7tVfobimRUPxPNnyd5mKn11SVmTiLxtu';
const TICK = 'FUTURE';
const START_TIME = 1700000000;

async function readHashChain(){
    const rows = await indexerQuery(
        `SELECT b.block_index,
                l.hash AS ledger,
                a.hash AS actions,
                c.hash AS contracts,
                s.hash AS state
         FROM blocks b
         LEFT JOIN index_transactions l ON l.id=b.ledger_hash_id
         LEFT JOIN index_transactions a ON a.id=b.actions_hash_id
         LEFT JOIN index_transactions c ON c.id=b.contract_hash_id
         LEFT JOIN index_transactions s ON s.id=b.state_hash_id
         ORDER BY b.block_index ASC`);
    return rows.map(row => ({
        block_index: Number(row.block_index),
        ledger: row.ledger,
        actions: row.actions,
        contracts: row.contracts,
        state: row.state,
    }));
}

async function readTickerIndex(){
    const rows = await indexerQuery('SELECT id, tick, block_index FROM index_tickers ORDER BY id');
    return rows.map(row => ({
        id: Number(row.id),
        tick: row.tick,
        block_index: row.block_index === null ? null : Number(row.block_index),
    }));
}

async function runChain(withApiRead, cleanTickerId){
    await resetDecoderDb();
    await resetIndexerDb();
    const seeder = new DecoderSeeder(decoderQuery);
    await seedGas(seeder, { blockIndex: 99, addresses: [OWNER] });

    const indexer = await initIndexer();
    try {
        assert.strictEqual(await processBlocks(indexer), 1);
        if(withApiRead){
            const rpc = buildTokenPolicyRpc({ indexer });
            assert.deepStrictEqual(
                await rpc.gettokenpolicy({ tick: TICK, origin_block: 0 }),
                { error: 'tick has no native row on this chain' });
            const rows = await indexerQuery('SELECT id FROM index_tickers WHERE tick=?', [TICK]);
            assert.deepStrictEqual(rows, []);
        }

        await seeder.seedBlock(100, START_TIME, [
            { source: OWNER, data: 'ISSUE|0|' + TICK + '|100000|1000|0|future token' },
        ]);
        assert.strictEqual(await processBlocks(indexer), 1);
        const futureRows = await indexerQuery('SELECT id, block_index FROM index_tickers WHERE tick=?', [TICK]);
        assert.strictEqual(futureRows.length, 1);
        const tickerId = cleanTickerId === undefined ? Number(futureRows[0].id) : cleanTickerId;
        await seeder.seedBlock(101, START_TIME + 600, [
            { source: OWNER, data: 'MINT|0|^' + tickerId + '|500' },
        ]);
        assert.strictEqual(await processBlocks(indexer), 1);
        return {
            tickerId,
            hashChain: await readHashChain(),
            tickerIndex: await readTickerIndex(),
        };
    } finally {
        await destroyIndexer(indexer);
    }
}

describe('API read before ISSUE replay determinism @regression @tier1', function(){
    this.timeout(90000);

    before(async function(){
        if(!DB_PASS) this.skip();
        await createDatabases(__filename);
        await createDecoderSchema();
    });

    after(async function(){
        await destroyFileIndexers(__filename);
        await closeAll();
    });

    it('matches the clean ledger hash chain after gettokenpolicy reads the future ticker', async function(){
        const clean = await runChain(false);
        const withRead = await runChain(true, clean.tickerId);
        const cleanFuture = clean.tickerIndex.find(row => row.tick === TICK);

        assert.ok(cleanFuture);
        assert.strictEqual(cleanFuture.block_index, 100);
        assert.deepStrictEqual(withRead.tickerIndex, clean.tickerIndex);
        assert.deepStrictEqual(withRead.hashChain, clean.hashChain);
    });
});
