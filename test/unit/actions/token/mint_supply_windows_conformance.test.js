'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC, https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const Mint          = require('../../../../src/actions/mint/index.js');
const mintQueries   = require('../../../../src/db/mints/index.js');
const creditQueries = require('../../../../src/db/credits/index.js');
const lifecycle     = require('../../../../src/hub/table_lifecycle.js');
const rollbackSql   = require('../../../../src/db/rollback/rederive.js');
const rollbackCommit = require('../../../../src/rollback/commit.js');

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

function makeActionsCtx(indexer) {
    return {
        config:    indexer.config,
        util:      indexer.util,
        mapper:    indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

function statefulMintHarness(overrides = {}) {
    const indexer = createMockIndexer();
    const handler = new Mint(makeActionsCtx(indexer));
    const util    = indexer.util;
    const db      = indexer.indexerDb;
    const state   = {
        baseSupply: String(overrides.baseSupply || '0'),
        maxSupply: String(overrides.maxSupply || '100'),
        addressCap: overrides.addressCap === undefined ? '100' : overrides.addressCap,
        startBlock: overrides.startBlock || 0,
        stopBlock: overrides.stopBlock || 0,
        issues: [],
        mints: [],
        credits: [],
        debits: [],
    };

    function rowsBefore(rows, actionIndex) {
        return rows.filter(row => Number(row.actionIndex) < Number(actionIndex));
    }

    function sum(rows) {
        return util.bcstr(rows.reduce((total, row) => util.bcadd(total, row.amount, 0), '0'));
    }

    function supplyBefore(actionIndex) {
        return util.bcstr(util.bcsub(
            util.bcadd(state.baseSupply, sum(rowsBefore(state.credits, actionIndex)), 0),
            sum(rowsBefore(state.debits, actionIndex)),
            0
        ));
    }

    function lockBefore(actionIndex) {
        return rowsBefore(state.issues, actionIndex).reduce(
            (value, row) => row.lockMint === undefined ? value : row.lockMint,
            0
        );
    }

    function upsert(rows, row, sameKey) {
        const existing = rows.findIndex(item => sameKey(item, row));
        if(existing === -1)
            rows.push(row);
        else
            rows[existing] = row;
    }

    db.getTokenInfo.callsFake(async (tick, blockIndex, actionIndex) => createTokenInfo({
        TICK: 'TEST', TICK_ID: 1, BLOCK_INDEX: 1, DECIMALS: 0,
        MAX_SUPPLY: state.maxSupply, MAX_MINT: '100',
        MINT_ADDRESS_MAX: state.addressCap,
        MINT_START_BLOCK: state.startBlock,
        MINT_STOP_BLOCK: state.stopBlock,
        LOCK_MINT: lockBefore(actionIndex),
        SUPPLY: supplyBefore(actionIndex),
    }));
    db.getSelfMintedAmount.callsFake(async (tick, address, actionIndex) => sum(
        rowsBefore(state.mints, actionIndex).filter(row => row.source === address && row.status === 'valid')
    ));
    db.validTickerBeforeTxIndex.resolves(true);
    db.isActionAllowed.resolves(true);
    db.createMint.callsFake(async row => upsert(state.mints, {
        actionIndex: row.ACTION_INDEX,
        source: row.SOURCE,
        amount: String(row.AMOUNT),
        status: row.STATUS,
    }, (a, b) => a.actionIndex === b.actionIndex));
    db.createCredit.callsFake(async (actionIndex, tick, amount, address) => upsert(state.credits, {
        actionIndex, tick, amount: String(amount), address,
    }, (a, b) => a.actionIndex === b.actionIndex && a.tick === b.tick && a.address === b.address));
    db.createDebit.callsFake(async (actionIndex, tick, amount, address) => upsert(state.debits, {
        actionIndex, tick, amount: String(amount), address,
    }, (a, b) => a.actionIndex === b.actionIndex && a.tick === b.tick && a.address === b.address));

    async function mint(actionIndex, amount, blockIndex = 100, batchPosition) {
        const data = createBaseData({
            ACTION: 'MINT', FORMAT: 0, ACTION_INDEX: actionIndex,
            BLOCK_INDEX: blockIndex, SOURCE,
        });
        if(batchPosition !== undefined)
            data.BATCH_POSITION = batchPosition;
        await handler.parse(['0', 'TEST', String(amount), '', ''], data, null);
        return data;
    }

    function rollbackFrom(actionIndex) {
        for(const name of ['issues', 'mints', 'credits', 'debits'])
            state[name] = state[name].filter(row => Number(row.actionIndex) < Number(actionIndex));
    }

    return { indexer, handler, state, mint, rollbackFrom, supplyBefore };
}

describe('MINT supply windows and counters @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('uses one inclusive rule at both exact window boundaries', async function () {
        const h = statefulMintHarness({ startBlock: 100, stopBlock: 200 });

        assert.strictEqual((await h.mint(10, 1, 99)).STATUS, 'invalid: MINT_START_BLOCK');
        assert.strictEqual((await h.mint(11, 1, 100)).STATUS, 'valid');
        assert.strictEqual((await h.mint(12, 1, 200)).STATUS, 'valid');
        assert.strictEqual((await h.mint(13, 1, 201)).STATUS, 'invalid: MINT_STOP_BLOCK');
    });

    it('counts prior same-block BATCH-position mints once and the current mint once', async function () {
        const h = statefulMintHarness({ maxSupply: '1000', addressCap: '100' });

        assert.strictEqual((await h.mint(20, 60, 100, 0)).STATUS, 'valid');
        assert.strictEqual((await h.mint(21, 40, 100, 1)).STATUS, 'valid');
        assert.strictEqual((await h.mint(22, 1, 100, 2)).STATUS, 'invalid: mint exceeds MINT_ADDRESS_MAX');

        assert.deepStrictEqual(h.state.mints.map(row => row.status), ['valid', 'valid', 'invalid: mint exceeds MINT_ADDRESS_MAX']);
        assert.strictEqual(h.state.credits.length, 2);
        assert.strictEqual(h.supplyBefore(23), '100');
    });

    it('rejects the same-block mint that would cumulatively exceed MAX_SUPPLY', async function () {
        const h = statefulMintHarness({ baseSupply: '80', maxSupply: '100', addressCap: null });

        assert.strictEqual((await h.mint(30, 15)).STATUS, 'valid');
        assert.strictEqual((await h.mint(31, 6)).STATUS, 'invalid: mint exceeds MAX_SUPPLY');
        assert.strictEqual(h.supplyBefore(32), '95');
        assert.strictEqual((await h.mint(32, 5)).STATUS, 'valid');
        assert.strictEqual(h.supplyBefore(33), '100');
    });

    it('applies LOCK_MINT to the next action and not to an earlier action', async function () {
        const h = statefulMintHarness({ addressCap: null });

        assert.strictEqual((await h.mint(40, 1)).STATUS, 'valid');
        h.state.issues.push({ actionIndex: 41, lockMint: 1 });
        assert.strictEqual((await h.mint(42, 1)).STATUS, 'invalid: LOCK_MINT');
        assert.strictEqual(h.supplyBefore(43), '1');
    });

    it('records a refusal but changes no ledger balance, supply, or valid-mint total', async function () {
        const h = statefulMintHarness({ baseSupply: '99', maxSupply: '100', addressCap: '100' });

        const refused = await h.mint(50, 2);
        assert.strictEqual(refused.STATUS, 'invalid: mint exceeds MAX_SUPPLY');
        assert.strictEqual(h.state.mints.length, 1);
        assert.strictEqual(h.state.credits.length, 0);
        assert.strictEqual(h.state.debits.length, 0);
        assert.strictEqual(h.supplyBefore(51), '99');
        assert.strictEqual(await h.indexer.indexerDb.getSelfMintedAmount('TEST', SOURCE, 51), '0');
        assert.strictEqual(h.indexer.indexerDb.updateBalances.callCount, 0);
        assert.strictEqual(h.indexer.indexerDb.updateTokens.callCount, 0);
    });

    it('restores mint and supply totals exactly after rollback and replay', async function () {
        const h = statefulMintHarness({ addressCap: '100' });

        assert.strictEqual((await h.mint(60, 10)).STATUS, 'valid');
        assert.strictEqual((await h.mint(61, 20)).STATUS, 'valid');
        assert.strictEqual(h.supplyBefore(62), '30');
        assert.strictEqual(await h.indexer.indexerDb.getSelfMintedAmount('TEST', SOURCE, 62), '30');

        h.rollbackFrom(61);
        assert.strictEqual(h.supplyBefore(62), '10');
        assert.strictEqual(await h.indexer.indexerDb.getSelfMintedAmount('TEST', SOURCE, 62), '10');
        assert.strictEqual((await h.mint(61, 20)).STATUS, 'valid');
        assert.strictEqual(h.supplyBefore(62), '30');
        assert.strictEqual(await h.indexer.indexerDb.getSelfMintedAmount('TEST', SOURCE, 62), '30');

        h.rollbackFrom(60);
        assert.strictEqual(h.supplyBefore(62), '0');
        assert.strictEqual(await h.indexer.indexerDb.getSelfMintedAmount('TEST', SOURCE, 62), '0');
    });
});

