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
// COINPAY action handler: the early-exit guards, format validation, a valid
// settlement and obligation expiry. The seller-order finalisation and
// role/ownership blocks live beside this file in coinpay.test/. Every block in
// every file opens the same 'Coinpay (COINPAY) @regression @tier2' describe, so
// each full test title is the one the suite always had;
// coinpay.test/helpers/coinpay_harness.js holds the fixtures and the mock harness
// they all run on.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const { createBaseData } = require('../../fixtures/mocks');
const { PAYEE, makeObligation, useCoinpayHarness } = require('./coinpay.test/helpers/coinpay_harness.js');

// The harness under test. useCoinpayHarness rebuilds it before every test and
// restores sinon after it; bind copies it into the names the tests read.
let indexer, handler;
const bind = (h) => { ({ indexer, handler } = h); };

describe('Coinpay (COINPAY) @regression @tier2', function () {
    useCoinpayHarness(bind);

    // ─── Early-exit paths (no matching/pending obligation) ────────────────

    describe('early-exit guard conditions', function () {

        it('skips (deleteActionIndex) when obligation is not found', async function () {
            indexer.indexerDb.getCoinpayObligationInfo.resolves(null);
            const data = createBaseData({
                ACTION:         'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE, COIN_AMOUNT: '0.001',
                ORDER_MATCH_ACTION_INDEX: 42
            });
            data['ORDER_MATCH_ACTION_INDEX'] = 42;
            await handler.parse(['0', '42'], data, null);
            assert.ok(indexer.indexerDb.deleteActionIndex.calledOnce);
            assert.ok(indexer.indexerDb.createCoinpay.notCalled);
        });

        it('skips when obligation is not in pending_coinpay status', async function () {
            indexer.indexerDb.getCoinpayObligationInfo.resolves(makeObligation({ COINPAY_STATUS: 'fulfilled' }));
            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE, COIN_AMOUNT: '0.001'
            });
            await handler.parse(['0', '42'], data, null);
            assert.ok(indexer.indexerDb.deleteActionIndex.calledOnce);
            assert.ok(indexer.indexerDb.createCoinpay.notCalled);
        });

        it('skips when COIN_DESTINATION does not match PAYEE_ADDRESS', async function () {
            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0, FORMAT: 0,
                COIN_DESTINATION: '1WrongAddressXXXXXXXXXXXXXXXXXXXkH',
                COIN_AMOUNT: '0.001'
            });
            await handler.parse(['0', '42'], data, null);
            assert.ok(indexer.indexerDb.deleteActionIndex.calledOnce);
            assert.ok(indexer.indexerDb.createCoinpay.notCalled);
        });

        it('skips when COIN_AMOUNT is less than obligation amount', async function () {
            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE,
                COIN_AMOUNT: '0.00000001',   // far below the owed 0.001
            });
            await handler.parse(['0', '42'], data, null);
            assert.ok(indexer.indexerDb.deleteActionIndex.calledOnce);
            assert.ok(indexer.indexerDb.createCoinpay.notCalled);
        });

    });
});

describe('Coinpay (COINPAY) @regression @tier2', function () {
    useCoinpayHarness(bind);

    // ─── Format validation ────────────────────────────────────────────────

    describe('format validation', function () {

        it('rejects unknown VERSION', async function () {
            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 9,
                COIN_DESTINATION: PAYEE, COIN_AMOUNT: '0.001'
            });
            await handler.parse(['9', '42'], data, null);
            // unknown format sets an error, so the obligation lookup is skipped and the
            // action index is discarded before any settlement.
            assert.ok(indexer.indexerDb.createCoinpay.notCalled, 'unknown VERSION must not settle a coinpay');
            assert.ok(indexer.indexerDb.deleteActionIndex.called, 'unknown VERSION action index is discarded');
        });

    });

    // ─── Valid settlement ─────────────────────────────────────────────────

    describe('valid settlement', function () {
        it('valid coinpay → createCoinpay called with valid status', async function () {
            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE,
                COIN_AMOUNT: '0.001',
                BLOCK_TIME: 1000,   // well before expiration
            });
            await handler.parse(['0', '42'], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createCoinpay.calledOnce);
        });

        it('valid coinpay → createCoinpayStatus called with fulfilled', async function () {
            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE,
                COIN_AMOUNT: '0.001',
                BLOCK_TIME: 1000,
            });
            await handler.parse(['0', '42'], data, null);
            assert.ok(indexer.indexerDb.createCoinpayStatus.calledOnce);
            const [, , status] = indexer.indexerDb.createCoinpayStatus.firstCall.args;
            assert.strictEqual(status, 'fulfilled');
        });
    });
});

describe('Coinpay (COINPAY) @regression @tier2', function () {
    useCoinpayHarness(bind);

    describe('valid settlement', function () {
        it('valid coinpay → ORDER_MATCH status set to valid', async function () {
            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE,
                COIN_AMOUNT: '0.001',
                BLOCK_TIME: 1000,
            });
            await handler.parse(['0', '42'], data, null);
            // CORRECTED: this asserted createOrderStatus, which writes into
            // order_statuses keyed by an ORDER index. The value passed here is a
            // MATCH index, so every reader of that table joined it to nothing and the
            // match stayed pending_coinpay for good. The match status lives on its own
            // order_matches row, so the settlement must reach updateOrderMatchStatus.
            const matchValidCall = indexer.indexerDb.updateOrderMatchStatus.getCalls()
                .find(c => c.args[1] === 'valid');
            assert.ok(matchValidCall, 'updateOrderMatchStatus with valid expected');
            assert.strictEqual(Number(matchValidCall.args[0]), 42,
                'the match must be cleared by the obligation own action index');
        });

        it('valid coinpay → updateBalances and updateTokens called', async function () {
            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE,
                COIN_AMOUNT: '0.001',
                BLOCK_TIME: 1000,
            });
            await handler.parse(['0', '42'], data, null);
            assert.ok(indexer.indexerDb.updateBalances.calledOnce);
            assert.ok(indexer.indexerDb.updateTokens.calledOnce);
        });
    });

    describe('valid settlement', function () {
        it('valid coinpay → mapper.createMappings called', async function () {
            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE,
                COIN_AMOUNT: '0.001',
                BLOCK_TIME: 1000,
            });
            await handler.parse(['0', '42'], data, null);
            assert.ok(indexer.mapper.createMappings.calledOnce);
        });

    });
});

describe('Coinpay (COINPAY) @regression @tier2', function () {
    useCoinpayHarness(bind);

    // ─── Expiration ───────────────────────────────────────────────────────

    describe('obligation expiration', function () {

        it('rejects when BLOCK_TIME >= obligation EXPIRATION', async function () {
            indexer.indexerDb.getCoinpayObligationInfo.resolves(makeObligation({ EXPIRATION: 1000 }));
            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE,
                COIN_AMOUNT: '0.001',
                BLOCK_TIME: 2000,   // past expiration
            });
            await handler.parse(['0', '42'], data, null);
            assert.ok(String(data['STATUS']).includes('expired'));
        });

        it('accepts when BLOCK_TIME is just before EXPIRATION', async function () {
            indexer.indexerDb.getCoinpayObligationInfo.resolves(makeObligation({ EXPIRATION: 9999999999 }));
            const data = createBaseData({
                ACTION: 'COINPAY', FORMAT: 0,
                COIN_DESTINATION: PAYEE,
                COIN_AMOUNT: '0.001',
                BLOCK_TIME: 1000,
            });
            await handler.parse(['0', '42'], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

    });
});
