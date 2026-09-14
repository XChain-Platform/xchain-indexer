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
// SEND balance boundaries (drain to zero, one unit over) and DESTROY of the entire
// supply.
// Part of the supply boundary suite; see ../supply_limits.test.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../../fixtures/mocks');
const { makeActionsCtx, LOW_BLOCK, SOURCE, DESTINATION } = require('./helpers/supply_context.js');

const Destroy = require('../../../../../src/actions/destroy.js');
const Send    = require('../../../../../src/actions/send.js');

describe('Supply & amount boundary tests @regression @tier1', function () {
    // -----------------------------------------------------------------------
    // SEND balance boundaries: drain to zero and 1 unit over
    // -----------------------------------------------------------------------

    describe('AMT-07: SEND entire balance (drain to zero)', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Send(actionsCtx);

            const token = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            // Balance of exactly 100
            indexer.indexerDb.getAddressBalances.resolves({ 1: '100' });
            indexer.indexerDb.findMatchingDispensers.resolves([]);
            indexer.indexerDb.findDispenserSends.resolves([]);
        });

        afterEach(function () {
            sinon.restore();
        });

        it('SEND AMOUNT=100 drains balance to zero → valid', async function () {
            // Format 0: VERSION|TICK|AMOUNT|DESTINATION|MEMO
            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});

describe('Supply & amount boundary tests @regression @tier1', function () {
    describe('AMT-08: SEND 1 unit over balance', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Send(actionsCtx);

            const token = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            // Balance of 100; sending 101 should fail
            indexer.indexerDb.getAddressBalances.resolves({ 1: '100' });
            indexer.indexerDb.findMatchingDispensers.resolves([]);
            indexer.indexerDb.findDispenserSends.resolves([]);
        });

        afterEach(function () {
            sinon.restore();
        });

        it('SEND AMOUNT=101 exceeds balance of 100 → invalid (insufficient balance)', async function () {
            const params = ['0', 'TEST', '101', DESTINATION, ''];
            const data   = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });
});

describe('Supply & amount boundary tests @regression @tier1', function () {
    // -----------------------------------------------------------------------
    // DESTROY entire supply
    // -----------------------------------------------------------------------

    describe('AMT-09: DESTROY entire supply', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Destroy(actionsCtx);

            const token = createTokenInfo({
                TICK:    'TEST',
                TICK_ID: 1,
                DECIMALS: 0,
                SUPPLY:  '500',
            });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.isActionAllowed.resolves(true);
            // Full balance of 500 available
            indexer.indexerDb.getAddressBalances.resolves({ 1: '500' });
            if (indexer.util.resetLists) indexer.util.resetLists();
        });

        afterEach(function () {
            sinon.restore();
        });

        it('DESTROY AMOUNT=500 burns entire supply → valid', async function () {
            // Format 0: VERSION|TICK|AMOUNT|MEMO
            const params = ['0', 'TEST', '500', ''];
            const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});
