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
// Wire fields whose typed row holds them in a NOT NULL column: market and bet action indexes,
// DEPLOY v4 chunk indexes, STAKE signing keys, and action amounts. A value the column cannot
// represent reached the INSERT unchanged or as NULL, which throws inside the block transaction,
// so the block never committed. Each handler now refuses the action and its row keeps the
// refusal under a placeholder. Every row here is written by the production Database writer
// against the table's own src/sql DDL on node:sqlite; explicit schema assertions model the
// strict MariaDB checks SQLite omits.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');
const mathjs = require('mathjs');
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
const Stake       = require('../../../src/actions/stake/index.js');
const Vote        = require('../../../src/actions/vote/index.js');
const sendLegs    = require('../../../src/actions/send/legs.js');
const destroyLegs = require('../../../src/actions/destroy/legs.js');

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const SQL_DIR = path.join(__dirname, '../../../src/sql');
const U32_MAX = '4294967295';
const U64_MAX = '18446744073709551615';

// Values that store as NULL in a BIGINT UNSIGNED action-index column, each of which halted
// the block before the fix: not numeric, empty, past the u64 bound, and negative.
const BAD_INDEXES = ['abc', '', '18446744073709551616', '-1'];

// These spellings pass the JavaScript numeric predicate but a strict MariaDB integer
// column refuses them. Decimal and scientific spellings which MariaDB rounds or converts
// successfully are covered separately as compatibility controls.
const BAD_MARIADB_INDEXES = [
    '0x10',
    '0b1',
    '0o7',
    '1.8446744073709551616e19',
    '18446744073709551615.5',
];

const definitionColumns = (table) => {
    const raw = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8');
    const parsed = Database.prototype.parseExpectedColumns.call(
        { stripSqlLineComments: Database.prototype.stripSqlLineComments }, raw);
    assert.ok(parsed, 'could not parse src/sql/' + table + '.sql');
    return Object.fromEntries(parsed.map(c => [c.name, c.definition]));
};

// Model the strict server checks SQLite omits for the column types used in this suite.
// This reads the shipped DDL for every assertion, so an UNSIGNED or VARCHAR width change
// changes the test's storage contract as well.
function columnAccepts(table, column, value){
    const spec = definitionColumns(table)[column];
    assert.ok(spec, table + '.' + column + ' is absent from its schema definition');
    if(value === null || value === undefined)
        return !/\bNOT\s+NULL\b/i.test(spec);

    const integer = /\b(TINYINT|SMALLINT|MEDIUMINT|INT|BIGINT)\b/i.exec(spec);
    if(integer){
        const unsigned = /\bUNSIGNED\b/i.test(spec);
        const bits = { TINYINT: 8, SMALLINT: 16, MEDIUMINT: 24, INT: 32, BIGINT: 64 }[integer[1].toUpperCase()];
        const raw = String(value).trim();
        if(/^[-+]?0[xbo]/i.test(raw) || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw))
            return false;
        const number = mathjs.bignumber(raw);
        if(!number.isFinite()) return false;
        const min = unsigned ? mathjs.bignumber(0) : mathjs.bignumber(2).pow(bits - 1).negated();
        const max = unsigned ? mathjs.bignumber(2).pow(bits).minus(1) : mathjs.bignumber(2).pow(bits - 1).minus(1);
        return number.gt(min.minus(0.5)) && number.lt(max.plus(0.5));
    }

    const varchar = /\b(?:VAR)?CHAR\s*\(\s*(\d+)\s*\)/i.exec(spec);
    if(varchar)
        return Array.from(String(value)).length <= Number(varchar[1]);
    return true;
}

function assertColumnRejects(table, column, value){
    assert.strictEqual(columnAccepts(table, column, value), false,
        table + '.' + column + ' should refuse ' + JSON.stringify(value));
}

