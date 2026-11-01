'use strict';

const assert = require('assert');
const sinon = require('sinon');

const { buildTokenPolicyRpc } = require('../../../../src/api/rpc/token_policy.js');
const { makeDb } = require('../../db/db_queries.test/helpers/db_stub.js');

function databaseHarness(){
    const db = makeDb();
    const rows = { tickers: [], addresses: [] };
    const queries = [];
    const connection = {
        query: sinon.stub().callsFake(async (sql, args = []) => {
            queries.push({ sql, args });
            if(/SELECT id FROM index_tickers WHERE LOWER\(tick\)=\?/.test(sql)){
                const row = rows.tickers.find(item => item.tick.toLowerCase() === String(args[0]).toLowerCase());
                return row ? [{ id: row.id }] : [];
            }
            if(/SELECT id FROM index_tickers WHERE id=\? AND block_index IS NOT NULL/.test(sql)){
                const row = rows.tickers.find(item => item.id === Number(args[0]) && item.block_index !== null);
                return row ? [{ id: row.id }] : [];
            }
            if(/LEFT\(tick, 200\)=LEFT\(\?, 200\)/.test(sql))
                return [];
            if(/SELECT id FROM index_tickers ORDER BY id DESC LIMIT 1/.test(sql)){
                const id = rows.tickers.reduce((max, row) => Math.max(max, row.id), 0);
                return id ? [{ id }] : [];
            }
            if(/INSERT IGNORE INTO index_tickers \(`id`, `tick`, `block_index`\)/.test(sql)){
                rows.tickers.push({ id: Number(args[0]), tick: args[1], block_index: Number(args[2]) });
                return { affectedRows: 1 };
            }
            if(/INSERT IGNORE INTO index_tickers \(tick\)/.test(sql)){
                rows.tickers.push({ id: rows.tickers.length + 1, tick: args[0], block_index: null });
                return { affectedRows: 1 };
            }
            if(/SELECT id FROM index_addresses WHERE `address`=\?/.test(sql)){
                const row = rows.addresses.find(item => item.address === args[0]);
                return row ? [{ id: row.id }] : [];
            }
            if(/SELECT id FROM index_addresses WHERE id=\? AND block_index IS NOT NULL/.test(sql)){
                const row = rows.addresses.find(item => item.id === Number(args[0]) && item.block_index !== null);
                return row ? [{ id: row.id }] : [];
            }
            if(/INSERT IGNORE INTO index_addresses \(`address`\)/.test(sql)){
                rows.addresses.push({ id: rows.addresses.length + 1, address: args[0], block_index: null });
                return { affectedRows: 1 };
            }
            return [];
        }),
        release: sinon.stub().resolves()
    };
    db.pool.getConnection.resolves(connection);
    return { db, rows, queries, connection };
}

function policyRpc(db){
    return buildTokenPolicyRpc({
        indexer: { indexerDb: db, config: db.config, util: db.util }
    });
}

afterEach(function(){ sinon.restore(); });

