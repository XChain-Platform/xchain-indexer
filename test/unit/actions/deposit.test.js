// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Deposit = require('../../../src/actions/deposit.js');

describe('Deposit (DEPOSIT) @regression @tier2', function () {
    let indexer, actionsCtx, handler;

    const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
    const CONTRACT_INDEX = '7';

    function addDepositStubs(db) {
        db.getContract     = sinon.stub().resolves({ contract_index: 7, status_id: 1 });
        db.getStatusString = sinon.stub().resolves('valid');
        db.createDeposit   = sinon.stub().resolves();
    }

    function makeToken(overrides = {}) {
        return createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0, ...overrides });
    }

    function depositData(overrides = {}) {
        return createBaseData({ ACTION: 'DEPOSIT', FORMAT: 0, SOURCE, ...overrides });
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        addDepositStubs(indexer.indexerDb);
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getTokenInfo.resolves(makeToken());
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });

        actionsCtx = {
            config:    indexer.config,
            util:      indexer.util,
            mapper:    indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
        };
        handler = new Deposit(actionsCtx);
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('format validation', function () {

        it('rejects an unknown VERSION', async function () {
            const data = depositData({ FORMAT: 9 });
            await handler.parse(['9', CONTRACT_INDEX, 'TEST', '10'], data, null);
            assert.ok(String(data['STATUS']).includes('VERSION'));
        });

        it('accepts FORMAT 0', async function () {
            const data = depositData({ FORMAT: 0 });
            await handler.parse(['0', CONTRACT_INDEX, 'TEST', '10'], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

    });

    describe('contract validations', function () {

        it('rejects missing CONTRACT_ACTION_INDEX', async function () {
            const data = depositData({ FORMAT: 0 });
            await handler.parse(['0', '', 'TEST', '10'], data, null);
            assert.ok(String(data['STATUS']).includes('CONTRACT_ACTION_INDEX'));
        });

        it('rejects when contract does not exist', async function () {
            indexer.indexerDb.getContract.resolves(null);
            const data = depositData({ FORMAT: 0 });
            await handler.parse(['0', CONTRACT_INDEX, 'TEST', '10'], data, null);
            assert.ok(String(data['STATUS']).includes('CONTRACT_ACTION_INDEX'));
        });

        it('rejects when contract is not active (status != valid)', async function () {
            indexer.indexerDb.getStatusString.resolves('invalid');
            const data = depositData({ FORMAT: 0 });
            await handler.parse(['0', CONTRACT_INDEX, 'TEST', '10'], data, null);
            assert.ok(String(data['STATUS']).includes('not active'));
        });

    });

    describe('token validations', function () {

        it('rejects when TICK does not exist', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            const data = depositData({ FORMAT: 0 });
            await handler.parse(['0', CONTRACT_INDEX, 'UNKNOWN', '10'], data, null);
            assert.ok(String(data['STATUS']).includes('TICK'));
        });

        it('rejects AMOUNT of zero', async function () {
            const data = depositData({ FORMAT: 0 });
            await handler.parse(['0', CONTRACT_INDEX, 'TEST', '0'], data, null);
            assert.ok(String(data['STATUS']).includes('AMOUNT'));
        });

        it('rejects malformed AMOUNT', async function () {
            indexer.indexerDb.getTokenInfo.resolves(makeToken({ DECIMALS: 0 }));
            const data = depositData({ FORMAT: 0 });
            await handler.parse(['0', CONTRACT_INDEX, 'TEST', '1.5'], data, null);  // decimals=0 → no fraction
            assert.ok(String(data['STATUS']).includes('AMOUNT'));
        });

        it('rejects when SOURCE has insufficient balance', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 1: '5' }); // only 5, want 10
            const data = depositData({ FORMAT: 0 });
            await handler.parse(['0', CONTRACT_INDEX, 'TEST', '10'], data, null);
            assert.ok(String(data['STATUS']).includes('insufficient funds'));
        });

    });

    describe('sleeping checks', function () {

        it('rejects when SOURCE is sleeping', async function () {
            indexer.indexerDb.isActionAllowed.callsFake((addr, tick) => {
                if (addr && !tick) return Promise.resolve(false);
                return Promise.resolve(true);
            });
            const data = depositData({ FORMAT: 0 });
            await handler.parse(['0', CONTRACT_INDEX, 'TEST', '10'], data, null);
            assert.ok(String(data['STATUS']).includes('sleeping'));
        });

        it('rejects when TICK is sleeping', async function () {
            indexer.indexerDb.isActionAllowed.callsFake((addr, tick) => {
                if (!addr && tick) return Promise.resolve(false);
                return Promise.resolve(true);
            });
            const data = depositData({ FORMAT: 0 });
            await handler.parse(['0', CONTRACT_INDEX, 'TEST', '10'], data, null);
            assert.ok(String(data['STATUS']).includes('sleeping'));
        });

    });

    describe('valid deposit', function () {

        it('createDeposit called with valid status', async function () {
            const data = depositData({ FORMAT: 0 });
            await handler.parse(['0', CONTRACT_INDEX, 'TEST', '10'], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createDeposit.calledOnce);
        });

        it('debit created from SOURCE and credit to contract address', async function () {
            const data = depositData({ FORMAT: 0 });
            await handler.parse(['0', CONTRACT_INDEX, 'TEST', '10'], data, null);
            assert.ok(indexer.indexerDb.createDebit.calledOnce);
            assert.ok(indexer.indexerDb.createCredit.calledOnce);
            const [, debitTick, , debitAddr] = indexer.indexerDb.createDebit.firstCall.args;
            assert.strictEqual(debitTick, 'TEST');
            assert.strictEqual(debitAddr, SOURCE);
        });

        it('updateBalances and updateTokens called after parse', async function () {
            const data = depositData({ FORMAT: 0 });
            await handler.parse(['0', CONTRACT_INDEX, 'TEST', '10'], data, null);
            assert.ok(indexer.indexerDb.updateBalances.calledOnce);
            assert.ok(indexer.indexerDb.updateTokens.calledOnce);
        });

        it('mapper.createMappings called after parse', async function () {
            const data = depositData({ FORMAT: 0 });
            await handler.parse(['0', CONTRACT_INDEX, 'TEST', '10'], data, null);
            assert.ok(indexer.mapper.createMappings.calledOnce);
        });

    });

    describe('record always created', function () {

        it('createDeposit called even on invalid (TICK not found)', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            const data = depositData({ FORMAT: 0 });
            await handler.parse(['0', CONTRACT_INDEX, 'UNKNOWN', '10'], data, null);
            assert.ok(indexer.indexerDb.createDeposit.calledOnce);
        });

        it('pre-existing error propagates to invalid status', async function () {
            const data = depositData({ FORMAT: 0 });
            await handler.parse(['0', CONTRACT_INDEX, 'TEST', '10'], data, 'invalid: pre-existing');
            assert.ok(String(data['STATUS']).includes('invalid'));
        });

    });
});
