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

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Withdraw = require('../../../src/actions/withdraw.js');

const SOURCE           = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const CONTRACT_INDEX   = '7';
const TICK             = 'TEST';
const BLOCK            = 100;
// Contract address as computed by the handler: 'C:BTC:<contract_action_index>'
const CONTRACT_ADDRESS = 'C:BTC:' + CONTRACT_INDEX;

function makeActionsCtx(indexer) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined:  sinon.stub().returns(true),
            isEnabled:  sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

function makeData(overrides = {}) {
    return createBaseData(Object.assign({ ACTION: 'WITHDRAW', FORMAT: 0, COIN: 'BTC', BLOCK_INDEX: BLOCK, SOURCE }, overrides));
}

function makeToken(overrides = {}) {
    return createTokenInfo(Object.assign({ TICK, TICK_ID: 1, DECIMALS: 0 }, overrides));
}

describe('Withdraw handler @regression @tier2', function () {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        handler    = new Withdraw(actionsCtx);

        // Extra stubs not present in default mock
        indexer.indexerDb.createWithdrawal = sinon.stub().resolves();
        indexer.indexerDb.getContract      = sinon.stub().resolves(null);

        // Default: contract exists and caller is owner (source_id matches)
        indexer.indexerDb.getContract.resolves({ source_id: 42 });
        indexer.indexerDb.getAddressId.resolves(42);

        // Default: token exists
        indexer.indexerDb.getTokenInfo.resolves(makeToken());

        // Default: contract has sufficient balance
        // getAddressBalances is called with the contract address
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });

        // Default: source not sleeping
        indexer.indexerDb.isActionAllowed.resolves(true);

        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('FORMAT validation', function () {

        it('unknown format → invalid', async function () {
            const params = ['99', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 99 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('null format → invalid', async function () {
            const params = ['', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: null });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('pre-existing error is preserved', async function () {
            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, 'invalid: upstream');

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });

    describe('valid withdraw', function () {

        it('valid withdraw → STATUS valid, createWithdrawal called', async function () {
            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.ok(indexer.indexerDb.createWithdrawal.calledOnce);
        });

        it('valid withdraw → mapper.createMappings called', async function () {
            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(indexer.mapper.createMappings.calledOnce);
        });

        it('valid withdraw → updateBalances called', async function () {
            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.updateBalances.calledOnce);
        });

        it('valid withdraw → updateTokens called', async function () {
            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.updateTokens.calledOnce);
        });
    });

    describe('CONTRACT_ACTION_INDEX validations', function () {

        it('missing CONTRACT_ACTION_INDEX → invalid', async function () {
            const params = ['0', '', TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('CONTRACT_ACTION_INDEX'));
        });

        it('contract not found → invalid', async function () {
            indexer.indexerDb.getContract.resolves(null);

            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('CONTRACT_ACTION_INDEX'));
        });

        it('caller is not contract owner → invalid', async function () {
            indexer.indexerDb.getContract.resolves({ source_id: 99 }); // owned by 99
            indexer.indexerDb.getAddressId.resolves(42);               // caller is 42

            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('not contract owner'));
        });

        it('source address id null → not owner → invalid', async function () {
            indexer.indexerDb.getContract.resolves({ source_id: 42 });
            indexer.indexerDb.getAddressId.resolves(null);

            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('not contract owner'));
        });

        it('createWithdrawal always called even on invalid contract', async function () {
            indexer.indexerDb.getContract.resolves(null);

            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
            assert.ok(indexer.indexerDb.createWithdrawal.calledOnce);
        });
    });

    describe('TICK validations', function () {

        it('TICK not found → invalid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);

            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('TICK'));
        });
    });

    describe('AMOUNT validations', function () {

        it('zero AMOUNT → invalid', async function () {
            const params = ['0', CONTRACT_INDEX, TICK, '0'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('AMOUNT'));
        });

        it('fractional AMOUNT for 0-decimal token → invalid (format check)', async function () {
            const params = ['0', CONTRACT_INDEX, TICK, '1.5'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('AMOUNT'));
        });

        it('valid integer AMOUNT for 0-decimal token → valid', async function () {
            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('valid decimal AMOUNT for 8-decimal token → valid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(makeToken({ DECIMALS: 8, TICK_ID: 1 }));
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000.00000000' });

            const params = ['0', CONTRACT_INDEX, TICK, '50.12345678'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    describe('contract balance validation', function () {

        it('insufficient contract balance → invalid', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 1: '50' }); // only 50, want 100

            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('insufficient contract balance'));
        });

        it('zero contract balance → invalid', async function () {
            indexer.indexerDb.getAddressBalances.resolves({});

            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('insufficient contract balance'));
        });

        it('exact balance → valid', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 1: '100' });

            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    describe('SOURCE sleeping', function () {

        it('SOURCE sleeping → invalid', async function () {
            indexer.indexerDb.isActionAllowed.resolves(false);

            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('sleeping'));
        });
    });

    describe('ledger changes on valid withdraw', function () {

        it('valid withdraw: debit from contract address, credit to SOURCE', async function () {
            const ledgerSpy = sinon.spy(indexer.util, 'processTransactionLedgerChanges');

            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(ledgerSpy.calledOnce);
            const [, , credits, debits] = ledgerSpy.firstCall.args;

            const sourceCredit = credits.find(c => c[2] === SOURCE);
            assert.ok(sourceCredit, 'SOURCE should receive credit');

            const contractDebit = debits.find(d => d[2] === CONTRACT_ADDRESS);
            assert.ok(contractDebit, 'Contract address should be debited');
        });

        it('invalid withdraw: no ledger changes (no debit or credit)', async function () {
            const ledgerSpy = sinon.spy(indexer.util, 'processTransactionLedgerChanges');

            indexer.indexerDb.getTokenInfo.resolves(null); // invalid: no token

            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(ledgerSpy.calledOnce);
            const [, , credits, debits] = ledgerSpy.firstCall.args;
            assert.strictEqual(credits.length, 0);
            assert.strictEqual(debits.length, 0);
        });
    });
});
