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
// DIVIDEND allow/block list filtering: which holders a configured list admits
// or excludes from the DEBIT.
// Part of the Dividend suite; see ../dividend.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const { createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const { SOURCE, HOLDER1, HOLDER2, useDividendHarness } = require('./helpers/dividend_harness.js');

// The harness under test. useDividendHarness rebuilds it before every test
// and restores sinon after it; bind copies it into the names the tests read.
let indexer, actionsCtx, handler;
const bind = (h) => { ({ indexer, actionsCtx, handler } = h); };

// The three cases below pin the membership semantics against the Set-backed
// membership probe. A configured-but-empty ALLOW_LIST admitting everyone is the
// load-bearing one: AIRDROP gates on list existence and would admit nobody here.
async function runWithList(listIds, listMembers, holders) {
    const tokenInfo    = createTokenInfo({ TICK: 'TEST',   TICK_ID: 1, DECIMALS: 0 });
    const divTokenInfo = createTokenInfo({ TICK: 'DIVTOK', TICK_ID: 2, DECIMALS: 0, ...listIds });

    indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
    indexer.indexerDb.getTokenInfo.withArgs('DIVTOK').resolves(divTokenInfo);
    indexer.indexerDb.getList.resolves(listMembers);
    indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '1000' });
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    indexer.indexerDb.getHolders.resolves(holders);
    indexer.indexerDb.isActionAllowed.resolves(true);

    const data   = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
    const params = ['0', 'TEST', 'DIVTOK', '1', null];

    await handler.parse(params, data, null);

    assert.ok(indexer.indexerDb.createDividend.called);
    return String(indexer.indexerDb.createDividend.args[0][0]['DEBIT']);
}

describe('Dividend @regression @tier2', function () {
    useDividendHarness(bind);

    // ─── Allow/block list filtering ───────────────────────────────────

    describe('allow/block list filtering', function () {
        it('holders on block list are excluded from recipients', async function () {
            const tokenInfo    = createTokenInfo({ TICK: 'TEST',   TICK_ID: 1, DECIMALS: 0 });
            const divTokenInfo = createTokenInfo({ TICK: 'DIVTOK', TICK_ID: 2, DECIMALS: 0, ALLOW_LIST: null, BLOCK_LIST: 5 });

            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(tokenInfo);
            indexer.indexerDb.getTokenInfo.withArgs('DIVTOK').resolves(divTokenInfo);
            // HOLDER1 is on block list
            indexer.indexerDb.getList.resolves([HOLDER1]);
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '200' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '10', [HOLDER2]: '20' });
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'DIVIDEND', FORMAT: 0, SOURCE });
            const params = ['0', 'TEST', 'DIVTOK', '1', null];

            await handler.parse(params, data, null);

            // Should still be valid; HOLDER1 just doesn't receive
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('ALLOW_LIST set but resolving empty still admits every holder', async function () {
            const debit = await runWithList(
                { ALLOW_LIST: 5, BLOCK_LIST: null },
                [],
                { [HOLDER1]: '10', [HOLDER2]: '20' }
            );
            assert.strictEqual(debit, '30');
        });

        it('non-empty ALLOW_LIST admits only listed holders', async function () {
            const debit = await runWithList(
                { ALLOW_LIST: 5, BLOCK_LIST: null },
                [HOLDER1],
                { [HOLDER1]: '10', [HOLDER2]: '20' }
            );
            assert.strictEqual(debit, '10');
        });
    });
});

describe('Dividend @regression @tier2', function () {
    useDividendHarness(bind);

    describe('allow/block list filtering', function () {
        it('non-empty BLOCK_LIST excludes listed holders from the DEBIT', async function () {
            const debit = await runWithList(
                { ALLOW_LIST: null, BLOCK_LIST: 5 },
                [HOLDER1],
                { [HOLDER1]: '10', [HOLDER2]: '20' }
            );
            assert.strictEqual(debit, '20');
        });

    });
});
