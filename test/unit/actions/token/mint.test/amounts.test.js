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
// MINT amounts: AMOUNT against MAX_MINT, SUPPLY plus AMOUNT against MAX_SUPPLY,
// and the AMOUNT format for the token's decimals.
// Part of the MINT suite; see ../mint.test.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { SOURCE, BLOCK, makeData, makeMintableToken, makeMintContext } = require('./helpers/mint_context.js');

let indexer, actionsCtx, handler;

// Each test starts from its own mock indexer and MINT handler.
function freshMint() {
    ({ indexer, actionsCtx, handler } = makeMintContext());
}

// -----------------------------------------------------------------------
// AMOUNT > MAX_MINT
// -----------------------------------------------------------------------

describe('Mint handler @regression @tier1', function () {
    beforeEach(freshMint);
    afterEach(() => sinon.restore());

    describe('AMOUNT vs MAX_MINT', function () {

        it('AMOUNT > MAX_MINT → invalid', async function () {
            const token = makeMintableToken({ MAX_MINT: '100' });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '101', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('AMOUNT = MAX_MINT → valid', async function () {
            const token = makeMintableToken({ MAX_MINT: '100' });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '100', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('AMOUNT < MAX_MINT → valid', async function () {
            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});

// -----------------------------------------------------------------------
// SUPPLY + AMOUNT > MAX_SUPPLY
// -----------------------------------------------------------------------

describe('Mint handler @regression @tier1', function () {
    beforeEach(freshMint);
    afterEach(() => sinon.restore());

    describe('SUPPLY + AMOUNT > MAX_SUPPLY', function () {

        it('mint would exceed MAX_SUPPLY → invalid', async function () {
            const token = makeMintableToken({ MAX_SUPPLY: '1000', SUPPLY: '950', MAX_MINT: '100' });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '100', '', '']; // 950 + 100 = 1050 > 1000
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('mint that fills remaining supply exactly → valid', async function () {
            const token = makeMintableToken({ MAX_SUPPLY: '1000', SUPPLY: '900', MAX_MINT: '100' });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '100', '', '']; // 900 + 100 = 1000 = MAX_SUPPLY
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('mint that partially fills remaining supply → valid', async function () {
            const token = makeMintableToken({ MAX_SUPPLY: '1000', SUPPLY: '900', MAX_MINT: '100' });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});

// -----------------------------------------------------------------------
// AMOUNT format
// -----------------------------------------------------------------------

describe('Mint handler @regression @tier1', function () {
    beforeEach(freshMint);
    afterEach(() => sinon.restore());

    describe('AMOUNT format', function () {

        it('fractional AMOUNT for 0-decimal token → invalid', async function () {
            const params = ['0', 'TEST', '1.5', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('valid decimal AMOUNT for 8-decimal token → valid', async function () {
            const token = makeMintableToken({ DECIMALS: 8, MAX_MINT: '100' });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '1.50000000', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});
