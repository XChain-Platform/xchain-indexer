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

// The ISSUE handler's format 1 and 3 edits, its ALLOW_LIST and BLOCK_LIST
// references, the issue row it always writes, and its CALLBACK rules. Split
// from ../issue.test.js by behaviour.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createTokenInfo } = require('../../../fixtures/mocks');

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
    // Format 1 : description update
    // -----------------------------------------------------------------------

    describe('format 1 : brief description update', function () {

        it('valid format 1 description update → valid', async function () {
            const source    = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
            const tokenInfo = createTokenInfo({ TICK: 'MYTOKEN', OWNER: source });

            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);

            // Format 1: VERSION|TICK|DESCRIPTION|MEMO
            const params = ['1', 'MYTOKEN', 'New description', ''];
            const data   = makeData({ FORMAT: 1, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('format 1 with locked DESCRIPTION → invalid', async function () {
            const source    = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
            const tokenInfo = createTokenInfo({ TICK: 'MYTOKEN', OWNER: source, LOCK_DESCRIPTION: 1, DESCRIPTION: 'original' });

            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);

            const params = ['1', 'MYTOKEN', 'Changed description', ''];
            const data   = makeData({ FORMAT: 1, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });
});

describe('Issue handler @regression @tier1', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // -----------------------------------------------------------------------
    // Format 3 : lock params update
    // -----------------------------------------------------------------------

    describe('format 3 : lock params update', function () {

        it('valid format 3 lock update sets lock fields', async function () {
            const source    = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
            const tokenInfo = createTokenInfo({ TICK: 'MYTOKEN', OWNER: source, SUPPLY: '100' });

            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getTokenSupply.resolves('100');

            // Format 3: VERSION|TICK|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO
            const params = ['3', 'MYTOKEN', '1', '', '', '', '', '', '', ''];
            const data   = makeData({ FORMAT: 3, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});

describe('Issue handler @regression @tier1', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // -----------------------------------------------------------------------
    // ALLOW_LIST / BLOCK_LIST validation
    // -----------------------------------------------------------------------

    describe('ALLOW_LIST / BLOCK_LIST validation', function () {

        it('invalid ALLOW_LIST reference → invalid', async function () {
            indexer.indexerDb.isValidList.resolves(false);

            const params = makeFormat0Params({ TICK: 'MYTOKEN', ALLOW_LIST: '99' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('valid ALLOW_LIST reference → valid', async function () {
            indexer.indexerDb.isValidList.resolves(true);

            const params = makeFormat0Params({ TICK: 'MYTOKEN', ALLOW_LIST: '5' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('invalid BLOCK_LIST reference → invalid', async function () {
            indexer.indexerDb.isValidList.resolves(false);

            const params = makeFormat0Params({ TICK: 'MYTOKEN', BLOCK_LIST: '99' });
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
    // createIssue is always called (even on invalid)
    // -----------------------------------------------------------------------

    describe('createIssue always called', function () {

        it('createIssue is called even when status is invalid', async function () {
            const params = makeFormat0Params({ TICK: '' }); // invalid tick
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
            assert.ok(indexer.indexerDb.createIssue.calledOnce, 'createIssue must always be called');
        });

        it('createToken is NOT called when status is invalid', async function () {
            const params = makeFormat0Params({ TICK: '' }); // invalid tick
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(!indexer.indexerDb.createToken.called, 'createToken must not be called on invalid');
        });
    });
});

describe('Issue handler @regression @tier1', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // -----------------------------------------------------------------------
    // CALLBACK validations
    // -----------------------------------------------------------------------

    describe('CALLBACK validations', function () {

        it('CALLBACK_BLOCK in the past → invalid', async function () {
            const source    = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
            const tokenInfo = createTokenInfo({ TICK: 'MYTOKEN', OWNER: source });

            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);

            const params = makeFormat0Params({ TICK: 'MYTOKEN', CALLBACK_BLOCK: '50' }); // below BLOCK_INDEX 100
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: 100, SOURCE: source });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('CALLBACK_BLOCK locked and attempting to change → invalid', async function () {
            const source    = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
            const tokenInfo = createTokenInfo({ TICK: 'MYTOKEN', OWNER: source, LOCK_CALLBACK: 1, CALLBACK_BLOCK: '500' });

            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);

            const params = makeFormat0Params({ TICK: 'MYTOKEN', CALLBACK_BLOCK: '600' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });
});
