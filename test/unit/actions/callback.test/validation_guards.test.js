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
// CALLBACK validation guards, each rejecting with its own specific reason. Part
// of the CALLBACK suite; see ../callback.test.js, whose describe title each
// block here repeats so every full test title is unchanged.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../fixtures/mocks');
const {
    OWNER, HOLDER1, HOLDER2, makeTokenInfo, makeCallbackTokenInfo, freshCallback,
} = require('./helpers/callback_fixtures.js');

let indexer, handler;

// A valid CALLBACK the case then breaks in exactly one way.
function setup(tokenOverrides = {}, cbOverrides = {}) {
    indexer.indexerDb.getTokenInfo.withArgs('TEST').resolves(makeTokenInfo(tokenOverrides));
    indexer.indexerDb.getTokenInfo.withArgs('CBTEST').resolves(makeCallbackTokenInfo(cbOverrides));
    indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '100' });
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    indexer.indexerDb.getHolders.resolves({ [HOLDER1]: '10', [HOLDER2]: '20' });
    indexer.indexerDb.getList.resolves([]);
    indexer.indexerDb.isActionAllowed.resolves(true);
}

async function run(params, dataOverrides = {}) {
    const data = createBaseData({ ACTION: 'CALLBACK', FORMAT: 0, SOURCE: OWNER, BLOCK_INDEX: 100, ...dataOverrides });
    await handler.parse(params, data, null);
    return data;
}

function freshHandler() {
    ({ indexer, handler } = freshCallback());
}

// ─── Validation guards (each rejects with its specific reason) ────────
describe('Callback @regression @tier3', function () {
    beforeEach(freshHandler);

    afterEach(function () {
        sinon.restore();
    });

    describe('validation guards', function () {
        it('rejects when LOCK_CALLBACK is set', async function () {
            setup({ LOCK_CALLBACK: 1 });
            const data = await run(['0', 'TEST', null]);
            assert.strictEqual(data['STATUS'], 'invalid: LOCK_CALLBACK');
        });

        it('rejects when the TICK ownership is escrowed', async function () {
            setup();
            indexer.indexerDb.isOwnershipEscrowed.resolves(true);
            const data = await run(['0', 'TEST', null]);
            assert.strictEqual(data['STATUS'], 'invalid: TICK (ownership escrowed)');
        });

        it('rejects a malformed CALLBACK_BLOCK', async function () {
            setup({ CALLBACK_BLOCK: '9.5' });
            const data = await run(['0', 'TEST', null]);
            assert.strictEqual(data['STATUS'], 'invalid: CALLBACK_BLOCK (format)');
        });

        it('rejects a malformed CALLBACK_AMOUNT', async function () {
            setup({ CALLBACK_AMOUNT: '1.5' }); // CBTEST DECIMALS=0 → fractional invalid
            const data = await run(['0', 'TEST', null]);
            assert.strictEqual(data['STATUS'], 'invalid: CALLBACK_AMOUNT (format)');
        });
    });
});

describe('Callback @regression @tier3', function () {
    beforeEach(freshHandler);

    afterEach(function () {
        sinon.restore();
    });

    describe('validation guards', function () {
        it('rejects when SOURCE is sleeping', async function () {
            setup();
            indexer.indexerDb.isActionAllowed.callsFake(async (addr) => addr !== OWNER);
            const data = await run(['0', 'TEST', null]);
            assert.strictEqual(data['STATUS'], 'invalid: SOURCE (sleeping)');
        });

        it('rejects when the TICK is sleeping', async function () {
            setup();
            indexer.indexerDb.isActionAllowed.callsFake(async (addr, tick) => tick !== 'TEST');
            const data = await run(['0', 'TEST', null]);
            assert.strictEqual(data['STATUS'], 'invalid: TICK (sleeping)');
        });

        it('rejects when the CALLBACK_TICK is sleeping', async function () {
            setup();
            indexer.indexerDb.isActionAllowed.callsFake(async (addr, tick) => tick !== 'CBTEST');
            const data = await run(['0', 'TEST', null]);
            assert.strictEqual(data['STATUS'], 'invalid: CALLBACK_TICK (sleeping)');
        });
    });
});

describe('Callback @regression @tier3', function () {
    beforeEach(freshHandler);

    afterEach(function () {
        sinon.restore();
    });

    describe('validation guards', function () {
        it('rejects when CALLBACK_BLOCK is in the future', async function () {
            setup({ CALLBACK_BLOCK: 200 }); // > BLOCK_INDEX 100
            const data = await run(['0', 'TEST', null]);
            assert.strictEqual(data['STATUS'], 'invalid: CALLBACK_BLOCK (block index)');
        });

        it('rejects a MEMO containing a pipe', async function () {
            setup();
            const data = await run(['0', 'TEST', 'a|b']);
            assert.strictEqual(data['STATUS'], 'invalid: MEMO (pipe)');
        });

        it('rejects a MEMO containing a semicolon', async function () {
            setup();
            const data = await run(['0', 'TEST', 'a;b']);
            assert.strictEqual(data['STATUS'], 'invalid: MEMO (semicolon)');
        });

        it('rejects a MEMO exceeding MAX_MEMO_LENGTH', async function () {
            setup();
            const data = await run(['0', 'TEST', 'x'.repeat(5000)]);
            assert.strictEqual(data['STATUS'], 'invalid: MEMO (length)');
        });
    });
});
