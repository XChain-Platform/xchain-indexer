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
// MINT_ADDRESS_MAX, the per-address mint cap, and the MINT_SELF_MINTED_ONLY
// flag day that switches its measure from all credits to self-minted amounts.
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

// A protocolChanges.isEnabled stub that holds MINT_SELF_MINTED_ONLY at
// `active` and every other change enabled.
function gateStub(active) {
    return sinon.stub().callsFake(async (name) =>
        name === 'MINT_SELF_MINTED_ONLY' ? active : true);
}

// -----------------------------------------------------------------------
// MINT_ADDRESS_MAX
// -----------------------------------------------------------------------

describe('Mint handler @regression @tier1', function () {
    beforeEach(freshMint);
    afterEach(() => sinon.restore());

    describe('MINT_ADDRESS_MAX', function () {
        // The mock gate resolves MINT_SELF_MINTED_ONLY active, so these exercise
        // the self-minted measure (getSelfMintedAmount); the flag-day describe
        // below covers the legacy credits measure and the gate split itself.

        it('minted so far + AMOUNT > MINT_ADDRESS_MAX → invalid', async function () {
            const token = makeMintableToken({ MAX_MINT: '100', MINT_ADDRESS_MAX: '200' });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.getSelfMintedAmount.resolves('150'); // already self-minted 150

            const params = ['0', 'TEST', '100', '', '']; // 150 + 100 = 250 > 200
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('minted so far + AMOUNT = MINT_ADDRESS_MAX → valid', async function () {
            const token = makeMintableToken({ MAX_MINT: '100', MINT_ADDRESS_MAX: '200' });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.getSelfMintedAmount.resolves('100'); // already self-minted 100

            const params = ['0', 'TEST', '100', '', '']; // 100 + 100 = 200 = MINT_ADDRESS_MAX
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('no MINT_ADDRESS_MAX set (null) → no restriction applied', async function () {
            const token = makeMintableToken({ MINT_ADDRESS_MAX: null });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.getSelfMintedAmount.resolves('900');

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});

describe('Mint handler @regression @tier1', function () {
    beforeEach(freshMint);
    afterEach(() => sinon.restore());

    describe('MINT_SELF_MINTED_ONLY flag-day (/ MINT-1)', function () {

        it('gate ACTIVE: received mints do not count, self-minted measure used', async function () {
            actionsCtx.protocolChanges.isEnabled = gateStub(true);
            const token = makeMintableToken({ MAX_MINT: '100', MINT_ADDRESS_MAX: '200' });
            indexer.indexerDb.getTokenInfo.resolves(token);
            // Griefer scenario: 150 received via another mint's DESTINATION (credits
            // measure) but only 100 self-authored (mints-table measure).
            indexer.indexerDb.getActionCreditDebitAmount.resolves('250');
            indexer.indexerDb.getSelfMintedAmount.resolves('100');

            const params = ['0', 'TEST', '100', '', '']; // 100 + 100 = 200 = cap
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.ok(indexer.indexerDb.getSelfMintedAmount.calledOnce, 'self-minted measure should be used');
            assert.ok(!indexer.indexerDb.getActionCreditDebitAmount.called, 'legacy credits measure should not be queried');
        });

        it('gate ACTIVE: self-minted over cap still rejected', async function () {
            actionsCtx.protocolChanges.isEnabled = gateStub(true);
            const token = makeMintableToken({ MAX_MINT: '100', MINT_ADDRESS_MAX: '200' });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.getSelfMintedAmount.resolves('150');

            const params = ['0', 'TEST', '100', '', '']; // 150 + 100 = 250 > 200
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('gate INACTIVE: legacy credits measure applies (received mints count, byte-identical replay)', async function () {
            actionsCtx.protocolChanges.isEnabled = gateStub(false);
            const token = makeMintableToken({ MAX_MINT: '100', MINT_ADDRESS_MAX: '200' });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.getActionCreditDebitAmount.resolves('150'); // includes received
            indexer.indexerDb.getSelfMintedAmount.resolves('0');

            const params = ['0', 'TEST', '100', '', '']; // legacy: 150 + 100 = 250 > 200
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'), 'legacy over-count must still reject below the flag-day');
            assert.ok(!indexer.indexerDb.getSelfMintedAmount.called, 'self-minted measure must not be queried below the flag-day');
        });
    });
});
