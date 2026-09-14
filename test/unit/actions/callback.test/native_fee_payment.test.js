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
// CALLBACK native-coin fee payment. Part of the CALLBACK suite; see
// ../callback.test.js, whose describe title each block here repeats so every
// full test title is unchanged.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../fixtures/mocks');
const {
    OWNER, HOLDER1, HOLDER2, makeTokenInfo, makeCallbackTokenInfo, freshCallback,
} = require('./helpers/callback_fixtures.js');

let indexer, handler;

// A fully valid CALLBACK, so each case below changes only the payment mode.
function setupValid() {
    indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(makeTokenInfo());
    indexer.indexerDb.getTokenInfo.withArgs('CBTEST').resolves(makeCallbackTokenInfo());
    indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '100' });
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '10', [HOLDER2]: '20' });
    indexer.indexerDb.getList.resolves([]);
    indexer.indexerDb.isActionAllowed.resolves(true);
}

// ─── Native-coin fee payment branches ─────────────────────────────────
// The default suite covers XCHAIN-balance fee deduction; these drive the
// native-coin payment-mode branch (detectFeePaymentMode → 'native'/'rejected').

describe('Callback @regression @tier3', function () {
    beforeEach(function () {
        ({ indexer, handler } = freshCallback());
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('native-coin fee payment', function () {

        it('accepts a valid native-coin fee (PAYMENT_MODE native)', async function () {
            setupValid();
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            const valStub = sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({
                valid: true, nativeCoinAmount: '0.0001', nativeCoin: 'BTC', oracleRound: 7,
            });
            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
            await handler.parse(['0', 'TEST', null], data, null);
            assert.ok(valStub.called);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createCallback.called);
        });

        it('rejects an invalid native-coin fee (validation.valid=false)', async function () {
            setupValid();
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({ valid: false, error: 'underpaid' });
            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
            await handler.parse(['0', 'TEST', null], data, null);
            assert.ok(String(data['STATUS']).startsWith('invalid'));
        });

        it('rejects when native-coin output is required but absent (rejected)', async function () {
            setupValid();
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('rejected');
            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
            await handler.parse(['0', 'TEST', null], data, null);
            assert.ok(String(data['STATUS']).startsWith('invalid'));
        });
    });
});

describe('Callback @regression @tier3', function () {
    beforeEach(function () {
        ({ indexer, handler } = freshCallback());
    });

    afterEach(function () {
        sinon.restore();
    });

    // ─── Native fee: validation failure with no error message (fallback) ──
    it('falls back to a generic message when native fee fails without error text', async function () {
        indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(makeTokenInfo());
        indexer.indexerDb.getTokenInfo.withArgs('CBTEST').resolves(makeCallbackTokenInfo());
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '100' });
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '10' });
        indexer.indexerDb.getList.resolves([]);
        indexer.indexerDb.isActionAllowed.resolves(true);
        sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
        sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({ valid: false }); // no .error
        const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
        await handler.parse(['0', 'TEST', null], data, null);
        assert.strictEqual(data['STATUS'], 'invalid: native coin fee validation failed');
    });
});