describe('API read index id suppression @regression @tier1', function(){
    it('apiView createTicker returns the id for a known deterministic name', async function(){
        const harness = databaseHarness();
        harness.rows.tickers.push({ id: 4, tick: 'KNOWN', block_index: 91 });

        assert.strictEqual(await harness.db.apiView().createTicker('KNOWN'), 4);
        assert.strictEqual(harness.queries.some(row => /INSERT.*index_tickers/i.test(row.sql)), false);
    });

    it('apiView createTicker returns the id for a known name with NULL block_index', async function(){
        const harness = databaseHarness();
        harness.rows.tickers.push({ id: 5, tick: 'LEGACY', block_index: null });

        assert.strictEqual(await harness.db.apiView().createTicker('LEGACY'), 5);
        assert.strictEqual(harness.queries.some(row => /INSERT.*index_tickers/i.test(row.sql)), false);
    });

    it('apiView createTicker resolves a canonical caret id in the deterministic set', async function(){
        const harness = databaseHarness();
        harness.rows.tickers.push({ id: 6, tick: 'COMPACT', block_index: 92 });

        assert.strictEqual(await harness.db.apiView().createTicker('^6'), 6);
        assert.strictEqual(harness.queries.some(row => /INSERT.*index_tickers/i.test(row.sql)), false);
    });

    it('apiView createAddress returns the id for a known deterministic name', async function(){
        const harness = databaseHarness();
        harness.rows.addresses.push({ id: 7, address: 'known-address', block_index: 93 });

        assert.strictEqual(await harness.db.apiView().createAddress('known-address'), 7);
        assert.strictEqual(harness.queries.some(row => /INSERT.*index_addresses/i.test(row.sql)), false);
    });

    it('apiView createAddress returns the id for a known name with NULL block_index', async function(){
        const harness = databaseHarness();
        harness.rows.addresses.push({ id: 8, address: 'legacy-address', block_index: null });

        assert.strictEqual(await harness.db.apiView().createAddress('legacy-address'), 8);
        assert.strictEqual(harness.queries.some(row => /INSERT.*index_addresses/i.test(row.sql)), false);
    });

    it('apiView createAddress resolves a canonical caret id in the deterministic set', async function(){
        const harness = databaseHarness();
        harness.rows.addresses.push({ id: 9, address: 'compact-address', block_index: 94 });

        assert.strictEqual(await harness.db.apiView().createAddress('^9'), 9);
        assert.strictEqual(harness.queries.some(row => /INSERT.*index_addresses/i.test(row.sql)), false);
    });

    it('gettokenpolicy leaves an unknown ticker absent from index_tickers', async function(){
        const harness = databaseHarness();
        const result = await policyRpc(harness.db).gettokenpolicy({ tick: 'FUTURE', origin_block: 0 });

        assert.deepStrictEqual(result, { error: 'tick has no native row on this chain' });
        assert.deepStrictEqual(harness.rows.tickers, []);
        assert.strictEqual(harness.queries.some(row => /INSERT.*index_tickers/i.test(row.sql)), false);
    });

    it('getappliedpolicy leaves an unknown ticker absent from index_tickers', async function(){
        const harness = databaseHarness();
        const result = await policyRpc(harness.db).getappliedpolicy({ tick: 'DOGE.FUTURE' });

        assert.deepStrictEqual(result, { error: 'tick has no local row on this chain' });
        assert.deepStrictEqual(harness.rows.tickers, []);
        assert.strictEqual(harness.queries.some(row => /INSERT.*index_tickers/i.test(row.sql)), false);
    });

    it('gettokenpolicy stores nothing while the parent database has an open transaction', async function(){
        const harness = databaseHarness();
        harness.db.transactionConnection = harness.connection;
        harness.db.blockIndex = 106;

        const result = await policyRpc(harness.db).gettokenpolicy({ tick: 'FUTURE', origin_block: 0 });

        assert.deepStrictEqual(result, { error: 'tick has no native row on this chain' });
        assert.deepStrictEqual(harness.rows.tickers, []);
        assert.strictEqual(harness.queries.some(row => /INSERT.*index_tickers/i.test(row.sql)), false);
    });

    it('the API view leaves an unknown address absent from index_addresses', async function(){
        const harness = databaseHarness();
        const view = harness.db.apiView();

        assert.strictEqual(Object.hasOwn(view, 'suppressIndexIdCreation'), true);
        assert.strictEqual(view.suppressIndexIdCreation, true);
        assert.strictEqual(harness.db.suppressIndexIdCreation, false);
        assert.strictEqual(await view.createAddress('unknown-address'), null);
        assert.deepStrictEqual(harness.rows.addresses, []);
        assert.strictEqual(harness.queries.some(row => /INSERT.*index_addresses/i.test(row.sql)), false);
    });

    it('an API lookup before a future ISSUE preserves the block ticker allocation', async function(){
        const withRead = databaseHarness();
        const clean = databaseHarness();

        await policyRpc(withRead.db).gettokenpolicy({ tick: 'FUTURE', origin_block: 0 });
        withRead.db.transactionConnection = withRead.connection;
        withRead.db.blockIndex = 107;
        const afterReadId = await withRead.db.createTicker('FUTURE');

        clean.db.transactionConnection = clean.connection;
        clean.db.blockIndex = 107;
        const cleanId = await clean.db.createTicker('FUTURE');

        assert.strictEqual(afterReadId, cleanId);
        assert.deepStrictEqual(withRead.rows.tickers, clean.rows.tickers);
    });
});
