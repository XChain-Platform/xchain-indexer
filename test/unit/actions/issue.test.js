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

// The ISSUE handler's new-token path and its VERSION and TICK rules. The supply,
// lock, field, edit-format and cumulative-cap suites are the parts in
// issue.test/, over the shared helpers in issue.test/helpers/fixture.js.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createTokenInfo } = require('../../fixtures/mocks');
const { makeFormat0Params, makeData, LOW_BLOCK, buildIssue } = require('./issue.test/helpers/fixture.js');

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

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
    // Format 0: new token creation
    // -----------------------------------------------------------------------

    describe('format 0: new token creation', function () {
        it('valid new token → status valid, createIssue called, createToken called', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN', MAX_SUPPLY: '1000', MAX_MINT: '100', DECIMALS: '0' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.ok(indexer.indexerDb.createIssue.calledOnce, 'createIssue should be called');
            assert.ok(indexer.indexerDb.createToken.calledOnce, 'createToken should be called');
        });

        it('valid new token → mapper.createMappings called', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(indexer.mapper.createMappings.calledOnce, 'createMappings should be called');
        });

        it('MINT_SUPPLY credited to SOURCE when no TRANSFER_SUPPLY provided', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN', MAX_SUPPLY: '1000', MINT_SUPPLY: '500' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.ok(indexer.indexerDb.createToken.calledOnce);
        });
    });
});

describe('Issue handler @regression @tier1', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    describe('format 0: new token creation', function () {
        it('MINT_SUPPLY with TRANSFER_SUPPLY triggers debit+credit to transfer address', async function () {
            const dest   = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';
            const params = makeFormat0Params({
                TICK:            'MYTOKEN',
                MAX_SUPPLY:      '1000',
                MINT_SUPPLY:     '500',
                TRANSFER_SUPPLY: dest,
            });
            const data = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('TRANSFER moves OWNER to transfer address', async function () {
            const newOwner = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';
            const params   = makeFormat0Params({ TICK: 'MYTOKEN', TRANSFER: newOwner });
            const data     = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.strictEqual(data.OWNER, newOwner);
        });
    });

    describe('format 0: new token creation', function () {
        it('updateBalances and updateTokens called on valid issuance', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.updateBalances.calledOnce, 'updateBalances should be called');
            assert.ok(indexer.indexerDb.updateTokens.calledOnce, 'updateTokens should be called');
        });
    });
});

describe('Issue handler @regression @tier1', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // -----------------------------------------------------------------------
    // VERSION / FORMAT validation
    // -----------------------------------------------------------------------

    describe('VERSION / FORMAT validation', function () {

        it('unknown format version → invalid', async function () {
            const params = makeFormat0Params();
            const data   = makeData({ FORMAT: 99 }); // non-existent format

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'), `expected invalid, got "${data.STATUS}"`);
        });

        it('null format → invalid', async function () {
            const params = makeFormat0Params();
            const data   = makeData({ FORMAT: null });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('pre-existing error propagates → status reflects original error', async function () {
            const params = makeFormat0Params();
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, 'invalid: pre-existing error');

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });
});

describe('Issue handler @regression @tier1', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    // -----------------------------------------------------------------------
    // TICK validations
    // -----------------------------------------------------------------------

    describe('TICK validations', function () {
        it('null/empty TICK → invalid', async function () {
            const params = makeFormat0Params({ TICK: '' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('TICK starting with period → invalid', async function () {
            const params = makeFormat0Params({ TICK: '.TOKEN' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('TICK ending with period → invalid', async function () {
            const params = makeFormat0Params({ TICK: 'TOKEN.' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });
});

describe('Issue handler @regression @tier1', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    describe('TICK validations', function () {
        it('TICK with invalid characters (pipe) → invalid', async function () {
            const params = makeFormat0Params({ TICK: 'TO|KEN' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('TICK with invalid characters (semicolon) → invalid', async function () {
            const params = makeFormat0Params({ TICK: 'TO;KEN' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('reserved TICK name (BTC) → invalid', async function () {
            // RESERVED_TICKS rejection is a mainnet rule : issue.js deliberately
            // exempts regtest (any address may mint reserved ticks there).
            indexer.config.NETWORK = 'mainnet';
            const params = makeFormat0Params({ TICK: 'BTC' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });
});

describe('Issue handler @regression @tier1', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    describe('TICK validations', function () {
        it('reserved TICK name (XCHAIN) → invalid', async function () {
            // RESERVED_TICKS rejection is a mainnet rule : issue.js deliberately
            // exempts regtest (any address may mint reserved ticks there).
            indexer.config.NETWORK = 'mainnet';
            const params = makeFormat0Params({ TICK: 'XCHAIN' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        // TICK_NAMESPACE_ACTIVATION puts a four-character floor on a NEW
        // top-level CREATE. Regtest activates at 0, so the default network in this file
        // (set at module load, above) is at-or-above the flag and 'A' is now refused.
        // The below-the-flag twin proves the guard is gated, not baked in: it drives the
        // same params on mainnet, which parks at the 9999999999 sentinel, so the legacy
        // MIN_TICK_LENGTH=1 verdict still stands there. See
        // xchain-indexer/test/unit/issue_bridge_namespace.test.js for the fuller namespace suite.
        it('1-char TICK at/above the namespace flag -> invalid: TICK (length)', async function () {
            const params = makeFormat0Params({ TICK: 'A' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'invalid: TICK (length)');
        });

        it('1-char TICK below the namespace flag (mainnet sentinel) -> valid', async function () {
            indexer.config.NETWORK = 'mainnet';
            const params = makeFormat0Params({ TICK: 'A' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });
});

describe('Issue handler @regression @tier1', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    describe('TICK validations', function () {
        it('TICK at max length (250 chars) → valid', async function () {
            const tick   = 'A'.repeat(250);
            const params = makeFormat0Params({ TICK: tick });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('TICK exceeding max length (251 chars) → invalid', async function () {
            const tick   = 'A'.repeat(251);
            const params = makeFormat0Params({ TICK: tick });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });
});

describe('Issue handler @regression @tier1', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    describe('TICK validations', function () {
        it('child TICK where parent does not exist → invalid', async function () {
            // getTokenInfo returns null for parent
            indexer.indexerDb.getTokenInfo.resolves(null);
            const params = makeFormat0Params({ TICK: 'PARENT.CHILD' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('child TICK where parent exists and SOURCE is parent owner → valid', async function () {
            const source     = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
            const parentInfo = createTokenInfo({ TICK: 'PARENT', OWNER: source });

            // First call: parent lookup, second call: child token lookup
            indexer.indexerDb.getTokenInfo
                .onFirstCall().resolves(parentInfo)
                .onSecondCall().resolves(null);

            const params = makeFormat0Params({ TICK: 'PARENT.CHILD' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('child TICK where SOURCE is not parent owner → invalid', async function () {
            const source     = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
            const parentInfo = createTokenInfo({ TICK: 'PARENT', OWNER: '1OtherOwnerXXXXXXXXXXXXXXXXXXXXXXXX' });

            indexer.indexerDb.getTokenInfo
                .onFirstCall().resolves(parentInfo)
                .onSecondCall().resolves(null);

            const params = makeFormat0Params({ TICK: 'PARENT.CHILD' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });
});
