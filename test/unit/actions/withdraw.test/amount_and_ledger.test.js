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
// WITHDRAW AMOUNT format, the contract balance check and the ledger legs a
// withdraw writes (contract debited, SOURCE credited, none on an invalid one).
// Part of the WITHDRAW suite; see ../withdraw.test.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { SOURCE, CONTRACT_INDEX, TICK, CONTRACT_ADDRESS, makeData, makeToken, makeWithdrawContext } = require('./helpers/withdraw_context.js');

let indexer, handler;

// Each test starts from its own mock indexer and WITHDRAW handler.
function freshWithdraw() {
    ({ indexer, handler } = makeWithdrawContext());
}

// -----------------------------------------------------------------------
// AMOUNT validations
// -----------------------------------------------------------------------

describe('Withdraw handler @regression @tier2', function () {
    beforeEach(freshWithdraw);
    afterEach(() => sinon.restore());

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
});

// -----------------------------------------------------------------------
// Contract balance validation
// -----------------------------------------------------------------------

describe('Withdraw handler @regression @tier2', function () {
    beforeEach(freshWithdraw);
    afterEach(() => sinon.restore());

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
});

// -----------------------------------------------------------------------
// Ledger changes
// -----------------------------------------------------------------------

describe('Withdraw handler @regression @tier2', function () {
    beforeEach(freshWithdraw);
    afterEach(() => sinon.restore());

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
