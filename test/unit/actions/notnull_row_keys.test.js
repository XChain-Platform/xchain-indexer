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
// Wire fields whose typed row holds them in a NOT NULL column: the cancel and edit keys of
// ORDER, SWAP and DISPENSER, a bet's FEED_ACTION_INDEX, a DEPLOY v4 carrier's CHUNK_INDEX
// and TOTAL_CHUNKS, and the AMOUNT of DEPOSIT and WITHDRAW. A value that stores as NULL
// (empty, not numeric, or outside the column) reached the INSERT as NULL, which throws inside
// the block transaction, so the block never committed. Each handler now refuses the action
// and its row keeps the refusal under a placeholder. Every row here is written by the
// production Database writer against the table's own src/sql DDL on node:sqlite, so the
// NOT NULL contract is the real one.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');
const { getTestConfig } = require('../../fixtures/config');
const { makeMigrationDb } = require('../../helpers/sqlMigrationDb');
const Database = require('../../../src/db');

const Order       = require('../../../src/actions/order/index.js');
const Swap        = require('../../../src/actions/swap/index.js');
const Dispenser   = require('../../../src/actions/dispenser/index.js');
const Bet         = require('../../../src/actions/bet/index.js');
const Deploy      = require('../../../src/actions/deploy/index.js');
const DeployChunk = require('../../../src/actions/deploy/deploy_chunk.js');
const Deposit     = require('../../../src/actions/deposit.js');
const Withdraw    = require('../../../src/actions/withdraw.js');

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

// Values that store as NULL in a BIGINT UNSIGNED action-index column, each of which halted
// the block before the fix: not numeric, empty, past the u64 bound, and negative.
const BAD_INDEXES = ['abc', '', '18446744073709551616', '-1'];

// Route one Database writer to the real method, run against node:sqlite holding the
// table's shipped DDL. The interning helpers answer 1. Returns a reader for one column.
function realWriter(indexer, method, table){
    const sql  = makeMigrationDb([table + '.sql']);
    const self = {
        util:   indexer.util,
        config: indexer.config,
        normalizeDataValues: Database.prototype.normalizeDataValues,
        createMemo:   async () => 1,
        createStatus: async () => 1,
        createTicker: async () => 1,
        getAddressId: async () => 1,
        async doQuery(query, args){
            const stmt  = sql.db.prepare(query);
            const bound = (args || []).map(v => (v === undefined ? null : (v !== null && typeof v === 'object') ? String(v) : v));
            if(/^\s*SELECT/i.test(query))
                return stmt.all(...bound);
            stmt.run(...bound);
            return [];
        },
    };
    indexer.indexerDb[method] = (data) => Database.prototype[method].call(self, data);
    return (column) => sql.rows('SELECT ' + column + ' AS v FROM ' + table).map(r => r.v);
}

// The actions context every handler here is built on, over a mock indexer.
function makeHandlerContext(config){
    const indexer = createMockIndexer(config ? { config } : {});
    const ctx = {
        config: indexer.config, util: indexer.util, mapper: indexer.mapper,
        decoderDb: indexer.decoderDb, indexerDb: indexer.indexerDb, hubDb: null,
        protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
        processAction: sinon.stub().resolves(),
    };
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    indexer.indexerDb.getTickerId.resolves(99);
    // The database answers false, not null, for an action index it does not hold
    indexer.indexerDb.getDispenserInfo.resolves(false);
    indexer.util.resetLists();
    return { indexer, ctx };
}

