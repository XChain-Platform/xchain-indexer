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

// The ISSUE handler's DECIMALS, MAX_SUPPLY, re-issuance ownership, lock
// immutability, MINT_SUPPLY and MINT_ADDRESS_MAX rules. Split from
// ../issue.test.js by behaviour.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createTokenInfo } = require('../../../../fixtures/mocks');

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
    // DECIMALS validation
    // -----------------------------------------------------------------------

    describe('DECIMALS validation', function () {

        it('DECIMALS = 0 → valid', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN', DECIMALS: '0' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('DECIMALS = 18 (max) → valid', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN', DECIMALS: '18' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('DECIMALS = 19 (above max) → invalid', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN', DECIMALS: '19' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('DECIMALS cannot be changed once supply is issued', async function () {
            const source    = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
            const tokenInfo = createTokenInfo({ TICK: 'MYTOKEN', OWNER: source, DECIMALS: 0, SUPPLY: '100' });

            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.isDistributed.resolves(true);

            const params = makeFormat0Params({ TICK: 'MYTOKEN', DECIMALS: '8' }); // change from 0 to 8
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });
});

describe('Issue handler @regression @tier1', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // -----------------------------------------------------------------------
    // MAX_SUPPLY validation
    // -----------------------------------------------------------------------

    describe('MAX_SUPPLY validation', function () {

        it('MAX_SUPPLY above MAX_TOKEN_SUPPLY → invalid', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN', MAX_SUPPLY: '9999999999999999999999' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('MAX_SUPPLY below current SUPPLY → invalid', async function () {
            const source    = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
            const tokenInfo = createTokenInfo({ TICK: 'MYTOKEN', OWNER: source, SUPPLY: '500' });

            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getTokenSupply.resolves('500');

            const params = makeFormat0Params({ TICK: 'MYTOKEN', MAX_SUPPLY: '100' }); // less than supply
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('MAX_SUPPLY locked and attempting to change → invalid', async function () {
            const source    = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
            const tokenInfo = createTokenInfo({ TICK: 'MYTOKEN', OWNER: source, MAX_SUPPLY: '1000', LOCK_MAX_SUPPLY: 1, SUPPLY: '100' });

            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getTokenSupply.resolves('100');

            const params = makeFormat0Params({ TICK: 'MYTOKEN', MAX_SUPPLY: '2000' }); // different from locked
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });
});

describe('Issue handler @regression @tier1', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // -----------------------------------------------------------------------
    // Re-issuance / ownership
    // -----------------------------------------------------------------------

    describe('re-issuance / ownership', function () {

        it('re-issuance by non-owner → invalid', async function () {
            const tokenInfo = createTokenInfo({ TICK: 'MYTOKEN', OWNER: '1OtherAddressXXXXXXXXXXXXXXXXXXXXX' });

            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);

            const params = makeFormat0Params({ TICK: 'MYTOKEN' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK,
                SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH' });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('re-issuance by owner → valid', async function () {
            const source    = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
            const tokenInfo = createTokenInfo({ TICK: 'MYTOKEN', OWNER: source });

            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);

            const params = makeFormat0Params({ TICK: 'MYTOKEN' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});

describe('Issue handler @regression @tier1', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // -----------------------------------------------------------------------
    // Lock immutability
    // -----------------------------------------------------------------------

    describe('lock immutability', function () {
        it('attempting to unlock LOCK_MINT (set from 1 to 0) → invalid', async function () {
            const source    = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
            const tokenInfo = createTokenInfo({ TICK: 'MYTOKEN', OWNER: source, LOCK_MINT: 1 });

            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);

            // Format 3 edits lock fields: VERSION|TICK|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO
            const params = ['3', 'MYTOKEN', '', '', '', '', '', '0', '', '']; // trying to set LOCK_MINT=0
            const data   = makeData({ FORMAT: 3, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('LOCK_MAX_SUPPLY can be set from 0 to 1 (valid lock) when supply exists', async function () {
            const source    = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
            const tokenInfo = createTokenInfo({ TICK: 'MYTOKEN', OWNER: source, LOCK_MAX_SUPPLY: 0, SUPPLY: '100' });

            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getTokenSupply.resolves('100');

            // Format 3: VERSION|TICK|LOCK_MAX_SUPPLY|...
            const params = ['3', 'MYTOKEN', '1', '', '', '', '', '', '', ''];
            const data   = makeData({ FORMAT: 3, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('explicit LOCK_MAX_SUPPLY=0 on an uncapped token (no MAX_SUPPLY) is a valid no-op lock', async function () {
            const source    = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
            // Uncapped token: no MAX_SUPPLY declared. Locking nothing (0) must not be
            // treated as a locking intent, so the "no max supply" cap-check must not fire.
            const tokenInfo = createTokenInfo({ TICK: 'MYTOKEN', OWNER: source, MAX_SUPPLY: null, LOCK_MAX_SUPPLY: 0, SUPPLY: '100' });

            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);
            indexer.indexerDb.getTokenSupply.resolves('100');

            // Format 3 lock-params edit that explicitly zero-fills LOCK_MAX_SUPPLY:
            // VERSION|TICK|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO
            const params = ['3', 'MYTOKEN', '0', '', '', '', '', '', '', ''];
            const data   = makeData({ FORMAT: 3, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});

describe('Issue handler @regression @tier1', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    describe('lock immutability', function () {
        it('LOCK_DESCRIPTION prevents description changes', async function () {
            const source    = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
            const tokenInfo = createTokenInfo({ TICK: 'MYTOKEN', OWNER: source, LOCK_DESCRIPTION: 1, DESCRIPTION: 'original' });

            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);

            const params = makeFormat0Params({ TICK: 'MYTOKEN', DESCRIPTION: 'changed' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('LOCK_MAX_MINT prevents MAX_MINT changes', async function () {
            const source    = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
            const tokenInfo = createTokenInfo({ TICK: 'MYTOKEN', OWNER: source, LOCK_MAX_MINT: 1, MAX_MINT: '100' });

            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);

            const params = makeFormat0Params({ TICK: 'MYTOKEN', MAX_MINT: '200' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('MINT_SUPPLY locked by LOCK_MINT_SUPPLY → invalid', async function () {
            const source    = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
            const tokenInfo = createTokenInfo({ TICK: 'MYTOKEN', OWNER: source, LOCK_MINT_SUPPLY: 1 });

            indexer.indexerDb.getTokenInfo.resolves(tokenInfo);

            const params = makeFormat0Params({ TICK: 'MYTOKEN', MINT_SUPPLY: '100' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });
});

describe('Issue handler @regression @tier1', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // -----------------------------------------------------------------------
    // MINT_SUPPLY validations
    // -----------------------------------------------------------------------

    describe('MINT_SUPPLY validations', function () {

        it('MINT_SUPPLY greater than MAX_SUPPLY → invalid', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN', MAX_SUPPLY: '1000', MINT_SUPPLY: '2000' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('MINT_SUPPLY equals MAX_SUPPLY → valid', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN', MAX_SUPPLY: '1000', MINT_SUPPLY: '1000' });
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
    // MINT_ADDRESS_MAX validations
    // -----------------------------------------------------------------------

    describe('MINT_ADDRESS_MAX validations', function () {

        it('MINT_ADDRESS_MAX > MAX_SUPPLY → invalid', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN', MAX_SUPPLY: '1000', MAX_MINT: '100', MINT_ADDRESS_MAX: '2000' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('MINT_ADDRESS_MAX < MAX_MINT → invalid', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN', MAX_SUPPLY: '1000', MAX_MINT: '100', MINT_ADDRESS_MAX: '50' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('valid MINT_ADDRESS_MAX (>= MAX_MINT and <= MAX_SUPPLY) → valid', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN', MAX_SUPPLY: '1000', MAX_MINT: '100', MINT_ADDRESS_MAX: '200' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});
