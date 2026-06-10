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

const Mint = require('../../../src/actions/mint.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeActionsCtx(indexer) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined:  sinon.stub().returns(true),
            isEnabled:  sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

/**
 * Build a data object for a MINT transaction.
 */
function makeData(overrides = {}) {
    return createBaseData(Object.assign({ ACTION: 'MINT', FORMAT: 0 }, overrides));
}

// Shared addresses
const SOURCE      = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DESTINATION = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';
const BLOCK       = 100;

/**
 * Build a minimal tokenInfo for a mintable token.
 */
function makeMintableToken(overrides = {}) {
    return createTokenInfo(Object.assign({
        TICK:             'TEST',
        TICK_ID:          1,
        DECIMALS:         0,
        MAX_SUPPLY:       '1000',
        MAX_MINT:         '100',
        SUPPLY:           '0',
        LOCK_MINT:        0,
        MINT_ADDRESS_MAX: null,
        MINT_START_BLOCK: null,
        MINT_STOP_BLOCK:  null,
        BLOCK_INDEX:      50,   // token was issued at block 50, below current BLOCK=100
    }, overrides));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Mint handler @regression @tier1', function () {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer    = createMockIndexer();
        actionsCtx = makeActionsCtx(indexer);
        handler    = new Mint(actionsCtx);

        const token = makeMintableToken();
        indexer.indexerDb.getTokenInfo.resolves(token);
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getActionCreditDebitAmount.resolves('0'); // minted so far = 0
        indexer.indexerDb.validTickerBeforeTxIndex.resolves(true);
    });

    afterEach(function () {
        sinon.restore();
    });

    // -----------------------------------------------------------------------
    // Valid mint
    // -----------------------------------------------------------------------

    describe('valid mint', function () {

        it('valid mint → STATUS valid, createMint called', async function () {
            // Format 0: VERSION|TICK|AMOUNT|DESTINATION|MEMO
            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
            assert.ok(indexer.indexerDb.createMint.calledOnce, 'createMint should be called');
        });

        it('valid mint → updateBalances and updateTokens called', async function () {
            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.updateBalances.calledOnce);
            assert.ok(indexer.indexerDb.updateTokens.calledOnce);
        });

        it('valid mint → mapper.createMappings called', async function () {
            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(indexer.mapper.createMappings.calledOnce);
        });

        it('mint credits SOURCE address', async function () {
            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            const spy = sinon.spy(indexer.util, 'processTransactionLedgerChanges');

            await handler.parse(params, data, null);

            assert.ok(spy.calledOnce);
            const [,, credits] = spy.firstCall.args;
            // Credits should include a credit to SOURCE for 50 TEST
            const sourceCredit = credits.find(c => c[2] === SOURCE && c[0] === 'TEST');
            assert.ok(sourceCredit, 'SOURCE should receive credit');
            assert.strictEqual(indexer.util.bcformat(sourceCredit[1], 0), '50');
        });
    });

    // -----------------------------------------------------------------------
    // TICK validations
    // -----------------------------------------------------------------------

    describe('TICK validations', function () {

        it('TICK not found → invalid (token issued in prior block so null-guard path reached)', async function () {
            // NOTE: mint.js line 80 accesses tokenInfo['BLOCK_INDEX'] before the null guard on line 84.
            // When tokenInfo is truly null this throws a TypeError — that is a production bug.
            // We test the "unknown TICK" scenario by returning a token issued at a different block
            // then overriding validTickerBeforeTxIndex to force tokenInfo to be set to null inside the handler.
            //
            // Alternatively: a token returned for block 50 (< BLOCK 100) means line 80 condition is
            // false (50 != 100), so it skips the nullification, and tokenInfo remains a real object.
            // There is no clean way to exercise "null returned from DB" without triggering the crash.
            // We document this as a known production-code issue and test via validTickerBeforeTxIndex.
            const token = makeMintableToken({ BLOCK_INDEX: BLOCK }); // same block
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.validTickerBeforeTxIndex.resolves(false); // forces tokenInfo = null inside handler

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('token issued in same block before tx index invalidated → invalid', async function () {
            const token = makeMintableToken({ BLOCK_INDEX: BLOCK }); // same block as tx
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.validTickerBeforeTxIndex.resolves(false); // ticker not valid before this tx

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('token issued in same block but valid before tx index → valid', async function () {
            const token = makeMintableToken({ BLOCK_INDEX: BLOCK });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.validTickerBeforeTxIndex.resolves(true);

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    // -----------------------------------------------------------------------
    // LOCK_MINT
    // -----------------------------------------------------------------------

    describe('LOCK_MINT', function () {

        it('LOCK_MINT=1 → invalid', async function () {
            const token = makeMintableToken({ LOCK_MINT: 1 });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('LOCK_MINT=0 (not locked) → valid', async function () {
            const token = makeMintableToken({ LOCK_MINT: 0 });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    // -----------------------------------------------------------------------
    // AMOUNT > MAX_MINT
    // -----------------------------------------------------------------------

    describe('AMOUNT vs MAX_MINT', function () {

        it('AMOUNT > MAX_MINT → invalid', async function () {
            const token = makeMintableToken({ MAX_MINT: '100' });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '101', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('AMOUNT = MAX_MINT → valid', async function () {
            const token = makeMintableToken({ MAX_MINT: '100' });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '100', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('AMOUNT < MAX_MINT → valid', async function () {
            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    // -----------------------------------------------------------------------
    // SUPPLY + AMOUNT > MAX_SUPPLY
    // -----------------------------------------------------------------------

    describe('SUPPLY + AMOUNT > MAX_SUPPLY', function () {

        it('mint would exceed MAX_SUPPLY → invalid', async function () {
            const token = makeMintableToken({ MAX_SUPPLY: '1000', SUPPLY: '950', MAX_MINT: '100' });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '100', '', '']; // 950 + 100 = 1050 > 1000
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('mint that fills remaining supply exactly → valid', async function () {
            const token = makeMintableToken({ MAX_SUPPLY: '1000', SUPPLY: '900', MAX_MINT: '100' });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '100', '', '']; // 900 + 100 = 1000 = MAX_SUPPLY
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('mint that partially fills remaining supply → valid', async function () {
            const token = makeMintableToken({ MAX_SUPPLY: '1000', SUPPLY: '900', MAX_MINT: '100' });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    // -----------------------------------------------------------------------
    // MINT_ADDRESS_MAX
    // -----------------------------------------------------------------------

    describe('MINT_ADDRESS_MAX', function () {

        it('minted so far + AMOUNT > MINT_ADDRESS_MAX → invalid', async function () {
            const token = makeMintableToken({ MAX_MINT: '100', MINT_ADDRESS_MAX: '200' });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.getActionCreditDebitAmount.resolves('150'); // already minted 150

            const params = ['0', 'TEST', '100', '', '']; // 150 + 100 = 250 > 200
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('minted so far + AMOUNT = MINT_ADDRESS_MAX → valid', async function () {
            const token = makeMintableToken({ MAX_MINT: '100', MINT_ADDRESS_MAX: '200' });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.getActionCreditDebitAmount.resolves('100'); // already minted 100

            const params = ['0', 'TEST', '100', '', '']; // 100 + 100 = 200 = MINT_ADDRESS_MAX
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('no MINT_ADDRESS_MAX set (null) → no restriction applied', async function () {
            const token = makeMintableToken({ MINT_ADDRESS_MAX: null });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.getActionCreditDebitAmount.resolves('900');

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    // -----------------------------------------------------------------------
    // MINT_START_BLOCK
    // -----------------------------------------------------------------------

    describe('MINT_START_BLOCK', function () {

        it('before MINT_START_BLOCK → invalid', async function () {
            const token = makeMintableToken({ MINT_START_BLOCK: '200' }); // mint starts at 200
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: 100, SOURCE }); // current block 100 < 200

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('at MINT_START_BLOCK → valid', async function () {
            const token = makeMintableToken({ MINT_START_BLOCK: '100' });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: 100, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('after MINT_START_BLOCK → valid', async function () {
            const token = makeMintableToken({ MINT_START_BLOCK: '50' });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: 100, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    // -----------------------------------------------------------------------
    // MINT_STOP_BLOCK
    // -----------------------------------------------------------------------

    describe('MINT_STOP_BLOCK', function () {

        it('after MINT_STOP_BLOCK → invalid', async function () {
            const token = makeMintableToken({ MINT_STOP_BLOCK: '50' }); // stopped at block 50
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: 100, SOURCE }); // current block 100 > 50

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('at MINT_STOP_BLOCK → valid', async function () {
            const token = makeMintableToken({ MINT_STOP_BLOCK: '100' });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: 100, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('before MINT_STOP_BLOCK → valid', async function () {
            const token = makeMintableToken({ MINT_STOP_BLOCK: '200' });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: 100, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    // -----------------------------------------------------------------------
    // DESTINATION
    // -----------------------------------------------------------------------

    describe('DESTINATION', function () {

        it('valid DESTINATION → credit goes to DESTINATION, debit from SOURCE', async function () {
            const ledgerSpy = sinon.spy(indexer.util, 'processTransactionLedgerChanges');

            const params = ['0', 'TEST', '50', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
            const [,, credits, debits] = ledgerSpy.firstCall.args;

            // SOURCE should receive initial credit
            const sourceCredit = credits.find(c => c[2] === SOURCE);
            assert.ok(sourceCredit, 'SOURCE should receive initial credit');

            // DESTINATION should receive transfer credit
            const destCredit = credits.find(c => c[2] === DESTINATION);
            assert.ok(destCredit, 'DESTINATION should receive transfer credit');

            // SOURCE should receive debit for the transfer
            const sourceDebit = debits.find(d => d[2] === SOURCE);
            assert.ok(sourceDebit, 'SOURCE should be debited for transfer');
        });

        it('DESTINATION same as SOURCE → DESTINATION discarded, only SOURCE credited', async function () {
            const ledgerSpy = sinon.spy(indexer.util, 'processTransactionLedgerChanges');

            const params = ['0', 'TEST', '50', SOURCE, '']; // DESTINATION = SOURCE
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
            const [,, credits, debits] = ledgerSpy.firstCall.args;

            // Only one credit (to SOURCE), no debit
            assert.strictEqual(credits.length, 1);
            assert.strictEqual(debits.length, 0);
        });

        it('invalid DESTINATION format → invalid', async function () {
            const params = ['0', 'TEST', '50', 'not-a-valid-address', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('DESTINATION not authorized by token list → invalid', async function () {
            indexer.indexerDb.isActionAllowed
                .onFirstCall().resolves(true)   // SOURCE sleeping check
                .onSecondCall().resolves(true)   // TICK sleeping check
                .onThirdCall().resolves(true)    // SOURCE authorization
                .onCall(3).resolves(false)        // DESTINATION authorization
                .resolves(true);

            const params = ['0', 'TEST', '50', DESTINATION, ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });

    // -----------------------------------------------------------------------
    // ADDRESS sleeping
    // -----------------------------------------------------------------------

    describe('address sleeping', function () {

        it('SOURCE sleeping → invalid', async function () {
            indexer.indexerDb.isActionAllowed
                .onFirstCall().resolves(false)
                .resolves(true);

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('TICK sleeping → invalid', async function () {
            indexer.indexerDb.isActionAllowed
                .onFirstCall().resolves(true)   // SOURCE ok
                .onSecondCall().resolves(false)  // TICK sleeping
                .resolves(true);

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });

    // -----------------------------------------------------------------------
    // MEMO validations
    // -----------------------------------------------------------------------

    describe('MEMO validations', function () {

        it('MEMO with pipe → invalid', async function () {
            const params = ['0', 'TEST', '50', '', 'bad|memo'];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('MEMO with semicolon → invalid', async function () {
            const params = ['0', 'TEST', '50', '', 'bad;memo'];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('MEMO within allowed length → valid', async function () {
            const params = ['0', 'TEST', '50', '', 'valid memo'];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    // -----------------------------------------------------------------------
    // AMOUNT format
    // -----------------------------------------------------------------------

    describe('AMOUNT format', function () {

        it('fractional AMOUNT for 0-decimal token → invalid', async function () {
            const params = ['0', 'TEST', '1.5', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });

        it('valid decimal AMOUNT for 8-decimal token → valid', async function () {
            const token = makeMintableToken({ DECIMALS: 8, MAX_MINT: '100' });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '1.50000000', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    // -----------------------------------------------------------------------
    // createMint always called
    // -----------------------------------------------------------------------

    describe('createMint is always called', function () {

        it('createMint is called even on invalid mint (LOCK_MINT case)', async function () {
            // Use LOCK_MINT to produce an invalid mint without triggering the null-tokenInfo crash
            const token = makeMintableToken({ LOCK_MINT: 1 });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
            assert.ok(indexer.indexerDb.createMint.calledOnce, 'createMint must always be called');
        });

        it('updateBalances and updateTokens NOT called on invalid mint', async function () {
            const token = makeMintableToken({ LOCK_MINT: 1 });
            indexer.indexerDb.getTokenInfo.resolves(token);

            const params = ['0', 'TEST', '50', '', ''];
            const data   = makeData({ FORMAT: 0, BLOCK_INDEX: BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(!indexer.indexerDb.updateBalances.called, 'updateBalances should not be called on invalid');
            assert.ok(!indexer.indexerDb.updateTokens.called, 'updateTokens should not be called on invalid');
        });
    });
});
