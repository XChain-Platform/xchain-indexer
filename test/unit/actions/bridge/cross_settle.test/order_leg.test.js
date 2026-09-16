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
// CROSS_SETTLE ORDER legs: partial and final fills, ownership orders, no-op
// records for a closed or exhausted order, and the TOCTOU fill clamp. Part of the
// Cross_Settle suite; see ../cross_settle.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { makeMatch, signMatch, snapFor, makeData, useCrossSettleHarness } = require('./helpers/cross_settle_harness.js');

// The harness under test. useCrossSettleHarness rebuilds it before every test and
// restores sinon after it; bind copies it into the names the tests read.
let indexer, handler;
const bind = (h) => { ({ indexer, handler } = h); };

const orderMatch = (o) => makeMatch({ a_kind: 'order', b_kind: 'order', ...o });

describe('Cross_Settle action handler @regression @tier1', function () {
    useCrossSettleHarness(bind);

    // ─── ORDER leg: partial-fill settlement ─────────────────────
    describe('ORDER leg (partial fills)', function () {
        beforeEach(function () {
            indexer.indexerDb.recordCrossChainOrderFill = sinon.stub().resolves();
            indexer.indexerDb.getOrderInfo.resolves({ SOURCE: '1SrcOrderXXXXXXXXXXXXXXXXXXXXYs6gYt', ORDER_STATUS: 'open' });
            indexer.indexerDb.getOrderAmountsRemaining.resolves(['90', '45']);  // still remaining by default
            // The cross_chain snapshot is wired per-test (snapFor) once the match
            // is signed, so it includes the order's signer (snapshot membership).
        });

        it('partial fill: releases the fill, records it, and leaves the order OPEN', async function () {
            const { match } = signMatch(orderMatch(), 1);
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            const data = makeData({ MATCH: match });
            await handler.parse(null, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createEscrow.called);          // fungible escrow released
            assert.ok(indexer.indexerDb.recordCrossChainOrderFill.calledOnce);
            const f = indexer.indexerDb.recordCrossChainOrderFill.firstCall.args;
            assert.strictEqual(f[0], 777);   // settlement action_index
            assert.strictEqual(f[1], 42);    // local order action_index
            assert.strictEqual(f[2], '10');  // give fill = a_amount
            assert.strictEqual(f[3], '5');   // get fill = b_amount
            assert.ok(indexer.indexerDb.createOrderStatus.notCalled);  // NOT complete (remaining > 0)
            assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnce);
        });

        it('final fill: marks the order complete when nothing remains', async function () {
            const { match } = signMatch(orderMatch(), 1);
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            indexer.indexerDb.getOrderAmountsRemaining.resolves(['0', '0']);
            const data = makeData({ MATCH: match });
            await handler.parse(null, data, null);
            assert.ok(indexer.indexerDb.createOrderStatus.calledWith(777, 42, 'complete'));
            assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnce);
        });

        it('settles the b leg order when this chain is the b side', async function () {
            const { match } = signMatch(orderMatch({
                a_chain: 'LTC', a_action_index: 11, a_amount: '5', a_payout_addr: 'LpayoutA',
                b_chain: 'BTC', b_action_index: 88, b_tick: 'BBB', b_amount: '7',
                b_payout_addr: '1payoutBXXXXXXXXXXXXXXXXXXXXXaKc5Z',
            }), 1);
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            const data = makeData({ MATCH: match });
            await handler.parse(null, data, null);
            const f = indexer.indexerDb.recordCrossChainOrderFill.firstCall.args;
            assert.strictEqual(f[1], 88);    // local order = b leg
            assert.strictEqual(f[2], '7');   // give fill = b_amount
            assert.strictEqual(f[3], '5');   // get fill = a_amount
        });
    });
});