describe('MINT query and rollback scope @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('scopes mint totals and token supply strictly before the current action', async function () {
        const indexer = createMockIndexer();
        const seen = [];
        const db = {
            util: indexer.util,
            config: indexer.config,
            blockIndex: 100,
            createTicker: async () => 7,
            createAddress: async () => 9,
            getTokenDecimalPrecision: async () => 0,
            async doQuery(sql, args) {
                seen.push({ sql, args: args.slice() });
                if(sql.includes('FROM\n                mints m1'))
                    return [{ amount: '40', decimals: 0 }];
                if(sql.includes('FROM\n                    credits m'))
                    return [{ credits: '95' }];
                if(sql.includes('FROM\n                    debits m'))
                    return [{ debits: null }];
                if(sql.includes('FROM\n                    escrows m'))
                    return [{ escrows: null }];
                throw new Error('unexpected query');
            },
        };

        assert.strictEqual(String(await mintQueries.getSelfMintedAmount.call(db, 'TEST', SOURCE, 71)), '40');
        assert.strictEqual(String(await creditQueries.getTokenSupply.call(db, 'TEST', 100, 71)), '95');

        assert.match(seen[0].sql, /s1\.status='valid'/);
        assert.match(seen[0].sql, /m1\.action_index < \?/);
        assert.deepStrictEqual(seen[0].args, [7, 9, 71]);
        for(const query of seen.slice(1)) {
            assert.match(query.sql, /a\.block_index <= \?/);
            assert.match(query.sql, /m\.action_index < \?/);
            assert.deepStrictEqual(query.args, [7, 100, 71]);
        }
    });

    it('purges every mint counter input and recomputes both derived projections', async function () {
        const dataTables = lifecycle.rollbackTables().dataTables;
        for(const table of ['actions', 'mints', 'credits', 'debits', 'issues'])
            assert.ok(dataTables.includes(table), table + ' must be action-scoped');

        const writes = [];
        const db = { doQuery: async (sql, args) => writes.push({ sql, args }) };
        await rollbackSql.purgeActionScopedTables(db, ['mints', 'credits', 'debits', 'issues'], 80);
        assert.deepStrictEqual(writes.map(row => row.sql), [
            'DELETE FROM mints WHERE action_index >= ?',
            'DELETE FROM credits WHERE action_index >= ?',
            'DELETE FROM debits WHERE action_index >= ?',
            'DELETE FROM issues WHERE action_index >= ?',
        ]);
        assert.ok(writes.every(row => row.args[0] === 80));

        const projectionDb = {
            suppressIndexIdCreation: false,
            updateBalances: sinon.stub().resolves(),
            updateTokens: sinon.stub().resolves(),
            updateMarkets: sinon.stub().resolves(),
            sanityCheck: sinon.stub().resolves(),
        };
        await rollbackCommit.refreshDerivedProjections.call(
            { indexerDb: projectionDb }, 80, { [SOURCE]: ['TEST'] }, ['TEST'], []
        );
        sinon.assert.calledOnceWithExactly(projectionDb.updateBalances, [SOURCE], true);
        sinon.assert.calledOnceWithExactly(projectionDb.updateTokens, ['TEST'], true);
        sinon.assert.calledOnceWithExactly(projectionDb.sanityCheck, 80);
        assert.strictEqual(projectionDb.suppressIndexIdCreation, false);
    });
});
