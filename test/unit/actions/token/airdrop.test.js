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
// AIRDROP action handler.
//
// This file holds format 0 (single airdrop) and the multi-airdrop formats 1 to
// 3. The balance and authorization checks, the validation branches, the fee
// payment modes and the recipient allow/block lists live beside it in
// airdrop.test/, each opening the same 'Airdrop @regression @tier2' describe so
// every full test title is unchanged; airdrop.test/helpers/airdrop_fixtures.js
// builds the mock handler they share.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const { freshAirdrop } = require('./airdrop.test/helpers/airdrop_fixtures.js');

let indexer, actionsCtx, handler;

describe('Airdrop @regression @tier2', function () {
    beforeEach(function () {
        ({ indexer, actionsCtx, handler } = freshAirdrop());
    });

    afterEach(function () {
        sinon.restore();
    });

    // ─── Format 0 (Single Airdrop) ───────────────────────────────────

    describe('format 0: single airdrop', function () {
        it('valid airdrop to address list creates airdrop record', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0, SUPPLY: '500' });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves(['mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM']);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            const params = ['0', 'TEST', '10', '1', null];

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createAirdrop.called, 'createAirdrop should be called');
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('valid airdrop to tick list gets holders and credits each', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getListType.resolves(1);
            indexer.indexerDb.getList.resolves(['TEST']);
            indexer.indexerDb.getHolders.resolves({
                'mmqFL1hiu2RDuyS69KS9ko6uaMryhANwsz': '100',
                'mk7MdP3qzVkgyjaYNR2sUY8Ggn4DWxt2KS': '200',
            });
            indexer.indexerDb.getAddressBalances.resolves({ 1: '5000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            const params = ['0', 'TEST', '5', '1', null];

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

    describe('format 0: single airdrop', function () {
        it('TICK not found → invalid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves(['mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM']);
            indexer.indexerDb.getAddressBalances.resolves({});
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            const params = ['0', 'UNKNOWN', '10', '1', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });
    });

    describe('format 0: single airdrop', function () {
        it('LIST_ACTION_INDEX invalid (type===false) → invalid', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getListType.resolves(false);
            indexer.indexerDb.getList.resolves([]);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            const params = ['0', 'TEST', '10', '9999', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
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

    describe('format 0: single airdrop', function () {
        it('insufficient balance for total airdrop amount → invalid', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves([
                'mmqFL1hiu2RDuyS69KS9ko6uaMryhANwsz',
                'mk7MdP3qzVkgyjaYNR2sUY8Ggn4DWxt2KS',
                'mr5CBpzjw2QLYwCZEBYMxbrPcS7pwLSDwF',
            ]);
            // Balance only covers 2, but we need 3 * 100 = 300
            indexer.indexerDb.getAddressBalances.resolves({ 1: '5' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            const params = ['0', 'TEST', '100', '1', null];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

        it('MEMO with pipe character → invalid', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves(['mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM']);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            // memo with pipe
            const params = ['0', 'TEST', '10', '1', 'bad|memo'];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
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

    describe('format 0: single airdrop', function () {
        it('pre-existing error passed through → createAirdrop still called', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves(['mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM']);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 0 });
            const params = ['0', 'TEST', '10', '1', null];

            await handler.parse(params, data, 'invalid: pre-existing error');

            assert.ok(data['STATUS'].includes('invalid'));
            assert.ok(indexer.indexerDb.createAirdrop.called, 'createAirdrop should still be called');
        });

        it('unknown format version → invalid', async function () {
            indexer.indexerDb.getAddressBalances.resolves({});
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 99 });
            const params = ['99', 'TEST', '10', '1', null];

            await handler.parse(params, data, null);

            // FORMAT 99 is unknown: the airdrops array stays empty, so the create loop
            // never runs and no airdrop is written.
            assert.ok(indexer.indexerDb.createAirdrop.notCalled, 'unknown FORMAT must not create an airdrop');
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

    // ─── Format 1 (Multi-Airdrop Brief) ──────────────────────────────

    describe('format 1: multi-airdrop brief', function () {
        it('valid multi-airdrop brief processes all ticks', async function () {
            const tokenInfo1 = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            const tokenInfo2 = createTokenInfo({ TICK: 'XTEST', TICK_ID: 2, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo1);
            indexer.indexerDb.getTokenInfo.withArgs('XTEST').resolves(tokenInfo2);
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves(['mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM']);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000', 2: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 1 });
            // FORMAT 1: VERSION|LIST_ACTION_INDEX|TICK|AMOUNT|TICK|AMOUNT|MEMO
            const params = ['1', '1', 'TEST', '5', 'XTEST', '3', 'memo'];

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createAirdrop.callCount >= 2, 'createAirdrop called for each tick');
        });
    });

    // ─── Format 2 (Multi-Airdrop Full) ───────────────────────────────

    describe('format 2: multi-airdrop full', function () {
        it('valid multi-airdrop full processes multiple TICK/LIST pairs', async function () {
            const tokenInfo1 = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            const tokenInfo2 = createTokenInfo({ TICK: 'XTEST', TICK_ID: 2, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo1);
            indexer.indexerDb.getTokenInfo.withArgs('XTEST').resolves(tokenInfo2);
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves(['mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM']);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000', 2: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 2 });
            // FORMAT 2: VERSION|TICK|AMOUNT|LIST_ACTION_INDEX|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO
            const params = ['2', 'TEST', '5', '1', 'XTEST', '3', '2', 'memo'];

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createAirdrop.callCount >= 1);
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

    // ─── Format 3 (Multi-Airdrop Full with Multiple Memos) ───────────

    describe('format 3: multi-airdrop full with multiple memos', function () {
        it('valid format-3 multi-airdrop processes TICK/LIST/MEMO triples', async function () {
            const tokenInfo1 = createTokenInfo({ TICK: 'TEST',  TICK_ID: 1, DECIMALS: 0 });
            const tokenInfo2 = createTokenInfo({ TICK: 'XTEST', TICK_ID: 2, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo1);
            indexer.indexerDb.getTokenInfo.withArgs('XTEST').resolves(tokenInfo2);
            indexer.indexerDb.getListType.resolves(2);
            indexer.indexerDb.getList.resolves(['mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM']);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1000', 2: '1000' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data = createBaseData({ ACTION: 'AIRDROP', FORMAT: 3 });
            // FORMAT 3: VERSION|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO
            const params = ['3', 'TEST', '5', '1', 'memofirst', 'XTEST', '3', '2', 'memosecond'];

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createAirdrop.callCount >= 2, 'createAirdrop called for each triple');
        });
    });
});
