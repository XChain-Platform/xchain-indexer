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
// How the CALLBACK_TICK ALLOW/BLOCK lists filter the credited holders. Part of
// the CALLBACK suite; see ../callback.test.js, whose describe title the block
// here repeats so every full test title is unchanged.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const {
    OWNER, HOLDER1, HOLDER2, makeTokenInfo, makeCallbackTokenInfo, freshCallback,
} = require('./helpers/callback_fixtures.js');

let indexer, handler;

// ─── CALLBACK_TICK ALLOW/BLOCK list filters holders ───────────────────
describe('Callback @regression @tier3', function () {
    beforeEach(function () {
        ({ indexer, handler } = freshCallback());
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('holder allow/block list filtering', function () {

        function setup(cbOverrides) {
            indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(makeTokenInfo());
            indexer.indexerDb.getTokenInfo.withArgs('CBTEST').resolves(makeCallbackTokenInfo(cbOverrides));
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '100' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            // include the SOURCE as a holder to drive the source-skip branch too
            indexer.indexerDb.getHolders.resolves({ [OWNER]: '5', [HOLDER1]: '10', [HOLDER2]: '20' });
            indexer.indexerDb.isActionAllowed.resolves(true);
        }

        it('excludes holders not on the CALLBACK_TICK ALLOW_LIST', async function () {
            setup({ ALLOW_LIST: 70 });
            indexer.indexerDb.getList.callsFake(async (id) => (id === 70 ? [HOLDER1] : []));
            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
            await handler.parse(['0', 'TEST', null], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            // only HOLDER1 should be credited (HOLDER2 filtered out)
            const credited = indexer.indexerDb.createCredit.getCalls().map(c => c.args[3]);
            assert.ok(credited.includes(HOLDER1));
            assert.ok(!credited.includes(HOLDER2));
        });

        it('excludes holders on the CALLBACK_TICK BLOCK_LIST', async function () {
            setup({ BLOCK_LIST: 71 });
            indexer.indexerDb.getList.callsFake(async (id) => (id === 71 ? [HOLDER2] : []));
            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
            await handler.parse(['0', 'TEST', null], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            const credited = indexer.indexerDb.createCredit.getCalls().map(c => c.args[3]);
            assert.ok(!credited.includes(HOLDER2));
        });

        // Load-bearing: emptiness gates the check here, so a configured-but-empty ALLOW_LIST
        // credits every holder. AIRDROP gates on list existence and would credit nobody.
        it('an ALLOW_LIST that resolves empty still credits every holder', async function () {
            setup({ ALLOW_LIST: 70 });
            indexer.indexerDb.getList.resolves([]);
            const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100 });
            await handler.parse(['0', 'TEST', null], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            const credited = indexer.indexerDb.createCredit.getCalls().map(c => c.args[3]);
            assert.ok(credited.includes(HOLDER1));
            assert.ok(credited.includes(HOLDER2));
        });
    });
});
