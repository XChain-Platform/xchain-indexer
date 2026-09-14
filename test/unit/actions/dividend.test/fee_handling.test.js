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
// DIVIDEND fee handling: the legacy fee model, the DIVIDEND_TICK balance
// check and the native-coin payment branches.
// Part of the Dividend suite; see ../dividend.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const { SOURCE, HOLDER1, HOLDER2, useDividendHarness } = require('./helpers/dividend_harness.js');

// The harness under test. useDividendHarness rebuilds it before every test
// and restores sinon after it; bind copies it into the names the tests read.
let indexer, actionsCtx, handler;
const bind = (h) => { ({ indexer, actionsCtx, handler } = h); };

function setupValid() {
    indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 }));
    indexer.indexerDb.getTokenInfo.withArgs('DIVTOK').resolves(createTokenInfo({ TICK: 'DIVTOK', TICK_ID: 2, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null }));
    indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '1000' });
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '10', [HOLDER2]: '20' });
    indexer.indexerDb.getList.resolves([]);
    indexer.indexerDb.isActionAllowed.resolves(true);
}

describe('Dividend @regression @tier2', function () {
    useDividendHarness(bind);

    // ─── Fee model + native-coin payment branches ─────────────────────────
    describe('fee handling', function () {

        it('uses the legacy db-hits fee model when UNIFIED_FEES is disabled', async function () {
            setupValid();
            actionsCtx.protocolChanges.isEnabled.withArgs('UNIFIED_FEES').resolves(false);
            const data = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
            await handler.parse(['0', 'TEST', 'DIVTOK', '1', null], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createDividend.called);
        });

        it('rejects when SOURCE lacks the DIVIDEND_TICK balance to cover the debit', async function () {
            setupValid();
            // holders 10 + 20, amount 1 → debit 30, but only 5 DIVTOK available
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '5' });
            const data = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
            await handler.parse(['0', 'TEST', 'DIVTOK', '1', null], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: insufficient funds (TICK)');
        });

        it('accepts a valid native-coin fee (PAYMENT_MODE native)', async function () {
            setupValid();
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            const valStub = sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({
                valid: true, nativeCoinAmount: '0.0001', nativeCoin: 'BTC', oracleRound: 9,
            });
            const data = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
            await handler.parse(['0', 'TEST', 'DIVTOK', '1', null], data, null);
            assert.ok(valStub.called);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('rejects an invalid native-coin fee', async function () {
            setupValid();
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({ valid: false, error: 'underpaid' });
            const data = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
            await handler.parse(['0', 'TEST', 'DIVTOK', '1', null], data, null);
            assert.ok(String(data['STATUS']).startsWith('invalid'));
        });

        it('rejects when a required native-coin fee output is absent (rejected)', async function () {
            setupValid();
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('rejected');
            const data = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
            await handler.parse(['0', 'TEST', 'DIVTOK', '1', null], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: insufficient fee (native coin output required)');
        });
    });
});
