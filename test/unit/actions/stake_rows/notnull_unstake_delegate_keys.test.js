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
// UNSTAKE and DELEGATE refuse an empty SIGNING_PUBKEY and still write their row. The four
// writers bind the key id into a NOT NULL column, and an empty key has no index_pubkeys id, so
// the refused row has to land under the 0 placeholder instead of NULL. Each case runs the
// production handler and the production Database writer against the table's own src/sql DDL
// on node:sqlite, which enforces NOT NULL the way MariaDB does.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData } = require('../../../fixtures/mocks');
const { makeMigrationDb } = require('../../../helpers/sqlMigrationDb');
const Database = require('../../../../src/db');
const Unstake  = require('../../../../src/actions/unstake/index.js');
const Delegate = require('../../../../src/actions/delegate/index.js');

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

// Route one Database writer to the real method over a sqlite table holding the shipped DDL.
// The interning helpers answer 1 except an empty pubkey, which has no id, as in production.
function realWriter(indexer, method, table){
    const sql  = makeMigrationDb([table + '.sql']);
    const self = {
        util:   indexer.util,
        config: indexer.config,
        normalizeDataValues: Database.prototype.normalizeDataValues,
        fitRefusedIntegerFields: Database.prototype.fitRefusedIntegerFields,
        nullRefusedPrefixedFields: Database.prototype.nullRefusedPrefixedFields,
        createStatus: async () => 1,
        createTicker: async () => 1,
        getAddressId: async () => 1,
        getOrCreatePubkeyId: async (pubkey) => indexer.util.isNull(pubkey) ? null : 1,
        async doQuery(query, args){
            const stmt  = sql.db.prepare(query);
            const bound = (args || []).map(v => (v === undefined ? null : v));
            if(/^\s*SELECT/i.test(query))
                return stmt.all(...bound);
            stmt.run(...bound);
            return [];
        },
    };
    indexer.indexerDb[method] = (...args) => Database.prototype[method].call(self, ...args);
    return { self, rows: (column) => sql.rows('SELECT ' + column + ' AS v FROM ' + table).map(r => r.v) };
}

function makeHandlerContext(){
    const indexer = createMockIndexer({});
    const ctx = {
        config: indexer.config, util: indexer.util, mapper: indexer.mapper,
        decoderDb: indexer.decoderDb, indexerDb: indexer.indexerDb, hubDb: null,
        protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
        processAction: sinon.stub().resolves(),
    };
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.getTickerId.resolves(99);
    indexer.util.resetLists();
    return { indexer, ctx };
}

const CASES = [
    { name: 'UNSTAKE v0',   Handler: Unstake,  action: 'UNSTAKE',  format: 0, params: ['0', ''],                 writer: 'createUnstake',            table: 'unstakes' },
    { name: 'UNSTAKE v1',   Handler: Unstake,  action: 'UNSTAKE',  format: 1, params: ['1', '', '7', 'TEST'],    writer: 'createContractUnstake',    table: 'contract_unstakes' },
    { name: 'DELEGATE v0',  Handler: Delegate, action: 'DELEGATE', format: 0, params: ['0', ''],                 writer: 'createDelegation',         table: 'delegations' },
    { name: 'DELEGATE v1',  Handler: Delegate, action: 'DELEGATE', format: 1, params: ['1', '', '7', 'TEST'],    writer: 'createContractDelegation', table: 'contract_delegations' },
];

describe('UNSTAKE and DELEGATE empty SIGNING_PUBKEY refusal @regression @tier2', function () {
    afterEach(() => sinon.restore());

    for(const c of CASES){
        describe(c.name + ' (' + c.table + '.signing_pubkey_id)', function () {
            function make(){
                const { indexer, ctx } = makeHandlerContext();
                const writer = realWriter(indexer, c.writer, c.table);
                return { handler: new c.Handler(ctx), writer };
            }

            it('stores an empty SIGNING_PUBKEY refusal under signing_pubkey_id 0', async function () {
                const { handler, writer } = make();
                const data = createBaseData({ ACTION: c.action, FORMAT: c.format, COIN: 'BTC', SOURCE });

                await handler.parse(c.params, data, null);

                assert.strictEqual(data['STATUS'], 'invalid: SIGNING_PUBKEY (required)');
                assert.deepStrictEqual(writer.rows('signing_pubkey_id'), [0]);
            });

            // An earlier refusal routes every format through the v0 dispatch, so only v0 owns the case
            if(c.format === 0) it('stores a refusal that names no key under 0 when an earlier check already failed', async function () {
                const { handler, writer } = make();
                const data = createBaseData({ ACTION: c.action, FORMAT: c.format, COIN: 'BTC', SOURCE });

                await handler.parse(c.params, data, 'invalid: ACTION (earlier refusal)');

                assert.deepStrictEqual(writer.rows('signing_pubkey_id'), [0]);
            });

            it('keeps a real key on its refused row as its interned id', async function () {
                const { handler, writer } = make();
                const data = createBaseData({ ACTION: c.action, FORMAT: c.format, COIN: 'BTC', SOURCE });
                const params = c.params.slice();
                params[1] = 'not-hex';

                await handler.parse(params, data, null);

                assert.strictEqual(data['STATUS'], 'invalid: SIGNING_PUBKEY (format)');
                assert.deepStrictEqual(writer.rows('signing_pubkey_id'), [1]);
            });

            it('still refuses a valid row that carries no key id, so the NOT NULL column can fail', async function () {
                const { indexer } = makeHandlerContext();
                const writer = realWriter(indexer, c.writer, c.table);
                const data = createBaseData({
                    ACTION: c.action, FORMAT: c.format, COIN: 'BTC', SOURCE, STATUS: 'valid',
                    SIGNING_PUBKEY: '', TARGET_CONTRACT_INDEX: 7, TICK: 'TEST', AMOUNT: '1',
                    COOLDOWN_END_BLOCK: 10, ACTIVATION_BLOCK: 10, ACTION_INDEX: 5, BLOCK_INDEX: 1,
                });

                await assert.rejects(() => Database.prototype[c.writer].call(writer.self, data), /NOT NULL/i);
                assert.deepStrictEqual(writer.rows('signing_pubkey_id'), []);
            });
        });
    }
});

describe('DELEGATE v2 revoke with an empty SIGNING_PUBKEY below the no-reinsert flag day @regression @tier2', function () {
    afterEach(() => sinon.restore());

    it('stores the refused legacy revoke row under signing_pubkey_id 0', async function () {
        const { indexer, ctx } = makeHandlerContext();
        ctx.protocolChanges.isEnabled = sinon.stub().resolves(false);
        const writer = realWriter(indexer, 'createDelegation', 'delegations');
        indexer.indexerDb.createRevokeDelegation = (data) => indexer.indexerDb.createDelegation(data);
        const handler = new Delegate(ctx);
        const data = createBaseData({ ACTION: 'DELEGATE', FORMAT: 2, COIN: 'BTC', SOURCE });

        await handler.parse(['2', ''], data, null);

        assert.strictEqual(data['STATUS'], 'invalid: SIGNING_PUBKEY (required)');
        assert.deepStrictEqual(writer.rows('signing_pubkey_id'), [0]);
    });
});