// The cancel and edit formats of the three market actions: the handler, its wire tail after
// the key, the row's table and writer, and the key's field and column.
const MARKET_CASES = [
    { name: 'ORDER cancel',     Handler: Order,     action: 'ORDER',     format: 1, tail: '|m',         table: 'order_cancels',     writer: 'createOrderCancel',     field: 'ORDER_ACTION_INDEX' },
    { name: 'ORDER edit',       Handler: Order,     action: 'ORDER',     format: 2, tail: '||||m',      table: 'order_edits',       writer: 'createOrderEdit',       field: 'ORDER_ACTION_INDEX' },
    { name: 'SWAP cancel',      Handler: Swap,      action: 'SWAP',      format: 1, tail: '|m',         table: 'swap_cancels',      writer: 'createSwapCancel',      field: 'SWAP_ACTION_INDEX' },
    { name: 'SWAP edit',        Handler: Swap,      action: 'SWAP',      format: 2, tail: '||||m',      table: 'swap_edits',        writer: 'createSwapEdit',        field: 'SWAP_ACTION_INDEX' },
    { name: 'DISPENSER cancel', Handler: Dispenser, action: 'DISPENSER', format: 1, tail: '|m',         table: 'dispenser_cancels', writer: 'createDispenserCancel', field: 'DISPENSER_ACTION_INDEX' },
    { name: 'DISPENSER edit',   Handler: Dispenser, action: 'DISPENSER', format: 2, tail: '|1||||m',    table: 'dispenser_edits',   writer: 'createDispenserEdit',   field: 'DISPENSER_ACTION_INDEX' },
];

// One market cancel or edit format: every key that stores as NULL is refused, and a
// numeric key stores exactly as before.
function describeMarketKey(c){
    describe(c.name + ' (' + c.table + '.' + c.field.toLowerCase() + ')', function () {
        for(const bad of BAD_INDEXES){
            it('refuses ' + c.field + "='" + bad + "' and stores the row under 0", async function () {
                const { indexer, ctx } = makeHandlerContext();
                const column = realWriter(indexer, c.writer, c.table);
                const data = createBaseData({ ACTION: c.action, FORMAT: c.format, SOURCE });

                await new c.Handler(ctx).parse((c.format + '|' + bad + c.tail).split('|'), data, false);

                assert.strictEqual(data['STATUS'], 'invalid: ' + c.field + ' (format)');
                assert.deepStrictEqual(column(c.field.toLowerCase()), [0]);
            });
        }

        it('stores a numeric key that names no ' + c.action + ' as it did before', async function () {
            const { indexer, ctx } = makeHandlerContext();
            const column = realWriter(indexer, c.writer, c.table);
            const data = createBaseData({ ACTION: c.action, FORMAT: c.format, SOURCE });

            await new c.Handler(ctx).parse((c.format + '|42' + c.tail).split('|'), data, false);

            assert.match(data['STATUS'], new RegExp('^invalid: ' + c.field + ' \\(unknown\\)'));
            assert.deepStrictEqual(column(c.field.toLowerCase()), [42]);
        });
    });
}

// BET format 2, the one BET format whose row holds FEED_ACTION_INDEX in a NOT NULL column.
function describeBetPlace(){
    describe('BET place (bets.feed_action_index)', function () {
        for(const bad of BAD_INDEXES){
            it("refuses FEED_ACTION_INDEX='" + bad + "' and stores the row under 0", async function () {
                const { indexer, ctx } = makeHandlerContext();
                const column = realWriter(indexer, 'createBet', 'bets');
                const data = createBaseData({ ACTION: 'BET', FORMAT: 2, SOURCE });

                await new Bet(ctx).parse(['2', bad, '1', '1', 'm'], data, false);

                assert.strictEqual(data['STATUS'], 'invalid: FEED_ACTION_INDEX (format)');
                assert.deepStrictEqual(column('feed_action_index'), [0]);
            });
        }

        it('stores a numeric FEED_ACTION_INDEX that names no feed as it did before', async function () {
            const { indexer, ctx } = makeHandlerContext();
            const column = realWriter(indexer, 'createBet', 'bets');
            const data = createBaseData({ ACTION: 'BET', FORMAT: 2, SOURCE });

            await new Bet(ctx).parse(['2', '42', '1', '1', 'm'], data, false);

            assert.strictEqual(data['STATUS'], 'invalid: FEED_ACTION_INDEX (unknown)');
            assert.deepStrictEqual(column('feed_action_index'), [42]);
        });
    });
}

