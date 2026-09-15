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
// WITHDRAW handler: FORMAT validation, the sleeping-tick and canonical-index
// checks, the valid path, CONTRACT_ACTION_INDEX and TICK validation and a
// sleeping SOURCE. The AMOUNT, contract-balance and ledger blocks live beside
// it in withdraw.test/; every file opens the same 'Withdraw handler
// @regression @tier2' describe, so each full test title stays under one suite
// name. withdraw.test/helpers/withdraw_context.js holds the constants, builders
// and the mock indexer every block starts from.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { CONTRACT_INDEX, TICK, makeData, makeWithdrawContext } = require('./withdraw.test/helpers/withdraw_context.js');

let indexer, handler;

// Each test starts from its own mock indexer and WITHDRAW handler.
function freshWithdraw() {
    ({ indexer, handler } = makeWithdrawContext());
}

// -----------------------------------------------------------------------
// FORMAT validation
// -----------------------------------------------------------------------

describe('Withdraw handler @regression @tier2', function () {
    beforeEach(freshWithdraw);
    afterEach(() => sinon.restore());

    describe('FORMAT validation', function () {

        it('unknown format → invalid', async function () {
            const params = ['99', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 99 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('null format → invalid', async function () {
            const params = ['', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: null });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('pre-existing error is preserved', async function () {
            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, 'invalid: upstream');

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });
});

describe('Withdraw handler @regression @tier2', function () {
    beforeEach(freshWithdraw);
    afterEach(() => sinon.restore());

    // WITHDRAW, like every other token-moving handler, must check whether the TICK
    // is asleep, and must not share the /^\d+$/ gate that admits leading-zero (phantom-address) indexes.
    describe('WITHDRAW-1: sleeping-tick + canonical-index enforcement @regression @security', function () {

        it('sleeping TICK → invalid (mirror of DEPOSIT)', async function () {
            // SOURCE awake, but the TICK is asleep: isActionAllowed(null, TICK) → false.
            indexer.indexerDb.isActionAllowed = sinon.stub().callsFake(async (addr, tick) => !(addr === null && tick === TICK));

            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'invalid: TICK (sleeping)');
            assert.ok(!indexer.indexerDb.createCredit.called, 'no ledger movement of a sleeping tick');
        });

        it('rejects a leading-zero CONTRACT_ACTION_INDEX (07) as (format)', async function () {
            const params = ['0', '07', TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(String(data.STATUS).includes('CONTRACT_ACTION_INDEX (format)'));
        });
    });
});

// -----------------------------------------------------------------------
// Valid withdraw
// -----------------------------------------------------------------------

describe('Withdraw handler @regression @tier2', function () {
    beforeEach(freshWithdraw);
    afterEach(() => sinon.restore());

    describe('valid withdraw', function () {

        it('valid withdraw → STATUS valid, createWithdrawal called', async function () {
            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.ok(indexer.indexerDb.createWithdrawal.calledOnce);
        });

        it('valid withdraw → mapper.createMappings called', async function () {
            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(indexer.mapper.createMappings.calledOnce);
        });

        it('valid withdraw → updateBalances called', async function () {
            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.updateBalances.calledOnce);
        });

        it('valid withdraw → updateTokens called', async function () {
            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.updateTokens.calledOnce);
        });
    });
});

// -----------------------------------------------------------------------
// CONTRACT_ACTION_INDEX validations
// -----------------------------------------------------------------------

describe('Withdraw handler @regression @tier2', function () {
    beforeEach(freshWithdraw);
    afterEach(() => sinon.restore());

    describe('CONTRACT_ACTION_INDEX validations', function () {
        it('missing CONTRACT_ACTION_INDEX → invalid', async function () {
            const params = ['0', '', TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('CONTRACT_ACTION_INDEX'));
        });

        it('non-numeric CONTRACT_ACTION_INDEX → invalid (format), not a crash', async function () {
            // Regression twin of deposit.test.js: junk here previously reached the
            // BIGINT row write and wedged block processing under strict SQL mode.
            const params = ['0', 'null', TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('CONTRACT_ACTION_INDEX (format)'));
        });

        it('contract not found → invalid', async function () {
            indexer.indexerDb.getContract.resolves(null);

            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('CONTRACT_ACTION_INDEX'));
        });
    });
});

describe('Withdraw handler @regression @tier2', function () {
    beforeEach(freshWithdraw);
    afterEach(() => sinon.restore());

    describe('CONTRACT_ACTION_INDEX validations', function () {
        it('caller is not contract owner → invalid', async function () {
            indexer.indexerDb.getContract.resolves({ source_id: 99 }); // owned by 99
            indexer.indexerDb.getAddressId.resolves(42);               // caller is 42

            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('not contract owner'));
        });

        it('source address id null → not owner → invalid', async function () {
            indexer.indexerDb.getContract.resolves({ source_id: 42 });
            indexer.indexerDb.getAddressId.resolves(null);

            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('not contract owner'));
        });
    });

    describe('CONTRACT_ACTION_INDEX validations', function () {
        it('createWithdrawal always called even on invalid contract', async function () {
            indexer.indexerDb.getContract.resolves(null);

            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
            assert.ok(indexer.indexerDb.createWithdrawal.calledOnce);
        });
    });
});

// -----------------------------------------------------------------------
// TICK validations
// -----------------------------------------------------------------------

describe('Withdraw handler @regression @tier2', function () {
    beforeEach(freshWithdraw);
    afterEach(() => sinon.restore());

    describe('TICK validations', function () {

        it('TICK not found → invalid', async function () {
            indexer.indexerDb.getTokenInfo.resolves(null);

            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('TICK'));
        });
    });
});

// -----------------------------------------------------------------------
// SOURCE sleeping
// -----------------------------------------------------------------------

describe('Withdraw handler @regression @tier2', function () {
    beforeEach(freshWithdraw);
    afterEach(() => sinon.restore());

    describe('SOURCE sleeping', function () {

        it('SOURCE sleeping → invalid', async function () {
            indexer.indexerDb.isActionAllowed.resolves(false);

            const params = ['0', CONTRACT_INDEX, TICK, '100'];
            const data   = makeData({ FORMAT: 0 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.includes('sleeping'));
        });
    });
});
