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
// MINT supply boundaries: exactly to MAX_SUPPLY, one unit over, the smallest unit
// at 18 decimals and the per-address cap (MINT_ADDRESS_MAX).
// Part of the supply boundary suite; see ../supply_limits.test.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../../fixtures/mocks');
const { makeActionsCtx, LOW_BLOCK, SOURCE } = require('./helpers/supply_context.js');

const Mint    = require('../../../../../src/actions/mint.js');

describe('Supply & amount boundary tests @regression @tier1', function () {
    // -----------------------------------------------------------------------
    // MINT at supply boundary: exactly to MAX_SUPPLY and 1 unit over
    // -----------------------------------------------------------------------

    describe('AMT-05: MINT exactly to MAX_SUPPLY', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Mint(actionsCtx);

            // Token with 100 remaining supply (900 minted, max 1000)
            const token = createTokenInfo({
                TICK:     'TEST',
                TICK_ID:  1,
                DECIMALS: 0,
                MAX_SUPPLY: '1000',
                MAX_MINT:   '100',
                SUPPLY:     '900',
                BLOCK_INDEX: 50,
            });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getActionCreditDebitAmount.resolves('0');
            indexer.indexerDb.validTickerBeforeTxIndex.resolves(true);
        });

        afterEach(function () {
            sinon.restore();
        });

        it('MINT AMOUNT=100 fills exactly to MAX_SUPPLY=1000 → valid', async function () {
            // Format 0: VERSION|TICK|AMOUNT|DESTINATION|MEMO
            const params = ['0', 'TEST', '100', '', ''];
            const data   = createBaseData({ ACTION: 'MINT', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});

describe('Supply & amount boundary tests @regression @tier1', function () {
    describe('AMT-06: MINT 1 unit over MAX_SUPPLY', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Mint(actionsCtx);

            // Token with only 99 remaining supply (901 minted, max 1000)
            const token = createTokenInfo({
                TICK:     'TEST',
                TICK_ID:  1,
                DECIMALS: 0,
                MAX_SUPPLY: '1000',
                MAX_MINT:   '100',
                SUPPLY:     '901',
                BLOCK_INDEX: 50,
            });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getActionCreditDebitAmount.resolves('0');
            indexer.indexerDb.validTickerBeforeTxIndex.resolves(true);
        });

        afterEach(function () {
            sinon.restore();
        });

        it('MINT AMOUNT=100 would push supply to 1001 > MAX_SUPPLY=1000 → invalid', async function () {
            const params = ['0', 'TEST', '100', '', ''];
            const data   = createBaseData({ ACTION: 'MINT', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });
});

describe('Supply & amount boundary tests @regression @tier1', function () {
    // -----------------------------------------------------------------------
    // Maximum precision arithmetic (18 decimals)
    // -----------------------------------------------------------------------

    describe('AMT-10: Maximum precision arithmetic (18 decimals)', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Mint(actionsCtx);

            // Token at 18 decimals; one smallest unit away from full supply
            const token = createTokenInfo({
                TICK:       'HIRES',
                TICK_ID:    1,
                DECIMALS:   18,
                MAX_SUPPLY: '1000.000000000000000000',
                MAX_MINT:   '1.000000000000000000',
                SUPPLY:     '999.999999999999999999',
                BLOCK_INDEX: 50,
            });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getActionCreditDebitAmount.resolves('0');
            indexer.indexerDb.validTickerBeforeTxIndex.resolves(true);
        });

        afterEach(function () {
            sinon.restore();
        });

        it('MINT AMOUNT=0.000000000000000001 (smallest unit) fills last slot → valid', async function () {
            const params = ['0', 'HIRES', '0.000000000000000001', '', ''];
            const data   = createBaseData({ ACTION: 'MINT', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});

describe('Supply & amount boundary tests @regression @tier1', function () {
    // -----------------------------------------------------------------------
    // MINT at per-address cap (MINT_ADDRESS_MAX)
    // -----------------------------------------------------------------------

    describe('AMT-11: MINT at per-address cap', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Mint(actionsCtx);

            const token = createTokenInfo({
                TICK:             'TEST',
                TICK_ID:          1,
                DECIMALS:         0,
                MAX_SUPPLY:       '1000',
                MAX_MINT:         '50',
                SUPPLY:           '0',
                MINT_ADDRESS_MAX: '50',
                BLOCK_INDEX:      50,
            });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.validTickerBeforeTxIndex.resolves(true);
        });

        afterEach(function () {
            sinon.restore();
        });

        it('minted so far=49, AMOUNT=1 → exactly at cap → valid', async function () {
            indexer.indexerDb.getSelfMintedAmount.resolves('49');

            const params = ['0', 'TEST', '1', '', ''];
            const data   = createBaseData({ ACTION: 'MINT', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('minted so far=50, AMOUNT=1 → one over cap (MINT_ADDRESS_MAX=50) → invalid', async function () {
            indexer.indexerDb.getSelfMintedAmount.resolves('50');

            const params = ['0', 'TEST', '1', '', ''];
            const data   = createBaseData({ ACTION: 'MINT', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });
});
