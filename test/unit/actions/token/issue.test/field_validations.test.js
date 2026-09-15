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

// SOURCE sleeping and the ISSUE handler's DESCRIPTION, TRANSFER_SUPPLY,
// TRANSFER, MINT_START_BLOCK / MINT_STOP_BLOCK and MEMO field rules. Split from
// ../issue.test.js by behaviour.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { makeFormat0Params, makeData, LOW_BLOCK, buildIssue } = require('./helpers/fixture.js');

// Rebuilt by setUp before every test. Module-level so the same-title sibling
// suites below, split only to fit the function-length limit with every full
// test title unchanged, share one fixture.
let indexer, handler;

function setUp() {
    ({ indexer, handler } = buildIssue());
}

function tearDown() {
    sinon.restore();
}

describe('Issue handler @regression @tier1', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // -----------------------------------------------------------------------
    // ADDRESS sleeping
    // -----------------------------------------------------------------------

    describe('address sleeping', function () {

        it('SOURCE sleeping → invalid', async function () {
            indexer.indexerDb.isActionAllowed.resolves(false);

            const params = makeFormat0Params({ TICK: 'MYTOKEN' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });

    // -----------------------------------------------------------------------
    // DESCRIPTION validations
    // -----------------------------------------------------------------------

    describe('DESCRIPTION validations', function () {

        it('DESCRIPTION at max length (249) → valid', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN', DESCRIPTION: 'A'.repeat(249) });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('DESCRIPTION at/over max length (250) → invalid', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN', DESCRIPTION: 'A'.repeat(250) });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });
});

describe('Issue handler @regression @tier1', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // -----------------------------------------------------------------------
    // TRANSFER_SUPPLY same as SOURCE is discarded
    // -----------------------------------------------------------------------

    describe('TRANSFER_SUPPLY == SOURCE is discarded', function () {

        it('TRANSFER_SUPPLY equal to SOURCE is removed silently', async function () {
            const source = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
            const params = makeFormat0Params({ TICK: 'MYTOKEN', MAX_SUPPLY: '1000', MINT_SUPPLY: '100', TRANSFER_SUPPLY: source });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            // Still valid : self-transfer is silently discarded
            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    // -----------------------------------------------------------------------
    // TRANSFER address validation
    // -----------------------------------------------------------------------

    describe('TRANSFER address validation', function () {

        it('invalid TRANSFER address → invalid', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN', TRANSFER: 'not-a-valid-address' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });
});

describe('Issue handler @regression @tier1', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // -----------------------------------------------------------------------
    // MINT_START/STOP_BLOCK validations
    // -----------------------------------------------------------------------

    describe('MINT_START/STOP_BLOCK validations', function () {

        it('MINT_START_BLOCK in the past → invalid', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN', MINT_START_BLOCK: '50' }); // below BLOCK_INDEX 100
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: 100 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('MINT_STOP_BLOCK in the past → invalid', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN', MINT_STOP_BLOCK: '50' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: 100 });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('MINT_STOP_BLOCK < MINT_START_BLOCK → invalid', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN', MINT_START_BLOCK: '200', MINT_STOP_BLOCK: '150' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('valid MINT_START_BLOCK and MINT_STOP_BLOCK → valid', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN', MINT_START_BLOCK: '200', MINT_STOP_BLOCK: '300' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});

describe('Issue handler @regression @tier1', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // -----------------------------------------------------------------------
    // MEMO validations
    // -----------------------------------------------------------------------

    describe('MEMO validations', function () {

        it('MEMO with pipe → invalid', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN', MEMO: 'bad|memo' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('MEMO with semicolon → invalid', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN', MEMO: 'bad;memo' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('MEMO at max length (250) → valid', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN', MEMO: 'A'.repeat(250) });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('MEMO over max length (251) → invalid', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN', MEMO: 'A'.repeat(251) });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });
});
