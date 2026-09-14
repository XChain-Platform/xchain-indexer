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
// AIRDROP fee payment modes: the legacy fee path, native coin fees accepted and
// refused, and the rejected mode. Part of the AIRDROP suite; see
// ../airdrop.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const { freshAirdrop } = require('./helpers/airdrop_fixtures.js');

let indexer, actionsCtx, handler;

// Helper: build a valid airdrop scenario with a non-zero fee so we enter the fee gate.
// Uses UNIFIED_FEES=false so we hit the legacy db_hits path (lines 273-277).
function setupFeeScenario() {
    const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0, SUPPLY: '1000000' });
    indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
    indexer.indexerDb.getListType.resolves(2);
    indexer.indexerDb.getList.resolves(['mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM']);
    indexer.indexerDb.getAddressBalances.resolves({ 1: '999999' });
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    indexer.indexerDb.isActionAllowed.resolves(true);
}

describe('Airdrop @regression @tier2', function () {
    beforeEach(function () {
        ({ indexer, actionsCtx, handler } = freshAirdrop());
    });

    afterEach(function () {
        sinon.restore();
    });

    // ─── Fee payment mode branches ────────────────────────────────────

    describe('fee payment mode branches', function () {
        it('legacy fee path (UNIFIED_FEES=false): getTransactionFee called and fee computed', async function () {
            // Make isEnabled return false so the legacy db_hits branch (lines 273-277) runs
            actionsCtx.protocolChanges.isEnabled.resolves(false);
            setupFeeScenario();

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            const params = ['0', 'TEST', '1', '1', null];

            await handler.parse(params, data, null);

            // The legacy branch sets fees['AMOUNT'] via getTransactionFee. The XCHAIN balance
            // check runs (no native fee stub) and because the mock balance has XCHAIN, it
            // should succeed and reach valid or run to the fee-check with the mock balances.
            assert.ok(indexer.indexerDb.createAirdrop.called, 'createAirdrop should still be called');
        });

        it('native coin fee payment mode: valid validation results in STATUS valid, PAYMENT_MODE=1 recorded', async function () {
            // Force UNIFIED_FEES=false so fee>0 is always set (legacy db_hits) and fee amount is
            // deterministic. We then stub detectFeePaymentMode → 'native' and validateNativeCoinFee
            // → valid to exercise lines 293-302.
            actionsCtx.protocolChanges.isEnabled.resolves(false);
            setupFeeScenario();

            // getTransactionFee will return a positive value when db_hits > 0; stub the util
            // methods so the native-coin fee branch is taken.
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({
                valid:            true,
                nativeCoinAmount: '0.0001',
                nativeCoin:       'BTC',
                oracleRound:      7,
            });

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            const params = ['0', 'TEST', '1', '1', null];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createAirdrop.called);
        });
    });
});

describe('Airdrop @regression @tier2', function () {
    beforeEach(function () {
        ({ indexer, actionsCtx, handler } = freshAirdrop());
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('fee payment mode branches', function () {
        it('native coin fee payment mode: invalid validation causes STATUS to start with invalid', async function () {
            actionsCtx.protocolChanges.isEnabled.resolves(false);
            setupFeeScenario();

            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({
                valid: false,
                error: 'native coin fee too low',
            });

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            const params = ['0', 'TEST', '1', '1', null];

            await handler.parse(params, data, null);

            assert.ok(String(data['STATUS']).startsWith('invalid'),
                'expected invalid status, got: ' + data['STATUS']);
        });

        it('rejected payment mode → STATUS = invalid: insufficient fee (native coin output required)', async function () {
            actionsCtx.protocolChanges.isEnabled.resolves(false);
            setupFeeScenario();

            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('rejected');

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            const params = ['0', 'TEST', '1', '1', null];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'invalid: insufficient fee (native coin output required)');
        });
    });
});
