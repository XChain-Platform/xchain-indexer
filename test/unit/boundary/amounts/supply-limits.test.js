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

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../fixtures/mocks');

// Import action handlers
const Issue   = require('../../../../src/actions/issue.js');
const Mint    = require('../../../../src/actions/mint.js');
const Destroy = require('../../../../src/actions/destroy.js');
const Send    = require('../../../../src/actions/send.js');

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
            // ISSUANCE_FEE is block-gated (protocol_changes.js: mainnet 862633);
            // mirror that so sub-activation blocks skip the fee (all other changes on).
            isEnabled:  sinon.stub().callsFake(async (name, block) =>
                name === "ISSUANCE_FEE" ? Number(block) >= 862633 : true),
        },
        processAction: sinon.stub().resolves(),
    };
}

// BLOCK_INDEX < 862633 → no issuance fee required
const LOW_BLOCK = 100;

const SOURCE      = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DESTINATION = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';

// ---------------------------------------------------------------------------
// Issue format 0 param builder
// Fields: VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|
//         TRANSFER|TRANSFER_SUPPLY|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|
//         LOCK_SLEEP|LOCK_CALLBACK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|
//         ALLOW_LIST|BLOCK_LIST|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|
//         LOCK_MINT|LOCK_MINT_SUPPLY|MEMO
// ---------------------------------------------------------------------------
function makeIssueParams(overrides = {}) {
    const defaults = {
        VERSION: '0', TICK: 'NEWTOKEN', MAX_SUPPLY: '1000', MAX_MINT: '100',
        DECIMALS: '0', DESCRIPTION: 'Test', MINT_SUPPLY: '', TRANSFER: '',
        TRANSFER_SUPPLY: '', LOCK_MAX_SUPPLY: '', LOCK_MAX_MINT: '',
        LOCK_DESCRIPTION: '', LOCK_SLEEP: '', LOCK_CALLBACK: '',
        CALLBACK_BLOCK: '', CALLBACK_TICK: '', CALLBACK_AMOUNT: '',
        ALLOW_LIST: '', BLOCK_LIST: '', MINT_ADDRESS_MAX: '',
        MINT_START_BLOCK: '', MINT_STOP_BLOCK: '', LOCK_MINT: '',
        LOCK_MINT_SUPPLY: '', MEMO: '',
    };
    const m = Object.assign({}, defaults, overrides);
    return [m.VERSION, m.TICK, m.MAX_SUPPLY, m.MAX_MINT, m.DECIMALS,
        m.DESCRIPTION, m.MINT_SUPPLY, m.TRANSFER, m.TRANSFER_SUPPLY,
        m.LOCK_MAX_SUPPLY, m.LOCK_MAX_MINT, m.LOCK_DESCRIPTION,
        m.LOCK_SLEEP, m.LOCK_CALLBACK, m.CALLBACK_BLOCK, m.CALLBACK_TICK,
        m.CALLBACK_AMOUNT, m.ALLOW_LIST, m.BLOCK_LIST, m.MINT_ADDRESS_MAX,
        m.MINT_START_BLOCK, m.MINT_STOP_BLOCK, m.LOCK_MINT, m.LOCK_MINT_SUPPLY,
        m.MEMO];
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Supply & amount boundary tests @regression @tier1', function () {

    // -----------------------------------------------------------------------
    // AMT-01 & AMT-02 & AMT-03 & AMT-04: ISSUE supply limits
    // -----------------------------------------------------------------------

    describe('AMT-01: Issue token with minimum supply', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Issue(actionsCtx);

            // New token (not previously issued)
            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        });

        afterEach(function () {
            sinon.restore();
        });

        it('MAX_SUPPLY = MIN_TOKEN_SUPPLY (10^-18) with DECIMALS=18 → valid', async function () {
            const params = makeIssueParams({
                TICK:       'MINTOK',
                MAX_SUPPLY: '0.000000000000000001',
                MAX_MINT:   '0.000000000000000001',
                DECIMALS:   '18',
            });
            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    describe('AMT-02: Issue token with maximum supply', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Issue(actionsCtx);

            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        });

        afterEach(function () {
            sinon.restore();
        });

        it('MAX_SUPPLY = MAX_TOKEN_SUPPLY (10^21) with DECIMALS=0 → valid', async function () {
            const params = makeIssueParams({
                TICK:       'MAXTOK',
                MAX_SUPPLY: '1000000000000000000000',
                MAX_MINT:   '1000000000000000000000',
                DECIMALS:   '0',
            });
            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    describe('AMT-03: Issue token exceeding maximum supply', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Issue(actionsCtx);

            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        });

        afterEach(function () {
            sinon.restore();
        });

        // 10^21 + 1 exceeds MAX_TOKEN_SUPPLY (10^21) and must be rejected. This previously
        // slipped through: the overflow guard bcgt(MAX_SUPPLY, MAX_TOKEN_SUPPLY) used mathjs's
        // comparison epsilon (~1e-12 relative), which treated 10^21+1 as equal to 10^21 (NOT a
        // bignumber storage limit (bignumber stores it exactly), a comparison-epsilon bug. The
        // bc* comparators now use decimal.js's exact .gt/.lt, so the overflow is correctly caught.
        it('MAX_SUPPLY = 10^21 + 1 exceeds MAX_TOKEN_SUPPLY → invalid', async function () {
            const params = makeIssueParams({
                TICK:       'OVERTOK',
                MAX_SUPPLY: '1000000000000000000001',
                MAX_MINT:   '1000000000000000000001',
                DECIMALS:   '0',
            });
            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'invalid: MAX_SUPPLY (min/max)');
        });
    });

    describe('AMT-04: Issue token with zero supply', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Issue(actionsCtx);

            indexer.indexerDb.getTokenInfo.resolves(null);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        });

        afterEach(function () {
            sinon.restore();
        });

        // NOTE: The MAX_SUPPLY min/max guard in issue.js uses `bcgt(MAX_SUPPLY, 0)` as a pre-condition,
        // so MAX_SUPPLY=0 bypasses the MIN_TOKEN_SUPPLY check entirely. Zero is treated as a no-op
        // (null-equivalent) rather than a below-minimum value, and the issuance is accepted.
        // This test documents the current behavior.
        it('MAX_SUPPLY = 0 bypasses MIN_TOKEN_SUPPLY check (bcgt guard short-circuits) → valid', async function () {
            const params = makeIssueParams({
                TICK:       'ZEROTOK',
                MAX_SUPPLY: '0',
                MAX_MINT:   '0',
                DECIMALS:   '0',
            });
            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            // bcgt(0, 0) is false → min/max guard skipped → handler accepts zero supply as valid
            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    // -----------------------------------------------------------------------
    // AMT-05 & AMT-06: MINT at supply boundary
    // -----------------------------------------------------------------------

    describe('AMT-05: MINT exactly to MAX_SUPPLY', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Mint(actionsCtx);

            // Token with 100 remaining supply (900 minted, max 1000)
            const token = createTokenInfo({
                TICK:     'TEST',
                TICK_ID:  1,
                DECIMALS: 0,
                MAX_SUPPLY: '1000',
                MAX_MINT:   '100',
                SUPPLY:     '900',
                BLOCK_INDEX: 50,
            });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getActionCreditDebitAmount.resolves('0');
            indexer.indexerDb.validTickerBeforeTxIndex.resolves(true);
        });

        afterEach(function () {
            sinon.restore();
        });

        it('MINT AMOUNT=100 fills exactly to MAX_SUPPLY=1000 → valid', async function () {
            // Format 0: VERSION|TICK|AMOUNT|DESTINATION|MEMO
            const params = ['0', 'TEST', '100', '', ''];
            const data   = createBaseData({ ACTION: 'MINT', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    describe('AMT-06: MINT 1 unit over MAX_SUPPLY', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Mint(actionsCtx);

            // Token with only 99 remaining supply (901 minted, max 1000)
            const token = createTokenInfo({
                TICK:     'TEST',
                TICK_ID:  1,
                DECIMALS: 0,
                MAX_SUPPLY: '1000',
                MAX_MINT:   '100',
                SUPPLY:     '901',
                BLOCK_INDEX: 50,
            });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getActionCreditDebitAmount.resolves('0');
            indexer.indexerDb.validTickerBeforeTxIndex.resolves(true);
        });

        afterEach(function () {
            sinon.restore();
        });

        it('MINT AMOUNT=100 would push supply to 1001 > MAX_SUPPLY=1000 → invalid', async function () {
            const params = ['0', 'TEST', '100', '', ''];
            const data   = createBaseData({ ACTION: 'MINT', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });

    // -----------------------------------------------------------------------
    // AMT-07 & AMT-08: SEND balance boundaries
    // -----------------------------------------------------------------------

    describe('AMT-07: SEND entire balance (drain to zero)', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Send(actionsCtx);

            const token = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            // Balance of exactly 100
            indexer.indexerDb.getAddressBalances.resolves({ 1: '100' });
            indexer.indexerDb.findMatchingDispensers.resolves([]);
            indexer.indexerDb.findDispenserSends.resolves([]);
        });

        afterEach(function () {
            sinon.restore();
        });

        it('SEND AMOUNT=100 drains balance to zero → valid', async function () {
            // Format 0: VERSION|TICK|AMOUNT|DESTINATION|MEMO
            const params = ['0', 'TEST', '100', DESTINATION, ''];
            const data   = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    describe('AMT-08: SEND 1 unit over balance', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Send(actionsCtx);

            const token = createTokenInfo({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            // Balance of 100; sending 101 should fail
            indexer.indexerDb.getAddressBalances.resolves({ 1: '100' });
            indexer.indexerDb.findMatchingDispensers.resolves([]);
            indexer.indexerDb.findDispenserSends.resolves([]);
        });

        afterEach(function () {
            sinon.restore();
        });

        it('SEND AMOUNT=101 exceeds balance of 100 → invalid (insufficient balance)', async function () {
            const params = ['0', 'TEST', '101', DESTINATION, ''];
            const data   = createBaseData({ ACTION: 'SEND', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });

    // -----------------------------------------------------------------------
    // AMT-09: DESTROY entire supply
    // -----------------------------------------------------------------------

    describe('AMT-09: DESTROY entire supply', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Destroy(actionsCtx);

            const token = createTokenInfo({
                TICK:    'TEST',
                TICK_ID: 1,
                DECIMALS: 0,
                SUPPLY:  '500',
            });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.isActionAllowed.resolves(true);
            // Full balance of 500 available
            indexer.indexerDb.getAddressBalances.resolves({ 1: '500' });
            if (indexer.util.resetLists) indexer.util.resetLists();
        });

        afterEach(function () {
            sinon.restore();
        });

        it('DESTROY AMOUNT=500 burns entire supply → valid', async function () {
            // Format 0: VERSION|TICK|AMOUNT|MEMO
            const params = ['0', 'TEST', '500', ''];
            const data   = createBaseData({ ACTION: 'DESTROY', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    // -----------------------------------------------------------------------
    // AMT-10: Maximum precision arithmetic (18 decimals)
    // -----------------------------------------------------------------------

    describe('AMT-10: Maximum precision arithmetic (18 decimals)', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Mint(actionsCtx);

            // Token at 18 decimals; one smallest unit away from full supply
            const token = createTokenInfo({
                TICK:       'HIRES',
                TICK_ID:    1,
                DECIMALS:   18,
                MAX_SUPPLY: '1000.000000000000000000',
                MAX_MINT:   '1.000000000000000000',
                SUPPLY:     '999.999999999999999999',
                BLOCK_INDEX: 50,
            });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getActionCreditDebitAmount.resolves('0');
            indexer.indexerDb.validTickerBeforeTxIndex.resolves(true);
        });

        afterEach(function () {
            sinon.restore();
        });

        it('MINT AMOUNT=0.000000000000000001 (smallest unit) fills last slot → valid', async function () {
            const params = ['0', 'HIRES', '0.000000000000000001', '', ''];
            const data   = createBaseData({ ACTION: 'MINT', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });
    });

    // -----------------------------------------------------------------------
    // AMT-11: MINT at per-address cap (MINT_ADDRESS_MAX)
    // -----------------------------------------------------------------------

    describe('AMT-11: MINT at per-address cap', function () {
        let indexer, actionsCtx, handler;

        beforeEach(function () {
            indexer    = createMockIndexer();
            actionsCtx = makeActionsCtx(indexer);
            handler    = new Mint(actionsCtx);

            const token = createTokenInfo({
                TICK:             'TEST',
                TICK_ID:          1,
                DECIMALS:         0,
                MAX_SUPPLY:       '1000',
                MAX_MINT:         '50',
                SUPPLY:           '0',
                MINT_ADDRESS_MAX: '50',
                BLOCK_INDEX:      50,
            });
            indexer.indexerDb.getTokenInfo.resolves(token);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.validTickerBeforeTxIndex.resolves(true);
        });

        afterEach(function () {
            sinon.restore();
        });

        it('minted so far=49, AMOUNT=1 → exactly at cap → valid', async function () {
            indexer.indexerDb.getSelfMintedAmount.resolves('49');

            const params = ['0', 'TEST', '1', '', ''];
            const data   = createBaseData({ ACTION: 'MINT', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'valid');
        });

        it('minted so far=50, AMOUNT=1 → one over cap (MINT_ADDRESS_MAX=50) → invalid', async function () {
            indexer.indexerDb.getSelfMintedAmount.resolves('50');

            const params = ['0', 'TEST', '1', '', ''];
            const data   = createBaseData({ ACTION: 'MINT', FORMAT: 0, BLOCK_INDEX: LOW_BLOCK, SOURCE });

            await handler.parse(params, data, null);

            assert.ok(data.STATUS.startsWith('invalid'));
        });
    });
});
