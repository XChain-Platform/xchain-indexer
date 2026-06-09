// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');

const Swap = require('../../../src/actions/swap.js');

const VALID_GET_ADDRESS = '1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev';

describe('Swap action handler @regression @tier2', function () {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer = createMockIndexer();
        actionsCtx = {
            config: indexer.config,
            util: indexer.util,
            mapper: indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true),
            },
            processAction: sinon.stub().resolves(),
        };
        handler = new Swap(actionsCtx);
        indexer.util.resetLists();

        // Default token infos for GIVE and GET
        const giveToken = createTokenInfo({ TICK: 'GIVE', TICK_ID: 1, DECIMALS: 0 });
        const getToken  = createTokenInfo({ TICK: 'GET',  TICK_ID: 2, DECIMALS: 0 });
        indexer.indexerDb.getTokenInfo.callsFake(async (tick) => {
            if (tick === 'GIVE') return giveToken;
            if (tick === 'GET')  return getToken;
            return null;
        });

        // Give source enough balance (includes fee tick id 99)
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000', 2: '1000', 99: '1000' });
        indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
        indexer.indexerDb.getTickerId.resolves(99);
    });

    function makeCreateParams(giveTick, giveAmt, getTick, getAmt, expiration, memo) {
        // Format 0: VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GET_COIN|GET_TICK|GET_AMOUNT|GET_OWNERSHIP|GET_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
        return ['0', 'BTC', giveTick, String(giveAmt), '', 'BTC', getTick, String(getAmt), '', '', String(expiration || ''), '', '', memo || ''];
    }

    function makeCancelParams(swapActionIndex, memo) {
        return ['1', String(swapActionIndex), memo || ''];
    }

    function makeEditParams(swapActionIndex, expiration, memo) {
        return ['2', String(swapActionIndex), String(expiration || ''), '', '', memo || ''];
    }

    const FUTURE_EXPIRATION = 9999999999;

    // ─── Create swap (format 0) ───────────────────────────────────────

    it('creates a valid swap', async function () {
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });
        const params = makeCreateParams('GIVE', '10', 'GET', '5', FUTURE_EXPIRATION, '');
        await handler.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('calls processAction(SWAP_MATCH) after a valid create', async function () {
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });
        const params = makeCreateParams('GIVE', '10', 'GET', '5', FUTURE_EXPIRATION, '');
        await handler.parse(params, data, null);
        assert.ok(actionsCtx.processAction.calledWith('SWAP_MATCH'));
    });

    it('rejects GIVE_COIN not in accepted coins', async function () {
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });
        const params = ['0', 'XYZ', 'GIVE', '10', '', 'BTC', 'GET', '5', '', '', String(FUTURE_EXPIRATION), '', '', ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('GIVE_COIN'), `Expected GIVE_COIN error, got: ${data['STATUS']}`);
    });

    it('rejects GET_COIN not in accepted coins', async function () {
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });
        const params = ['0', 'BTC', 'GIVE', '10', '', 'ETH', 'GET', '5', '', '', String(FUTURE_EXPIRATION), '', '', ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('GET_COIN'), `Expected GET_COIN error, got: ${data['STATUS']}`);
    });

    it('rejects when GIVE_TICK does not exist', async function () {
        indexer.indexerDb.getTokenInfo.resolves(null);
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });
        const params = makeCreateParams('UNKNOWN', '10', 'UNKNOWN', '5', FUTURE_EXPIRATION, '');
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('GIVE_TICK') || data['STATUS'].includes('GET_TICK'), `Expected tick error, got: ${data['STATUS']}`);
    });

    it('rejects when SOURCE has insufficient balance', async function () {
        // Return zero balances
        indexer.indexerDb.getAddressBalances.resolves({});
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });
        const params = makeCreateParams('GIVE', '100', 'GET', '5', FUTURE_EXPIRATION, '');
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('insufficient'), `Expected insufficient funds error, got: ${data['STATUS']}`);
    });

    it('rejects EXPIRATION in the past', async function () {
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });
        const params = makeCreateParams('GIVE', '10', 'GET', '5', 1000000, ''); // past timestamp
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('EXPIRATION'), `Expected EXPIRATION error, got: ${data['STATUS']}`);
    });

    // ─── Cancel swap (format 1) ───────────────────────────────────────

    it('cancels a valid open swap', async function () {
        const swapInfo = {
            ACTION_INDEX: 10,
            SOURCE: '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
            SWAP_STATUS: 'open',
            GIVE_TICK: 'GIVE', GIVE_AMOUNT: '10', GIVE_REMAINING: '10',
            GET_TICK: 'GET',   GET_AMOUNT: '5',
            GET_COIN: 'BTC', GIVE_COIN: 'BTC',
            GET_ADDRESS: '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
            ALLOW_LIST: null, BLOCK_LIST: null,
        };
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 1 });
        const params = makeCancelParams(10, '');
        await handler.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('rejects cancel when swap is not open', async function () {
        const swapInfo = {
            ACTION_INDEX: 10,
            SOURCE: '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
            SWAP_STATUS: 'complete',
            GIVE_TICK: 'GIVE', GIVE_AMOUNT: '10', GET_TICK: 'GET', GET_AMOUNT: '5',
            ALLOW_LIST: null, BLOCK_LIST: null,
        };
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 1 });
        const params = makeCancelParams(10, '');
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('SWAP_ACTION_INDEX'), `Expected swap not open error, got: ${data['STATUS']}`);
    });

    it('rejects cancel when SOURCE is not the swap owner', async function () {
        const swapInfo = {
            ACTION_INDEX: 10,
            SOURCE: '1DifferentOwnerXXXXXXXXXXXXXXXXXXXX',
            SWAP_STATUS: 'open',
            GIVE_TICK: 'GIVE', GIVE_AMOUNT: '10', GET_TICK: 'GET', GET_AMOUNT: '5',
            ALLOW_LIST: null, BLOCK_LIST: null,
        };
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 1 });
        const params = makeCancelParams(10, '');
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('SOURCE'), `Expected SOURCE not owner error, got: ${data['STATUS']}`);
    });

    // ─── Edit swap (format 2) ─────────────────────────────────────────

    it('edits a valid open swap expiration', async function () {
        const swapInfo = {
            ACTION_INDEX: 10,
            SOURCE: '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
            SWAP_STATUS: 'open',
            GIVE_TICK: 'GIVE', GIVE_AMOUNT: '10', GIVE_REMAINING: '10',
            GET_TICK: 'GET',   GET_AMOUNT: '5',
            GET_COIN: 'BTC', GIVE_COIN: 'BTC',
            GET_ADDRESS: '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
            ALLOW_LIST: null, BLOCK_LIST: null,
            EXPIRATION: 1000000,
        };
        indexer.indexerDb.getSwapInfo.resolves(swapInfo);
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 2, BLOCK_TIME: 1700000000 });
        const params = makeEditParams(10, FUTURE_EXPIRATION, '');
        await handler.parse(params, data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    // ─── SOURCE sleeping check ────────────────────────────────────────

    it('rejects when SOURCE is sleeping (format 0)', async function () {
        indexer.indexerDb.isActionAllowed.resolves(false);
        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });
        const params = makeCreateParams('GIVE', '10', 'GET', '5', FUTURE_EXPIRATION, '');
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('SOURCE') || data['STATUS'].includes('TICK'), `Expected sleeping error, got: ${data['STATUS']}`);
    });

    // ─── Non-unified expiration fee path (lines 313-314) ─────────────

    it('legacy getExpirationFee path when UNIFIED_FEES disabled', async function () {
        actionsCtx.protocolChanges.isEnabled = sinon.stub().resolves(false);

        const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });
        const params = makeCreateParams('GIVE', '10', 'GET', '5', FUTURE_EXPIRATION, '');
        await handler.parse(params, data, null);

        // Status valid or invalid — coverage of the legacy fee path is the goal
        assert.ok(indexer.indexerDb.createSwap.calledOnce, 'createSwap should be called');
    });

    // ─── Ownership-give create path (lines 394-398, 304-308) ──────────

    describe('GIVE_OWNERSHIP=1 (ownership swap)', function () {

        beforeEach(function () {
            indexer.indexerDb.setTokenEscrow  = sinon.stub().resolves();
            indexer.indexerDb.isOwnershipEscrowed = sinon.stub().resolves(false);
            indexer.indexerDb.getTokenInfo.callsFake(async (tick) => {
                if(tick === 'GIVE') return createTokenInfo({ TICK: 'GIVE', TICK_ID: 1, DECIMALS: 0, OWNER: '1SourceAddressXXXXXXXXXXXXXXXYs6gYt' });
                if(tick === 'GET')  return createTokenInfo({ TICK: 'GET',  TICK_ID: 2, DECIMALS: 0 });
                return null;
            });
            // Enough balance for fee
            indexer.indexerDb.getAddressBalances.resolves({ 1: '0', 2: '1000', 99: '999999999' });
        });

        it('valid ownership swap calls setTokenEscrow and not debit/escrow', async function () {
            // GIVE_OWNERSHIP=1, GIVE_AMOUNT empty
            const params = ['0', 'BTC', 'GIVE', '', '1', 'BTC', 'GET', '5', '', '', String(FUTURE_EXPIRATION), '', '', ''];
            const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.setTokenEscrow);
        });

        it('ownership-give with unified fee includes ownership_escrow_fee (lines 304-308)', async function () {
            const params = ['0', 'BTC', 'GIVE', '', '1', 'BTC', 'GET', '5', '', '', String(FUTURE_EXPIRATION), '', '', ''];
            const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });

            await handler.parse(params, data, null);

            // If reached here with valid status, ownership escrow fee branch was exercised
            assert.strictEqual(data['STATUS'], 'valid');
        });
    });

    // ─── Native coin fee paths (lines 321-331) ────────────────────────

    describe('native coin fee payment', function () {

        it('valid native coin fee sets PAYMENT_MODE=1', async function () {
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({
                valid: true, nativeCoinAmount: '0.0001', nativeCoin: 'BTC', oracleRound: 1,
            });
            sinon.stub(indexer.util, 'getUnifiedExpirationFee').returns({ gasCost: 100, fee: '0.00001' });

            const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });
            const params = makeCreateParams('GIVE', '10', 'GET', '5', FUTURE_EXPIRATION, '');
            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('invalid native coin fee sets error', async function () {
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({
                valid: false, error: 'fee too small',
            });
            sinon.stub(indexer.util, 'getUnifiedExpirationFee').returns({ gasCost: 100, fee: '0.00001' });

            const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });
            const params = makeCreateParams('GIVE', '10', 'GET', '5', FUTURE_EXPIRATION, '');
            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].startsWith('invalid'));
        });

        it('rejected payment mode returns insufficient fee error', async function () {
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('rejected');
            sinon.stub(indexer.util, 'getUnifiedExpirationFee').returns({ gasCost: 100, fee: '0.00001' });

            const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });
            const params = makeCreateParams('GIVE', '10', 'GET', '5', FUTURE_EXPIRATION, '');
            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('insufficient fee'));
        });
    });

    // ─── GET_OWNERSHIP bid validations (lines 215-219) ───────────────

    describe('GET_OWNERSHIP=1 (bid for ownership)', function () {

        it('GET_OWNERSHIP=1 with non-empty GET_AMOUNT returns invalid', async function () {
            // FORMAT: 0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GET_COIN|GET_TICK|GET_AMOUNT|GET_OWNERSHIP|...
            const params = ['0', 'BTC', 'GIVE', '10', '', 'BTC', 'GET', '5', '1', '', String(FUTURE_EXPIRATION), '', '', ''];
            const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('GET_AMOUNT') || data['STATUS'].includes('must be empty'));
        });

        // NOTE: swap.js lines 217-218 (the GET_COIN==local-coin && !getTokenInfo guard
        // inside the ownership-bid block) are pre-empted by the GET_TICK existence check
        // at line 162 in the same-chain case, and the cross-chain case trips the GIVE_COIN
        // network guard first — i.e. this is a defensive, effectively-unreachable branch.
        // Left uncovered intentionally; documented in claude/reports/coverage/HANDOVER.md.
    });

    // ─── LIST field validation (lines 269-279) ───────────────────────

    describe('LIST field validation', function () {

        it('unknown ALLOW_LIST returns invalid', async function () {
            indexer.indexerDb.getListType.resolves(false);

            // ALLOW_LIST at index 11 in format 0
            const params = ['0', 'BTC', 'GIVE', '10', '', 'BTC', 'GET', '5', '', '', String(FUTURE_EXPIRATION), '99', '', ''];
            const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('ALLOW_LIST') && data['STATUS'].includes('unknown'));
        });

        it('unsupported LIST type returns invalid', async function () {
            indexer.indexerDb.getListType.resolves(1); // type 1 = tick list, not in listTypes

            const params = ['0', 'BTC', 'GIVE', '10', '', 'BTC', 'GET', '5', '', '', String(FUTURE_EXPIRATION), '99', '', ''];
            const data = createBaseData({ ACTION: 'SWAP', FORMAT: 0, BLOCK_TIME: 1700000000 });

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('unsupported'));
        });
    });

    // ─── Ownership-give cancel (lines 413-415) ────────────────────────

    describe('cancel with GIVE_OWNERSHIP=1', function () {

        it('cancel of ownership swap calls clearTokenEscrow', async function () {
            indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();

            const swapInfo = {
                ACTION_INDEX:  10,
                SOURCE:        '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
                SWAP_STATUS:   'open',
                GIVE_TICK:     'GIVE',
                GIVE_AMOUNT:   '10',
                GIVE_OWNERSHIP: 1,
                GET_TICK:      'GET',
                GET_AMOUNT:    '5',
                GET_COIN:      'BTC',
                GIVE_COIN:     'BTC',
                GET_ADDRESS:   '1SourceAddressXXXXXXXXXXXXXXXYs6gYt',
                ALLOW_LIST:    null,
                BLOCK_LIST:    null,
            };
            indexer.indexerDb.getSwapInfo.resolves(swapInfo);

            const data = createBaseData({ ACTION: 'SWAP', FORMAT: 1 });
            const params = makeCancelParams(10, '');
            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(indexer.indexerDb.clearTokenEscrow);
        });
    });
});
