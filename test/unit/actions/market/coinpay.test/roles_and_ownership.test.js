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
// COINPAY settlement roles: which order is the seller and which the coin payer
// (including the ambiguous both-token shape on either side of the flag-day), and
// ownership delivery for a GIVE_OWNERSHIP seller. Part of the Coinpay suite; see
// ../coinpay.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const { PAYEE, SELLER, BUYER, makeOrderInfo, makeCoinOrderInfo, useCoinpayHarness } = require('./helpers/coinpay_harness.js');

// The harness under test. useCoinpayHarness rebuilds it before every test and
// restores sinon after it; bind copies it into the names the tests read.
let indexer, actionsCtx, handler;
const bind = (h) => { ({ indexer, actionsCtx, handler } = h); };

describe('Coinpay (COINPAY) @regression @tier2', function () {
    useCoinpayHarness(bind);

    // ─── Seller/coin order role determination ────────────────────────────────

    describe('seller vs coin order role determination', function () {
        it('giveOrderInfo GIVE_TICK is a real token (not null/COIN) → giveOrder is seller, getOrder is coin', async function () {
            // giveOrderInfo has GIVE_TICK='TEST' (a real token): falls through to the else branch
            // (lines 136-138): coinOrder=getOrderInfo, sellerOrder=giveOrderInfo
            const giveOrder = makeOrderInfo({ ACTION_INDEX: 11, GIVE_TICK: 'TEST', SOURCE: SELLER, GET_ADDRESS: BUYER });
            const getOrder  = makeCoinOrderInfo({ ACTION_INDEX: 10, GIVE_TICK: null, GET_ADDRESS: BUYER });

            // Obligation matchOrders: give=11 (token seller), get=10 (coin payer)
            indexer.indexerDb.getOrderMatchOrders.resolves({ give_action_index: 11, get_action_index: 10 });
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 11).resolves(giveOrder);
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 10).resolves(getOrder);

            // matchQuery: seller (giveOrder, index 11) is NOT matchQuery.get_action_index (10)
            // → tokenAmount = matchQuery.get_amount (lines 164-166)
            indexer.indexerDb.getOrderMatchAmounts.resolves({
                give_action_index: 11,
                get_action_index:  10,
                give_amount:       '0.001',
                get_amount:        '50',
            });

            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE, COIN_AMOUNT: '0.001', BLOCK_TIME: 1000,
            });
            await handler.parse(['0', '42'], data, null);

            // Settlement should have completed: createCoinpayStatus with 'fulfilled'
            assert.ok(indexer.indexerDb.createCoinpayStatus.calledOnce);
            const [, , st] = indexer.indexerDb.createCoinpayStatus.firstCall.args;
            assert.strictEqual(st, 'fulfilled');
        });
    });
});