function assertColumnAccepts(table, column, value){
    assert.strictEqual(columnAccepts(table, column, value), true,
        table + '.' + column + ' should accept ' + JSON.stringify(value));
}

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
        createAddress: async () => 1,
        getAddressId: async () => 1,
        getOrCreatePubkeyId: async (pubkey) => indexer.util.isNull(pubkey) ? null : 1,
        async doQuery(query, args){
            const stmt  = sql.db.prepare(query);
            const bound = (args || []).map(v => (v === undefined ? null : (v !== null && typeof v === 'object') ? String(v) : v));
            if(/^\s*SELECT/i.test(query))
                return stmt.all(...bound);
            stmt.run(...bound);
            return [];
        },
    };
    self.createInertPoll = (data) => Database.prototype.createInertPoll.call(self, data);
    indexer.indexerDb[method] = (...args) => Database.prototype[method].call(self, ...args);
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

                assertColumnRejects(c.table, c.field.toLowerCase(), bad);

                await new c.Handler(ctx).parse((c.format + '|' + bad + c.tail).split('|'), data, false);

                assert.strictEqual(data['STATUS'], 'invalid: ' + c.field + ' (format)');
                assert.deepStrictEqual(column(c.field.toLowerCase()), [0]);
                assertColumnAccepts(c.table, c.field.toLowerCase(), 0);
            });
        }

        for(const bad of BAD_MARIADB_INDEXES){
            it('refuses MariaDB-incompatible ' + c.field + "='" + bad + "' and stores the row under 0", async function () {
                const { indexer, ctx } = makeHandlerContext();
                const column = realWriter(indexer, c.writer, c.table);
                const data = createBaseData({ ACTION: c.action, FORMAT: c.format, SOURCE });

                assertColumnRejects(c.table, c.field.toLowerCase(), bad);

                await new c.Handler(ctx).parse((c.format + '|' + bad + c.tail).split('|'), data, false);

                assert.strictEqual(data['STATUS'], 'invalid: ' + c.field + ' (format)');
                assert.deepStrictEqual(column(c.field.toLowerCase()), [0]);
                assertColumnAccepts(c.table, c.field.toLowerCase(), 0);
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

                assertColumnRejects('bets', 'feed_action_index', bad);

                await new Bet(ctx).parse(['2', bad, '1', '1', 'm'], data, false);

                assert.strictEqual(data['STATUS'], 'invalid: FEED_ACTION_INDEX (format)');
                assert.deepStrictEqual(column('feed_action_index'), [0]);
                assertColumnAccepts('bets', 'feed_action_index', 0);
            });
        }

        for(const bad of BAD_MARIADB_INDEXES){
            it("refuses MariaDB-incompatible FEED_ACTION_INDEX='" + bad + "' and stores the row under 0", async function () {
                const { indexer, ctx } = makeHandlerContext();
                const column = realWriter(indexer, 'createBet', 'bets');
                const data = createBaseData({ ACTION: 'BET', FORMAT: 2, SOURCE });

                assertColumnRejects('bets', 'feed_action_index', bad);

                await new Bet(ctx).parse(['2', bad, '1', '1', 'm'], data, false);

                assert.strictEqual(data['STATUS'], 'invalid: FEED_ACTION_INDEX (format)');
                assert.deepStrictEqual(column('feed_action_index'), [0]);
                assertColumnAccepts('bets', 'feed_action_index', 0);
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

// DEPLOY v4: a CHUNK_INDEX or TOTAL_CHUNKS that cannot fit its unsigned column is stored as 0.
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

            for(const bad of ['-1', '4294967295.5', '4294967296']){
                it('refuses out-of-column ' + field + "='" + bad + "' and stores the row under 0", async function () {
                    const { carrier, column } = makeCarrier();
                    const data = createBaseData({ ACTION: 'DEPLOY', FORMAT: 4, SOURCE, ACTION_INDEX: 5 });

                    assertColumnRejects('deploy_chunks', field.toLowerCase(), bad);

                    await carrier.parse(['4', HASH].concat(wire(bad), ['aGVsbG8=']), data, null);

                    assert.match(data['STATUS'], new RegExp('^invalid: ' + field + ' \\('));
                    assert.deepStrictEqual(column(field.toLowerCase()), [0]);
                    assertColumnAccepts('deploy_chunks', field.toLowerCase(), 0);
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

        it('keeps a finite fractional CHUNK_INDEX that strict MariaDB rounds as before', async function () {
            const { carrier, column } = makeCarrier();
            const data = createBaseData({ ACTION: 'DEPLOY', FORMAT: 4, SOURCE, ACTION_INDEX: 5 });

            assertColumnAccepts('deploy_chunks', 'chunk_index', '1.5');

            await carrier.parse(['4', HASH, '1.5', '3', 'aGVsbG8='], data, null);

            assert.strictEqual(data['STATUS'], 'invalid: CHUNK_INDEX (format)');
            assert.deepStrictEqual(column('chunk_index'), [1.5]);
        });

        it('keeps the largest storable CHUNK_INDEX on its invalid row', async function () {
            const { carrier, column } = makeCarrier();
            const data = createBaseData({ ACTION: 'DEPLOY', FORMAT: 4, SOURCE, ACTION_INDEX: 5 });

            assertColumnAccepts('deploy_chunks', 'chunk_index', U32_MAX);

            await carrier.parse(['4', HASH, U32_MAX, '3', 'aGVsbG8='], data, null);

            assert.strictEqual(data['STATUS'], 'invalid: CHUNK_INDEX (out of range)');
            assert.deepStrictEqual(column('chunk_index'), [4294967295]);
        });

        for(const chunkIndex of [U32_MAX + '.4', '-0.4']){
            it("keeps a CHUNK_INDEX='" + chunkIndex + "' that strict MariaDB rounds into the column as before", async function () {
                const { carrier, column } = makeCarrier();
                const data = createBaseData({ ACTION: 'DEPLOY', FORMAT: 4, SOURCE, ACTION_INDEX: 5 });

                assertColumnAccepts('deploy_chunks', 'chunk_index', chunkIndex);

                await carrier.parse(['4', HASH, chunkIndex, '3', 'aGVsbG8='], data, null);

                assert.strictEqual(data['STATUS'], 'invalid: CHUNK_INDEX (format)');
                assert.deepStrictEqual(column('chunk_index'), [Number(chunkIndex)]);
            });
        }
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

        it("refuses a 251-character AMOUNT and stores the row under '0'", async function () {
            const { handler, column } = makeCustodyHandler();
            const data = createBaseData({ ACTION: action, FORMAT: 0, SOURCE });
            const amount = '9'.repeat(251);

            assertColumnRejects(table, 'amount', amount);

            await handler.parse(['0', '7', 'TEST', amount], data, false);

            assert.strictEqual(data['STATUS'], 'invalid: AMOUNT (format)');
            assert.deepStrictEqual(column('amount'), ['0']);
            assertColumnAccepts(table, 'amount', '0');
        });

        it('keeps a 250-character AMOUNT on its refused row', async function () {
            const { handler, column } = makeCustodyHandler();
            const data = createBaseData({ ACTION: action, FORMAT: 0, SOURCE });
            const amount = '9'.repeat(250);

            assertColumnAccepts(table, 'amount', amount);

            await handler.parse(['0', '7', 'TEST', amount], data, false);

            assert.strictEqual(data['STATUS'], 'invalid: AMOUNT (format)');
            assert.deepStrictEqual(column('amount'), [amount]);
        });

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

    describe('STAKE v1/v2 (stakes.signing_pubkey_id / amount)', function () {
        function makeStake(){
            const { indexer, ctx } = makeHandlerContext();
            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'XCHAIN', TICK_ID: 1, DECIMALS: 8 }));
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
            indexer.indexerDb.getActiveStakeByPubkey = sinon.stub().resolves(null);
            indexer.indexerDb.getDelegationByPubkey = sinon.stub().resolves(null);
            const column = realWriter(indexer, 'createStake', 'stakes');
            return { handler: new Stake(ctx), column };
        }

        it('stores an empty SIGNING_PUBKEY refusal under signing_pubkey_id 0', async function () {
            const { handler, column } = makeStake();
            const data = createBaseData({ ACTION: 'STAKE', FORMAT: 1, COIN: 'BTC', SOURCE });

            assertColumnRejects('stakes', 'signing_pubkey_id', null);

            await handler.parse(['1', '10', ''], data, null);

            assert.strictEqual(data['STATUS'], 'invalid: SIGNING_PUBKEY (required)');
            assert.deepStrictEqual(column('signing_pubkey_id'), [0]);
            assertColumnAccepts('stakes', 'signing_pubkey_id', 0);
        });

        it('stores a v2 empty SIGNING_PUBKEY refusal under signing_pubkey_id 0', async function () {
            const { handler, column } = makeStake();
            const data = createBaseData({ ACTION: 'STAKE', FORMAT: 2, COIN: 'BTC', SOURCE });

            assertColumnRejects('stakes', 'signing_pubkey_id', null);

            await handler.parse(['2', '10', ''], data, null);

            assert.strictEqual(data['STATUS'], 'invalid: SIGNING_PUBKEY (required)');
            assert.deepStrictEqual(column('signing_pubkey_id'), [0]);
            assertColumnAccepts('stakes', 'signing_pubkey_id', 0);
        });

        it("refuses a 251-character AMOUNT and stores the row under '0'", async function () {
            const { handler, column } = makeStake();
            const data = createBaseData({ ACTION: 'STAKE', FORMAT: 1, COIN: 'BTC', SOURCE });
            const amount = '9'.repeat(251);

            assertColumnRejects('stakes', 'amount', amount);

            await handler.parse(['1', amount, 'a'.repeat(64)], data, null);

            assert.strictEqual(data['STATUS'], 'invalid: AMOUNT (format)');
            assert.deepStrictEqual(column('amount'), ['0']);
            assertColumnAccepts('stakes', 'amount', '0');
        });

        it('keeps a 250-character AMOUNT on its refused row', async function () {
            const { handler, column } = makeStake();
            const data = createBaseData({ ACTION: 'STAKE', FORMAT: 1, COIN: 'BTC', SOURCE });
            const amount = '9'.repeat(250);

            assertColumnAccepts('stakes', 'amount', amount);

            await handler.parse(['1', amount, 'a'.repeat(64)], data, null);

            assert.strictEqual(data['STATUS'], 'invalid: insufficient funds (STAKE)');
            assert.deepStrictEqual(column('amount'), [amount]);
        });
    });

    describe('STAKE v3 (contract_stakes.signing_pubkey_id / amount)', function () {
        function makeContractStake(){
            const { indexer, ctx } = makeHandlerContext();
            indexer.indexerDb.getContract = sinon.stub().resolves({
                contract_index: 7, status_id: 1, cooldown_blocks: 6
            });
            indexer.indexerDb.getStatusString = sinon.stub().resolves('valid');
            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 }));
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
            indexer.indexerDb.getContractStakeOwner = sinon.stub().resolves(null);
            indexer.indexerDb.getPubkeyId = sinon.stub().resolves(null);
            const column = realWriter(indexer, 'createContractStake', 'contract_stakes');
            return { handler: new Stake(ctx), column };
        }

        it('stores an empty SIGNING_PUBKEY refusal under signing_pubkey_id 0', async function () {
            const { handler, column } = makeContractStake();
            const data = createBaseData({ ACTION: 'STAKE', FORMAT: 3, COIN: 'BTC', SOURCE });

            assertColumnRejects('contract_stakes', 'signing_pubkey_id', null);

            await handler.parse(['3', '10', '', '7', 'TEST'], data, null);

            assert.strictEqual(data['STATUS'], 'invalid: SIGNING_PUBKEY (required)');
            assert.deepStrictEqual(column('signing_pubkey_id'), [0]);
            assertColumnAccepts('contract_stakes', 'signing_pubkey_id', 0);
        });

        it("refuses a 251-character AMOUNT and stores the row under '0'", async function () {
            const { handler, column } = makeContractStake();
            const data = createBaseData({ ACTION: 'STAKE', FORMAT: 3, COIN: 'BTC', SOURCE });
            const amount = '9'.repeat(251);

            assertColumnRejects('contract_stakes', 'amount', amount);

            await handler.parse(['3', amount, 'a'.repeat(64), '7', 'TEST'], data, null);

            assert.strictEqual(data['STATUS'], 'invalid: AMOUNT (format)');
            assert.deepStrictEqual(column('amount'), ['0']);
            assertColumnAccepts('contract_stakes', 'amount', '0');
        });

        it('keeps a 250-character AMOUNT on its refused row', async function () {
            const { handler, column } = makeContractStake();
            const data = createBaseData({ ACTION: 'STAKE', FORMAT: 3, COIN: 'BTC', SOURCE });
            const amount = '9'.repeat(250);

            assertColumnAccepts('contract_stakes', 'amount', amount);

            await handler.parse(['3', amount, 'a'.repeat(64), '7', 'TEST'], data, null);

            assert.strictEqual(data['STATUS'], 'invalid: insufficient funds (TICK)');
            assert.deepStrictEqual(column('amount'), [amount]);
        });
    });

    describe('shared storage predicates', function () {
        it('keeps MariaDB-compatible BIGINT spellings outside the placeholder path', function () {
            const { indexer } = makeHandlerContext();
            for(const value of ['1e19', '-0', '1.5', '.5', '1e3', '+5', '05', U64_MAX, U64_MAX + '.4']){
                assertColumnAccepts('order_cancels', 'order_action_index', value);
                assert.strictEqual(indexer.util.storesAsNull(value, U64_MAX), false, value);
            }
        });

        it('bounds amount text at the VARCHAR(250) storage boundary', function () {
            const { indexer } = makeHandlerContext();
            const at = '9'.repeat(250);
            const over = '9'.repeat(251);

            assertColumnAccepts('sends', 'amount', at);
            assertColumnRejects('sends', 'amount', over);
            assert.strictEqual(indexer.util.isValidAmountFormat(0, at), true);
            assert.strictEqual(indexer.util.isValidAmountFormat(0, over), false);
        });

        it('keeps the develop unsigned-range outcomes around fractional boundaries', function () {
            const { indexer } = makeHandlerContext();
            for(const value of ['4294967295.3', '4294967295.4', '4.2949672953e9', '4294967295.5'])
                assert.strictEqual(indexer.util.exceedsUnsignedColumn(value, U32_MAX), true, value);
            assert.strictEqual(indexer.util.exceedsUnsignedColumn('-1e-400', U32_MAX), false);
            assert.strictEqual(indexer.util.exceedsUnsignedColumn('-1e-400', U64_MAX), false);
        });

        it('merges a storable SEND total formed from an overlong leading-zero leg', function () {
            const { indexer } = makeHandlerContext();
            const long = '0'.repeat(300) + '1';
            const ticks = { TEST: { TICK_ID: 1, DECIMALS: 8 } };
            const self = {
                config: indexer.config,
                util: indexer.util,
                gatedTotalsByTickId: sendLegs.gatedTotalsByTickId,
            };

            const sends = sendLegs.consolidateSendLegs.call(self,
                [['TEST', long, SOURCE, ''], ['TEST', '1', SOURCE, '']], ticks, { BLOCK_TIME: 1 });

            assert.deepStrictEqual(sends.map(leg => [leg[0], indexer.util.safeToString(leg[1]), leg[2], leg[3]]),
                [['TEST', '2', SOURCE, '']]);
        });

        it('includes an overlong leading-zero SEND leg in gated totals', function () {
            const { indexer } = makeHandlerContext();
            const long = '0'.repeat(300) + '1';
            const ticks = { TEST: { TICK_ID: 1, DECIMALS: 8 } };

            const totals = sendLegs.gatedTotalsByTickId.call({ util: indexer.util },
                [['TEST', long, SOURCE], ['TEST', '1', SOURCE]], ticks, { BLOCK_TIME: 1 });

            assert.strictEqual(indexer.util.safeToString(totals[SOURCE][1]), '2');
        });

        it('merges a storable DESTROY total formed from an overlong leading-zero leg', function () {
            const { indexer } = makeHandlerContext();
            const long = '0'.repeat(300) + '1';
            const ticks = { TEST: { TICK_ID: 1, DECIMALS: 8 } };

            const destroys = destroyLegs.consolidateLegs.call({ util: indexer.util },
                [['TEST', long, ''], ['TEST', '1', '']], ticks, { BLOCK_TIME: 1 });

            assert.deepStrictEqual(destroys.map(leg => [leg[0], indexer.util.safeToString(leg[1]), leg[2]]),
                [['TEST', '2', '']]);
        });

        it('does not rewrite overlong decimal text on a valid row', function () {
            const { indexer } = makeHandlerContext();
            const amount = '0'.repeat(300) + '1';

            const normalized = Database.prototype.normalizeDataValues.call(
                { util: indexer.util, config: indexer.config },
                { ACTION: 'VOTE', STATUS: 'valid', DEPOSIT: amount });

            assert.strictEqual(normalized.DEPOSIT, amount);
        });

        it("normalizes an invalid overlong amount to the existing '0' placeholder", async function () {
            const { indexer } = makeHandlerContext();
            const column = realWriter(indexer, 'createSend', 'sends');
            const over = '9'.repeat(251);

            await indexer.indexerDb.createSend({
                ACTION: 'SEND', ACTION_INDEX: 77, TICK: 'TEST', DESTINATION: SOURCE,
                AMOUNT: over, MEMO: '', STATUS: 'invalid: AMOUNT (format)'
            });

            assert.deepStrictEqual(column('amount'), ['0']);
            assertColumnAccepts('sends', 'amount', '0');
        });
    });

    describe('VOTE escrow amount storage', function () {
        function makeVote(){
            const { indexer, ctx } = makeHandlerContext();
            indexer.config.NETWORK = 'mainnet';
            indexer.indexerDb.getTokenInfo.resolves(createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 8 }));
            indexer.indexerDb.getAddressBalances.resolves({ 1: '100' });
            indexer.indexerDb.getContract = sinon.stub().resolves({ action_index: 5, status_id: 1 });
            indexer.indexerDb.getStatusString = sinon.stub().resolves('valid');
            const column = realWriter(indexer, 'createPoll', 'polls');
            const ledger = sinon.stub(indexer.util, 'processTransactionLedgerChanges').resolves();
            return { handler: new Vote(ctx), column, ledger };
        }

        function voteParams({ deposit = '', gasEscrow = '' }){
            const binding = gasEscrow !== '';
            return ['0', 'TEST', '200', 'yes,no', '', '', '', binding ? '0.1' : '', binding ? '1' : '', '', '', '', deposit,
                binding ? '5' : '', binding ? 'onResult' : '', '', '', gasEscrow];
        }

        for(const deposit of ['0'.repeat(60) + '1', '0'.repeat(300) + '1']){
            it('refuses a ' + deposit.length + '-character DEPOSIT before escrow and records an inert poll', async function () {
                const { handler, column, ledger } = makeVote();
                const data = createBaseData({ ACTION: 'VOTE', FORMAT: 0, BLOCK_INDEX: 100, ACTION_INDEX: 50, SOURCE });

                assertColumnRejects('polls', 'deposit_amount', deposit);

                await handler.parse(voteParams({ deposit }), data, null);

                assert.strictEqual(data.STATUS, 'invalid: DEPOSIT (format)');
                assert.deepStrictEqual(column('deposit_amount'), ['0']);
                assert.ok(ledger.notCalled);
            });
        }

        it('keeps a 60-character DEPOSIT on its valid poll', async function () {
            const { handler, column, ledger } = makeVote();
            const deposit = '0'.repeat(59) + '1';
            const data = createBaseData({ ACTION: 'VOTE', FORMAT: 0, BLOCK_INDEX: 100, ACTION_INDEX: 50, SOURCE });

            assertColumnAccepts('polls', 'deposit_amount', deposit);

            await handler.parse(voteParams({ deposit }), data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.deepStrictEqual(column('deposit_amount'), [deposit]);
            assert.ok(ledger.calledOnce);
        });

        it('keeps the funding verdict for an overlong DEPOSIT the SOURCE cannot cover', async function () {
            const { handler, column, ledger } = makeVote();
            // SOURCE holds TICK (id 1) but no GAS (id 2), so only the DEPOSIT funding fails.
            const gas = handler.config['GAS'];
            handler.indexerDb.getTokenInfo.callsFake(async (tick) =>
                createTokenInfo({ TICK: tick, TICK_ID: tick === gas ? 2 : 1, DECIMALS: 8 }));
            const deposit = '0'.repeat(300) + '1';
            const data = createBaseData({ ACTION: 'VOTE', FORMAT: 0, BLOCK_INDEX: 100, ACTION_INDEX: 50, SOURCE });

            await handler.parse(voteParams({ deposit }), data, null);

            assert.strictEqual(data.STATUS, 'invalid: insufficient funds (DEPOSIT)');
            assert.deepStrictEqual(column('deposit_amount'), ['0']);
            assert.ok(ledger.notCalled);
        });

        it('keeps the amount verdict for an overlong non-numeric DEPOSIT', async function () {
            const { handler, column } = makeVote();
            const data = createBaseData({ ACTION: 'VOTE', FORMAT: 0, BLOCK_INDEX: 100, ACTION_INDEX: 50, SOURCE });

            await handler.parse(voteParams({ deposit: 'x'.repeat(300) }), data, null);

            assert.strictEqual(data.STATUS, 'invalid: DEPOSIT (non-negative amount)');
            assert.deepStrictEqual(column('deposit_amount'), ['0']);
        });

        it('refuses an overlong GAS_ESCROW before escrow and records an inert poll', async function () {
            const { handler, column, ledger } = makeVote();
            const gasEscrow = '0'.repeat(300) + '1';
            const data = createBaseData({ ACTION: 'VOTE', FORMAT: 0, BLOCK_INDEX: 100, ACTION_INDEX: 51, SOURCE });

            assertColumnRejects('polls', 'gas_escrow', gasEscrow);

            await handler.parse(voteParams({ gasEscrow }), data, null);

            assert.strictEqual(data.STATUS, 'invalid: GAS_ESCROW (format)');
            assert.deepStrictEqual(column('gas_escrow'), [null]);
            assert.ok(ledger.notCalled);
        });

        it('keeps the amount verdict for an overlong non-numeric GAS_ESCROW', async function () {
            const { handler, column } = makeVote();
            const data = createBaseData({ ACTION: 'VOTE', FORMAT: 0, BLOCK_INDEX: 100, ACTION_INDEX: 51, SOURCE });

            await handler.parse(voteParams({ gasEscrow: 'x'.repeat(300) }), data, null);

            assert.strictEqual(data.STATUS, 'invalid: GAS_ESCROW (non-negative amount)');
            assert.deepStrictEqual(column('gas_escrow'), [null]);
        });
    });
});
