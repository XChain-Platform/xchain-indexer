'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Issue = require('../../../src/actions/issue.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an actionsCtx object the Issue handler expects.
 */
function makeActionsCtx(indexer) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined:  sinon.stub().returns(true),
            // ISSUANCE_FEE is block-gated (protocol_changes.js: mainnet 862633);
            // mirror that so sub-activation blocks skip the fee (all other changes on).
            isEnabled:  sinon.stub().callsFake(async (name, block) =>
                name === "ISSUANCE_FEE" ? Number(block) >= 862633 : true),
        },
        processAction: sinon.stub().resolves(),
    };
}

/**
 * Build the params array for format 0 (full).
 * Fields: VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|
 *         TRANSFER|TRANSFER_SUPPLY|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|
 *         LOCK_SLEEP|LOCK_CALLBACK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|
 *         ALLOW_LIST|BLOCK_LIST|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|
 *         LOCK_MINT|LOCK_MINT_SUPPLY|MEMO
 */
function makeFormat0Params(overrides = {}) {
    const defaults = {
        VERSION:         '0',
        TICK:            'TEST',
        MAX_SUPPLY:      '1000',
        MAX_MINT:        '100',
        DECIMALS:        '0',
        DESCRIPTION:     'Test token',
        MINT_SUPPLY:     '',
        TRANSFER:        '',
        TRANSFER_SUPPLY: '',
        LOCK_MAX_SUPPLY: '',
        LOCK_MAX_MINT:   '',
        LOCK_DESCRIPTION:'',
        LOCK_SLEEP:      '',
        LOCK_CALLBACK:   '',
        CALLBACK_BLOCK:  '',
        CALLBACK_TICK:   '',
        CALLBACK_AMOUNT: '',
        ALLOW_LIST:      '',
        BLOCK_LIST:      '',
        MINT_ADDRESS_MAX:'',
        MINT_START_BLOCK:'',
        MINT_STOP_BLOCK: '',
        LOCK_MINT:       '',
        LOCK_MINT_SUPPLY:'',
        MEMO:            '',
    };
    const merged = Object.assign({}, defaults, overrides);
    return [
        merged.VERSION, merged.TICK, merged.MAX_SUPPLY, merged.MAX_MINT, merged.DECIMALS,
        merged.DESCRIPTION, merged.MINT_SUPPLY, merged.TRANSFER, merged.TRANSFER_SUPPLY,
        merged.LOCK_MAX_SUPPLY, merged.LOCK_MAX_MINT, merged.LOCK_DESCRIPTION,
        merged.LOCK_SLEEP, merged.LOCK_CALLBACK, merged.CALLBACK_BLOCK, merged.CALLBACK_TICK,
        merged.CALLBACK_AMOUNT, merged.ALLOW_LIST, merged.BLOCK_LIST, merged.MINT_ADDRESS_MAX,
        merged.MINT_START_BLOCK, merged.MINT_STOP_BLOCK, merged.LOCK_MINT, merged.LOCK_MINT_SUPPLY,
        merged.MEMO,
    ];
}

/**
 * Create a data object for ISSUE with a given format version already resolved.
 */
function makeData(overrides = {}) {
    return createBaseData(Object.assign({ ACTION: 'ISSUE', FORMAT: 0 }, overrides));
}

// ---------------------------------------------------------------------------
// Shared setup: new-token tests need an XCHAIN balance to pay the issuance fee.
// BLOCK_INDEX < 862633 skips the fee requirement entirely.
// ---------------------------------------------------------------------------
const LOW_BLOCK = 100; // below 862633 → no fee required for new token

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Issue handler @regression @tier1', function () {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        handler    = new Issue(actionsCtx);

        // Default: no existing token, not distributed
        indexer.indexerDb.getTokenInfo.resolves(null);
        indexer.indexerDb.isDistributed.resolves(false);
        // isActionAllowed returns true (address not sleeping)
        indexer.indexerDb.isActionAllowed.resolves(true);
        // Zero fee scenario - no GAS balance needed when block < 862633
        indexer.indexerDb.getAddressBalances.resolves({});
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getTokenSupply.resolves('0');
    });

    afterEach(function () {
        sinon.restore();
    });

    // -----------------------------------------------------------------------
    // Format 0 — new token creation
    // -----------------------------------------------------------------------

    describe('format 0 — new token creation', function () {

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

        it('updateBalances and updateTokens called on valid issuance', async function () {
            const params = makeFormat0Params({ TICK: 'MYTOKEN' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.updateBalances.calledOnce, 'updateBalances should be called');
            assert.ok(indexer.indexerDb.updateTokens.calledOnce, 'updateTokens should be called');
        });
    });

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
            // RESERVED_TICKS rejection is a mainnet rule — issue.js deliberately
            // exempts regtest (any address may mint reserved ticks there).
            indexer.config.NETWORK = 'mainnet';
            const params = makeFormat0Params({ TICK: 'BTC' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('reserved TICK name (XCHAIN) → invalid', async function () {
            // RESERVED_TICKS rejection is a mainnet rule — issue.js deliberately
            // exempts regtest (any address may mint reserved ticks there).
            indexer.config.NETWORK = 'mainnet';
            const params = makeFormat0Params({ TICK: 'XCHAIN' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('valid 1-char TICK → valid', async function () {
            const params = makeFormat0Params({ TICK: 'A' });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

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

    // -----------------------------------------------------------------------
    // TRANSFER_SUPPLY same as SOURCE is discarded
    // -----------------------------------------------------------------------

    describe('TRANSFER_SUPPLY == SOURCE is discarded', function () {

        it('TRANSFER_SUPPLY equal to SOURCE is removed silently', async function () {
            const source = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
            const params = makeFormat0Params({ TICK: 'MYTOKEN', MAX_SUPPLY: '1000', MINT_SUPPLY: '100', TRANSFER_SUPPLY: source });
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE: source });

            await handler.parse(params, data, null);

            // Still valid — self-transfer is silently discarded
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

    // -----------------------------------------------------------------------
    // Format 1 — description update
    // -----------------------------------------------------------------------

    describe('format 1 — brief description update', function () {

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

    // -----------------------------------------------------------------------
    // Format 3 — lock params update
    // -----------------------------------------------------------------------

    describe('format 3 — lock params update', function () {

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
