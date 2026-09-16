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
// MINT_START_BLOCK and MINT_STOP_BLOCK: a mint below, at and above each end of
// the token's mint window.
// Part of the MINT suite; see ../mint.test.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { SOURCE, makeData, makeMintableToken, makeMintContext } = require('./helpers/mint_context.js');

let indexer, actionsCtx, handler;

// Each test starts from its own mock indexer and MINT handler.
function freshMint() {
    ({ indexer, actionsCtx, handler } = makeMintContext());
}

// -----------------------------------------------------------------------
// MINT_START_BLOCK
// -----------------------------------------------------------------------

describe('Mint handler @regression @tier1', function () {
    beforeEach(freshMint);
    afterEach(() => sinon.restore());

    describe('MINT_START_BLOCK', function () {

        it('before MINT_START_BLOCK → invalid', async function () {
            const token = makeMintableToken({ MINT_START_BLOCK: '200' }); // mint starts at 200
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: 100, SOURCE }); // current block 100 < 200

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('at MINT_START_BLOCK → valid', async function () {
            const token = makeMintableToken({ MINT_START_BLOCK: '100' });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: 100, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('after MINT_START_BLOCK → valid', async function () {
            const token = makeMintableToken({ MINT_START_BLOCK: '50' });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: 100, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});

// -----------------------------------------------------------------------
// MINT_STOP_BLOCK
// -----------------------------------------------------------------------

describe('Mint handler @regression @tier1', function () {
    beforeEach(freshMint);
    afterEach(() => sinon.restore());

    describe('MINT_STOP_BLOCK', function () {

        it('after MINT_STOP_BLOCK → invalid', async function () {
            const token = makeMintableToken({ MINT_STOP_BLOCK: '50' }); // stopped at block 50
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: 100, SOURCE }); // current block 100 > 50

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('at MINT_STOP_BLOCK → valid', async function () {
            const token = makeMintableToken({ MINT_STOP_BLOCK: '100' });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: 100, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('before MINT_STOP_BLOCK → valid', async function () {
            const token = makeMintableToken({ MINT_STOP_BLOCK: '200' });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: 100, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});