describe('Cross_Settle action handler @regression @tier1', function () {
    useCrossSettleHarness(bind);

    describe('ORDER leg (partial fills)', function () {
        beforeEach(function () {
            indexer.indexerDb.recordCrossChainOrderFill = sinon.stub().resolves();
            indexer.indexerDb.getOrderInfo.resolves({ SOURCE: '1SrcOrderXXXXXXXXXXXXXXXXXXXXYs6gYt', ORDER_STATUS: 'open' });
            indexer.indexerDb.getOrderAmountsRemaining.resolves(['90', '45']);  // still remaining by default
            // The cross_chain snapshot is wired per-test (snapFor) once the match
            // is signed, so it includes the order's signer (snapshot membership).
        });

        it('ownership order: transfers ownership and completes (single fill)', async function () {
            const { match } = signMatch(orderMatch({ a_ownership: 1 }), 1);
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            indexer.indexerDb.getOrderAmountsRemaining.resolves(['1', '1']);  // ownership completes regardless
            const data = makeData({ MATCH: match });
            await handler.parse(null, data, null);
            assert.ok(indexer.indexerDb.clearTokenEscrow.called);
            assert.ok(indexer.indexerDb.createIssue.called);
            assert.ok(indexer.indexerDb.createEscrow.notCalled);
            assert.ok(indexer.indexerDb.createOrderStatus.calledWith(777, 42, 'complete'));
        });

        it('records a NO-OP settlement (no fill, no funds) when the local order is not open', async function () {
            const { match } = signMatch(orderMatch(), 1);
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            indexer.indexerDb.getOrderInfo.resolves({ SOURCE: 'x', ORDER_STATUS: 'complete' });
            await handler.parse(null, makeData({ MATCH: match }), null);
            assert.ok(indexer.indexerDb.recordCrossChainOrderFill.notCalled);
            assert.ok(indexer.indexerDb.createEscrow.notCalled);
            assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnce);
        });
    });
});

describe('Cross_Settle action handler @regression @tier1', function () {
    useCrossSettleHarness(bind);

    describe('ORDER leg (partial fills)', function () {
        beforeEach(function () {
            indexer.indexerDb.recordCrossChainOrderFill = sinon.stub().resolves();
            indexer.indexerDb.getOrderInfo.resolves({ SOURCE: '1SrcOrderXXXXXXXXXXXXXXXXXXXXYs6gYt', ORDER_STATUS: 'open' });
            indexer.indexerDb.getOrderAmountsRemaining.resolves(['90', '45']);  // still remaining by default
            // The cross_chain snapshot is wired per-test (snapFor) once the match
            // is signed, so it includes the order's signer (snapshot membership).
        });

        it('clamps a TOCTOU over-stamped fill to the order\'s give remaining', async function () {
            const { match } = signMatch(orderMatch(), 1);   // a_amount (fill) = '10'
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            indexer.indexerDb.getOrderInfo.resolves({ SOURCE: '1SrcOrderXXXXXXXXXXXXXXXXXXXXYs6gYt', ORDER_STATUS: 'open', GIVE_REMAINING: '4' });
            const data = makeData({ MATCH: match });
            await handler.parse(null, data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            const f = indexer.indexerDb.recordCrossChainOrderFill.firstCall.args;
            assert.strictEqual(f[2], '4');   // released/recorded give clamped to escrow, not the stamped 10
        });

        it('records a NO-OP settlement when nothing remains to give', async function () {
            const { match } = signMatch(orderMatch(), 1);
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            indexer.indexerDb.getOrderInfo.resolves({ SOURCE: '1SrcOrderXXXXXXXXXXXXXXXXXXXXYs6gYt', ORDER_STATUS: 'open', GIVE_REMAINING: '0' });
            await handler.parse(null, makeData({ MATCH: match }), null);
            assert.ok(indexer.indexerDb.recordCrossChainOrderFill.notCalled);
            assert.ok(indexer.indexerDb.createEscrow.notCalled);
            assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnce);
        });

        it('skips when the local order is not found', async function () {
            const { match } = signMatch(orderMatch(), 1);
            indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
            indexer.indexerDb.getOrderInfo.resolves(null);
            await handler.parse(null, makeData({ MATCH: match }), null);
            assert.ok(indexer.indexerDb.recordCrossChainSettlement.notCalled);
        });
    });
});