describe('Coinpay (COINPAY) @regression @tier2', function () {
    useCoinpayHarness(bind);

    describe('seller vs coin order role determination', function () {
        // role detection keys on which side actually GIVES native coin, checking BOTH
        // orders. A malformed obligation where NEITHER order gives native coin (both GIVE_TICK
        // are real tokens) is ambiguous - the pre-fix single-side check silently picked getOrder
        // as the coin side and released the wrong escrow. With COINPAY_NATIVE_RECIPROCITY active
        // the handler refuses to settle it (order_match no longer creates this shape either).
        it('refuses to settle when neither order gives native coin (ambiguous roles, flag ON)', async function () {
            const giveTokenOrder = makeOrderInfo({ ACTION_INDEX: 11, GIVE_TICK: 'TEST',  SOURCE: SELLER, GET_ADDRESS: BUYER });
            const getTokenOrder  = makeOrderInfo({ ACTION_INDEX: 10, GIVE_TICK: 'TEST2', SOURCE: BUYER,  GET_ADDRESS: SELLER });

            indexer.indexerDb.getOrderMatchOrders.resolves({ give_action_index: 11, get_action_index: 10 });
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 11).resolves(giveTokenOrder);
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 10).resolves(getTokenOrder);

            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE, COIN_AMOUNT: '0.001', BLOCK_TIME: 1000,
            });
            await handler.parse(['0', '42'], data, null);

            // No settlement: obligation is never marked fulfilled and no escrow is released.
            assert.ok(indexer.indexerDb.createCoinpayStatus.notCalled, 'ambiguous match must not be settled');
            assert.ok(indexer.indexerDb.createEscrow.notCalled, 'no escrow release on an ambiguous match');
        });
    });

    describe('seller vs coin order role determination', function () {
        it('LEGACY (flag OFF): both-token shape falls through to the pre-flag-day single-side split', async function () {
            actionsCtx.protocolChanges.isEnabled = sinon.stub().resolves(false);

            const giveTokenOrder = makeOrderInfo({ ACTION_INDEX: 11, GIVE_TICK: 'TEST',  SOURCE: SELLER, GET_ADDRESS: BUYER });
            const getTokenOrder  = makeOrderInfo({ ACTION_INDEX: 10, GIVE_TICK: 'TEST2', SOURCE: BUYER,  GET_ADDRESS: SELLER });

            indexer.indexerDb.getOrderMatchOrders.resolves({ give_action_index: 11, get_action_index: 10 });
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 11).resolves(giveTokenOrder);
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 10).resolves(getTokenOrder);

            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE, COIN_AMOUNT: '0.001', BLOCK_TIME: 1000,
            });
            await handler.parse(['0', '42'], data, null);

            // Below the flag-day the legacy path still runs to completion (byte-for-byte replay
            // parity), even for this malformed shape: giveOrderInfo gives a real token, so the
            // legacy else-branch treats getOrder as the coin side and settles.
            assert.ok(indexer.indexerDb.createCoinpayStatus.calledOnce, 'legacy path still settles below the flag-day');
            const [, , st] = indexer.indexerDb.createCoinpayStatus.firstCall.args;
            assert.strictEqual(st, 'fulfilled');
        });

    });
});

describe('Coinpay (COINPAY) @regression @tier2', function () {
    useCoinpayHarness(bind);

    // ─── Ownership delivery branch ────────────────────────────────────────────

    describe('ownership delivery (GIVE_OWNERSHIP=1)', function () {

        it('GIVE_OWNERSHIP=1 on sellerOrder → transferTokenOwnership called instead of escrow/credit', async function () {
            const transferSpy = sinon.stub(indexer.util, 'transferTokenOwnership').resolves();

            // sellerOrder (index 10) has GIVE_OWNERSHIP=1
            const ownershipSeller = makeOrderInfo({ ACTION_INDEX: 10, GIVE_TICK: 'TEST', GIVE_OWNERSHIP: 1 });
            const coinOrderInfo   = makeCoinOrderInfo({ ACTION_INDEX: 11, GIVE_TICK: null });

            indexer.indexerDb.getOrderMatchOrders.resolves({ give_action_index: 11, get_action_index: 10 });
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 11).resolves(coinOrderInfo);
            indexer.indexerDb.getOrderInfo.withArgs(sinon.match.any, 10).resolves(ownershipSeller);

            // Seller is original order (get_action_index=10 matches sellerOrder.ACTION_INDEX=10)
            // → tokenAmount = matchQuery.give_amount
            indexer.indexerDb.getOrderMatchAmounts.resolves({
                give_action_index: 11,
                get_action_index:  10,
                give_amount:       '1',    // ownership token amount
                get_amount:        '0.001',
            });

            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE, COIN_AMOUNT: '0.001', BLOCK_TIME: 1000,
            });
            await handler.parse(['0', '42'], data, null);

            assert.ok(transferSpy.calledOnce, 'transferTokenOwnership must be called for ownership delivery');
        });

    });
});
