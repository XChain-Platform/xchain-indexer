// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// (DIVIDEND-1) regression: the legacy db-hits fee accumulators in
// dividend.js / callback.js / sweep.js used `db_hits += this.util.bcmul(...)`.
// bcmul returns a Decimal, so `+=` string-concatenated instead of adding
// (e.g. 3 + "4" -> "34"), massively inflating the fee passed to
// getTransactionFee. These tests capture the db_hits argument and assert it
// is a real integer Number with the correct additive value.
//
// (flag-day Pkg 11): the numeric fix is now gated behind the
// LEGACY_FEE_NUMERIC_DBHITS flag-day so pre-activation replay stays
// byte-identical. At/above the flag-day (default in these tests) db_hits
// accumulates numerically; BELOW it the code reproduces the original
// string-concatenation byte-for-byte. Both branches are asserted below.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Dividend = require('../../../src/actions/dividend.js');
const Callback = require('../../../src/actions/callback.js');
const Sweep    = require('../../../src/actions/sweep.js');

describe('Legacy db-hits fee accumulation @regression @tier3', function () {
    let indexer, actionsCtx, feeStub;

    const SOURCE      = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
    const DESTINATION = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
    const HOLDER1     = 'mmqFL1hiu2RDuyS69KS9ko6uaMryhANwsz';
    const HOLDER2     = 'mk7MdP3qzVkgyjaYNR2sUY8Ggn4DWxt2KS';

    beforeEach(function () {
        indexer = createMockIndexer();
        indexer.indexerDb.getAddressEscrows = sinon.stub().resolves([]);
        actionsCtx = {
            config:          indexer.config,
            util:            indexer.util,
            mapper:          indexer.mapper,
            decoderDb:       indexer.decoderDb,
            indexerDb:       indexer.indexerDb,
            protocolChanges: {
                isDefined:  sinon.stub().returns(true),
                isEnabled:  sinon.stub().resolves(true),
            },
            processAction:   sinon.stub().resolves(),
        };
        // Capture db_hits; return a zero fee so fee-payment validation is skipped
        feeStub = sinon.stub(indexer.util, 'getTransactionFee').returns('0.00000000');
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    function assertIntegerDbHits(expected) {
        assert.ok(feeStub.called, 'getTransactionFee was not called');
        const dbHits = feeStub.firstCall.args[0];
        assert.strictEqual(typeof dbHits, 'number', `db_hits is ${typeof dbHits} (${dbHits}), expected number`);
        assert.ok(Number.isInteger(dbHits), `db_hits ${dbHits} is not an integer`);
        assert.strictEqual(dbHits, expected);
    }

    it('DIVIDEND legacy path: db_hits = 3 + recipients*2 as a Number (not "3" concat)', async function () {
        actionsCtx.protocolChanges.isEnabled.withArgs('UNIFIED_FEES').resolves(false);
        const handler = new Dividend(actionsCtx);
        const tokenInfo    = createTokenInfo({ TICK: 'TEST',   TICK_ID: 1, DECIMALS: 0 });
        const divTokenInfo = createTokenInfo({ TICK: 'DIVTOK', TICK_ID: 2, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null });
        indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
        indexer.indexerDb.getTokenInfo.withArgs('DIVTOK').resolves(divTokenInfo);
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '1000' });
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '10', [HOLDER2]: '20' });
        indexer.indexerDb.getList.resolves([]);
        indexer.indexerDb.isActionAllowed.resolves(true);

        const data = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
        await handler.parse(['0', 'TEST', 'DIVTOK', '1', null], data, null);

        assert.strictEqual(data['STATUS'], 'valid');
        assertIntegerDbHits(3 + 2 * 2); // 2 recipients
    });

    it('CALLBACK: db_hits = 4 + recipients*3 as a Number (not "4" concat)', async function () {
        const handler = new Callback(actionsCtx);
        const tokenInfo = createTokenInfo({
            TICK: 'TEST', TICK_ID: 1, OWNER: SOURCE, DECIMALS: 0,
            LOCK_CALLBACK: 0, CALLBACK_BLOCK: 90, CALLBACK_TICK: 'CBTEST', CALLBACK_AMOUNT: '1',
        });
        const cbTokenInfo = createTokenInfo({ TICK: 'CBTEST', TICK_ID: 2, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null });
        indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
        indexer.indexerDb.getTokenInfo.withArgs('CBTEST').resolves(cbTokenInfo);
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '100' });
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '10', [HOLDER2]: '20' });
        indexer.indexerDb.getList.resolves([]);
        indexer.indexerDb.isActionAllowed.resolves(true);

        const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE, BLOCK_INDEX: 100 });
        await handler.parse(['0', 'TEST', 'memo'], data, null);

        assert.strictEqual(data['STATUS'], 'valid');
        assertIntegerDbHits(4 + 2 * 3); // 2 recipients
    });

    it('SWEEP: db_hits stays an integer Number across all three += terms', async function () {
        const handler = new Sweep(actionsCtx);
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getAddressOwnerships.resolves([]);
        indexer.indexerDb.getAddressEscrows.resolves([]);
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getTicker.resolves('GAS');

        const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
        await handler.parse(['0', DESTINATION], data, null);

        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(feeStub.called);
        const dbHits = feeStub.firstCall.args[0];
        assert.strictEqual(typeof dbHits, 'number');
        assert.ok(Number.isInteger(dbHits) && dbHits >= 1);
    });

    // BELOW the LEGACY_FEE_NUMERIC_DBHITS flag-day the pre-activation
    // string-concatenation behaviour must be reproduced byte-for-byte so a
    // from-genesis replay commits the identical (inflated) fee.

    it('DIVIDEND legacy path below flag-day: db_hits reproduces "34" string-concat', async function () {
        actionsCtx.protocolChanges.isEnabled.withArgs('UNIFIED_FEES').resolves(false);
        actionsCtx.protocolChanges.isEnabled.withArgs('LEGACY_FEE_NUMERIC_DBHITS').resolves(false);
        const handler = new Dividend(actionsCtx);
        const tokenInfo    = createTokenInfo({ TICK: 'TEST',   TICK_ID: 1, DECIMALS: 0 });
        const divTokenInfo = createTokenInfo({ TICK: 'DIVTOK', TICK_ID: 2, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null });
        indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
        indexer.indexerDb.getTokenInfo.withArgs('DIVTOK').resolves(divTokenInfo);
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '1000' });
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '10', [HOLDER2]: '20' });
        indexer.indexerDb.getList.resolves([]);
        indexer.indexerDb.isActionAllowed.resolves(true);

        const data = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
        await handler.parse(['0', 'TEST', 'DIVTOK', '1', null], data, null);

        assert.strictEqual(data['STATUS'], 'valid');
        const dbHits = feeStub.firstCall.args[0];
        assert.strictEqual(typeof dbHits, 'string', 'below flag-day db_hits must be a concatenated string');
        assert.strictEqual(dbHits, '34'); // 3 concat bcmul(2,2,0)="4" -> "34"
    });

    it('CALLBACK below flag-day: db_hits reproduces "46" string-concat', async function () {
        actionsCtx.protocolChanges.isEnabled.withArgs('LEGACY_FEE_NUMERIC_DBHITS').resolves(false);
        const handler = new Callback(actionsCtx);
        const tokenInfo = createTokenInfo({
            TICK: 'TEST', TICK_ID: 1, OWNER: SOURCE, DECIMALS: 0,
            LOCK_CALLBACK: 0, CALLBACK_BLOCK: 90, CALLBACK_TICK: 'CBTEST', CALLBACK_AMOUNT: '1',
        });
        const cbTokenInfo = createTokenInfo({ TICK: 'CBTEST', TICK_ID: 2, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: null });
        indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
        indexer.indexerDb.getTokenInfo.withArgs('CBTEST').resolves(cbTokenInfo);
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '100' });
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '10', [HOLDER2]: '20' });
        indexer.indexerDb.getList.resolves([]);
        indexer.indexerDb.isActionAllowed.resolves(true);

        const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE, BLOCK_INDEX: 100 });
        await handler.parse(['0', 'TEST', 'memo'], data, null);

        assert.strictEqual(data['STATUS'], 'valid');
        const dbHits = feeStub.firstCall.args[0];
        assert.strictEqual(typeof dbHits, 'string', 'below flag-day db_hits must be a concatenated string');
        assert.strictEqual(dbHits, '46'); // 4 concat bcmul(2,3,0)="6" -> "46"
    });

    it('SWEEP below flag-day: db_hits reproduces the "1400" string-concat', async function () {
        actionsCtx.protocolChanges.isEnabled.withArgs('LEGACY_FEE_NUMERIC_DBHITS').resolves(false);
        const handler = new Sweep(actionsCtx);
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getAddressOwnerships.resolves([]);
        indexer.indexerDb.getAddressEscrows.resolves([]);
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getTicker.resolves('GAS');

        const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
        await handler.parse(['0', DESTINATION], data, null);

        assert.strictEqual(data['STATUS'], 'valid');
        const dbHits = feeStub.firstCall.args[0];
        // 1 balance, no escrows, no ownerships: 1 concat bcmul(1,4,0)="4" -> "14",
        // concat bcmul(0,4,0)="0" -> "140", then (+= 0 no ownerships) -> "1400".
        assert.strictEqual(typeof dbHits, 'string', 'below flag-day db_hits must be a concatenated string');
        assert.strictEqual(dbHits, '1400');
    });
});