// DEPLOY v4: a CHUNK_INDEX or TOTAL_CHUNKS that is not a finite number is stored as 0.
function describeDeployCarrier(){
    describe('DEPLOY v4 carrier (deploy_chunks.chunk_index / total_chunks)', function () {
        const HASH = crypto.createHash('sha256').update('x').digest('hex');

        // A carrier handler whose gas fee is zero, so the format verdict is the only one.
        function makeCarrier(){
            const config = getTestConfig();
            config['GAS_PRICE'] = '0';
            const { indexer, ctx } = makeHandlerContext(config);
            ctx.protocolChanges.isEnabled = sinon.stub().resolves(false);
            indexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 1 });
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });
            const column = realWriter(indexer, 'recordDeployChunk', 'deploy_chunks');
            return { carrier: new DeployChunk(ctx, new Deploy(ctx)), column };
        }

        for(const [field, wire] of [['CHUNK_INDEX', (v) => [v, '3']], ['TOTAL_CHUNKS', (v) => ['0', v]]]){
            for(const bad of ['abc', '1x', '1e999']){
                it('refuses ' + field + "='" + bad + "' and stores the row under 0", async function () {
                    const { carrier, column } = makeCarrier();
                    const data = createBaseData({ ACTION: 'DEPLOY', FORMAT: 4, SOURCE, ACTION_INDEX: 5 });

                    await carrier.parse(['4', HASH].concat(wire(bad), ['aGVsbG8=']), data, null);

                    assert.match(data['STATUS'], new RegExp('^invalid: ' + field + ' \\('));
                    assert.deepStrictEqual(column(field.toLowerCase()), [0]);
                });
            }
        }

        it('stores an out-of-range CHUNK_INDEX as it did before', async function () {
            const { carrier, column } = makeCarrier();
            const data = createBaseData({ ACTION: 'DEPLOY', FORMAT: 4, SOURCE, ACTION_INDEX: 5 });

            await carrier.parse(['4', HASH, '7', '3', 'aGVsbG8='], data, null);

            assert.strictEqual(data['STATUS'], 'invalid: CHUNK_INDEX (out of range)');
            assert.deepStrictEqual(column('chunk_index'), [7]);
        });
    });
}

// DEPOSIT and WITHDRAW: an AMOUNT that stores as NULL is refused and stored as '0'.
function describeCustodyAmount(action, Handler, table, writer){
    describe(action + ' (' + table + '.amount)', function () {
        // A live contract and a known TICK, so AMOUNT is the first field judged.
        function makeCustodyHandler(){
            const { indexer, ctx } = makeHandlerContext();
            indexer.indexerDb.getContract = sinon.stub().resolves({ contract_index: 7, status_id: 1, source_id: 1 });
            indexer.indexerDb.getStatusString = sinon.stub().resolves('valid');
        // A contract deployed before OWNER_WITHDRAW_OPT_IN, so its owner may WITHDRAW
        ctx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) => name !== 'OWNER_WITHDRAW_OPT_IN');
            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 }));
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
            const column = realWriter(indexer, writer, table);
            return { handler: new Handler(ctx), column };
        }

        for(const bad of ['abc', '', '1x']){
            it("refuses AMOUNT='" + bad + "' and stores the row under '0'", async function () {
                const { handler, column } = makeCustodyHandler();
                const data = createBaseData({ ACTION: action, FORMAT: 0, SOURCE });

                await handler.parse(['0', '7', 'TEST', bad], data, false);

                assert.strictEqual(data['STATUS'], 'invalid: AMOUNT (format)');
                assert.deepStrictEqual(column('amount'), ['0']);
            });
        }

        it('stores a zero AMOUNT as it did before', async function () {
            const { handler, column } = makeCustodyHandler();
            const data = createBaseData({ ACTION: action, FORMAT: 0, SOURCE });

            await handler.parse(['0', '7', 'TEST', '0'], data, false);

            assert.strictEqual(data['STATUS'], 'invalid: AMOUNT (zero)');
            assert.deepStrictEqual(column('amount'), ['0']);
        });
    });
}

describe('NOT NULL row keys refuse instead of halting @regression @tier2', function () {
    afterEach(() => sinon.restore());
    for(const c of MARKET_CASES)
        describeMarketKey(c);
    describeBetPlace();
    describeDeployCarrier();
    describeCustodyAmount('DEPOSIT', Deposit, 'deposits', 'createDeposit');
    describeCustodyAmount('WITHDRAW', Withdraw, 'withdrawals', 'createWithdrawal');
});
