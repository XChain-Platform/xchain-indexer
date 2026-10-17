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
// CROSS_SETTLE under settlement_bounds_activation. Armed (regtest, genesis) a swap leg
// releases at most the swap's own GIVE_AMOUNT, and a swap or order leg whose match names
// another tick or ownership flag than the offer gives records a no-op settlement and moves
// nothing. Unarmed (the committed mainnet and testnet rows) the match's terms move as
// signed. Part of the Cross_Settle suite; see ../cross_settle.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { stubGate } = require('../../../../helpers/gate_modules.js');
const { makeMatch, signMatch, snapFor, makeData, useCrossSettleHarness } = require('./helpers/cross_settle_harness.js');

const KEY = 'settlement_bounds_activation.SETTLEMENT_BOUNDS_ACTIVATION';
const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

// The harness under test. useCrossSettleHarness rebuilds it before every test and
// restores sinon after it; bind copies it into the names the tests read.
let indexer, handler;
const bind = (h) => { ({ indexer, handler } = h); };

// The local swap as getSwapInfo returns it: BTC leg a gives 10 AAA by default.
function swapRow(o) {
    return { SOURCE, SWAP_STATUS: 'open', GIVE_TICK: 'AAA', GIVE_AMOUNT: '10', GIVE_OWNERSHIP: 0, ...o };
}

// Sign `fields` over the handler's canonical and parse it at block 200.
async function settle(fields) {
    const { match } = signMatch(makeMatch(fields), 1);
    indexer.indexerDb.getValidatorsByCapability.resolves(snapFor(match, 1));
    const data = makeData({ MATCH: match });
    await handler.parse(null, data, null);
    return data;
}

// Every escrow and credit row written, as [tick, amount, address].
function ledger(stub) {
    return stub.getCalls().map(c => [c.args[1], String(Number(c.args[2])), c.args[3]]);
}

describe('Cross_Settle settlement bounds: armed swap leg @regression @tier1', function () {
    useCrossSettleHarness(bind);
    beforeEach(function () { stubGate(sinon, KEY, true); });

    it('clamps a release above the swap escrow to the escrow and completes the swap', async function () {
        indexer.indexerDb.getSwapInfo.resolves(swapRow());
        const data = await settle({ a_amount: '30' });
        assert.strictEqual(data['STATUS'], 'valid');
        assert.deepStrictEqual(ledger(indexer.indexerDb.createEscrow).map(r => r.slice(0, 2)), [['AAA', '-10']]);
        assert.deepStrictEqual(ledger(indexer.indexerDb.createCredit).map(r => r.slice(0, 2)), [['AAA', '10']]);
        assert.ok(indexer.indexerDb.createSwapStatus.calledWith(777, 42, 'complete'));
    });

    it('releases an honest match in full', async function () {
        indexer.indexerDb.getSwapInfo.resolves(swapRow());
        await settle({});
        assert.deepStrictEqual(ledger(indexer.indexerDb.createCredit).map(r => r.slice(0, 2)), [['AAA', '10']]);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnce);
    });

    it('records a no-op for a match naming another tick and leaves the swap open', async function () {
        indexer.indexerDb.getSwapInfo.resolves(swapRow());
        await settle({ a_tick: 'QUUX', a_amount: '10' });
        assert.ok(indexer.indexerDb.createEscrow.notCalled);
        assert.ok(indexer.indexerDb.createCredit.notCalled);
        assert.ok(indexer.indexerDb.createSwapStatus.notCalled);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnce);
    });

    it('records a no-op for a match claiming ownership of a balance swap', async function () {
        indexer.indexerDb.getSwapInfo.resolves(swapRow());
        await settle({ a_ownership: 1 });
        assert.ok(indexer.indexerDb.createIssue.notCalled);
        assert.ok(indexer.indexerDb.clearTokenEscrow.notCalled);
        assert.ok(indexer.indexerDb.createSwapStatus.notCalled);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnce);
    });
});

describe('Cross_Settle settlement bounds: armed b leg and ownership @regression @tier1', function () {
    useCrossSettleHarness(bind);
    beforeEach(function () { stubGate(sinon, KEY, true); });

    const bLeg = (o) => ({ a_chain: 'LTC', a_action_index: 11, a_payout_addr: 'LpayoutA',
        b_chain: 'BTC', b_action_index: 88, b_tick: 'BBB', b_amount: '7', b_ownership: 0,
        b_payout_addr: '1payoutBXXXXXXXXXXXXXXXXXXXXXaKc5Z', ...o });

    it('compares b_tick with the swap give tick when this chain is the b side', async function () {
        indexer.indexerDb.getSwapInfo.resolves(swapRow({ GIVE_TICK: 'BBB', GIVE_AMOUNT: '7' }));
        await settle(bLeg({ b_tick: 'AAA' }));
        assert.ok(indexer.indexerDb.createEscrow.notCalled);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledWith(777, sinon.match.object, 88));
    });

    it('clamps the b leg to its swap escrow', async function () {
        indexer.indexerDb.getSwapInfo.resolves(swapRow({ GIVE_TICK: 'BBB', GIVE_AMOUNT: '7' }));
        await settle(bLeg({ b_amount: '700' }));
        assert.deepStrictEqual(ledger(indexer.indexerDb.createEscrow).map(r => r.slice(0, 2)), [['BBB', '-7']]);
        assert.ok(indexer.indexerDb.createSwapStatus.calledWith(777, 88, 'complete'));
    });

    it('transfers ownership for a matching ownership swap without a balance clamp', async function () {
        indexer.indexerDb.getSwapInfo.resolves(swapRow({ GIVE_OWNERSHIP: 1, GIVE_AMOUNT: '1' }));
        await settle({ a_ownership: 1 });
        assert.ok(indexer.indexerDb.createIssue.called);
        assert.ok(indexer.indexerDb.createEscrow.notCalled);
        assert.ok(indexer.indexerDb.createSwapStatus.calledWith(777, 42, 'complete'));
    });

    it('reads the gate on this chain\'s network, coin and block', async function () {
        const gate = stubGate(sinon, KEY, true);
        indexer.indexerDb.getSwapInfo.resolves(swapRow());
        await settle({});
        assert.ok(gate.calledWith('regtest', 'BTC', 200, null));
    });
});

describe('Cross_Settle settlement bounds: armed order leg @regression @tier1', function () {
    useCrossSettleHarness(bind);
    beforeEach(function () {
        stubGate(sinon, KEY, true);
        indexer.indexerDb.recordCrossChainOrderFill = sinon.stub().resolves();
        indexer.indexerDb.getOrderAmountsRemaining.resolves(['90', '45']);
    });

    const orderRow = (o) => ({ SOURCE, ORDER_STATUS: 'open', GIVE_TICK: 'AAA', GIVE_OWNERSHIP: 0, GIVE_REMAINING: '100', ...o });

    it('records a no-op for an order match naming another tick', async function () {
        indexer.indexerDb.getOrderInfo.resolves(orderRow());
        await settle({ a_kind: 'order', b_kind: 'order', a_tick: 'QUUX' });
        assert.ok(indexer.indexerDb.recordCrossChainOrderFill.notCalled);
        assert.ok(indexer.indexerDb.createEscrow.notCalled);
        assert.ok(indexer.indexerDb.recordCrossChainSettlement.calledOnce);
    });

    it('still fills an order match naming the order\'s own tick', async function () {
        indexer.indexerDb.getOrderInfo.resolves(orderRow());
        await settle({ a_kind: 'order', b_kind: 'order' });
        const f = indexer.indexerDb.recordCrossChainOrderFill.firstCall.args;
        assert.strictEqual(f[2], '10');
        assert.deepStrictEqual(ledger(indexer.indexerDb.createEscrow).map(r => r.slice(0, 2)), [['AAA', '-10']]);
    });
});

describe('Cross_Settle settlement bounds: unarmed @regression @tier1', function () {
    useCrossSettleHarness(bind);

    it('releases the match amount as signed when it exceeds the swap escrow', async function () {
        indexer.indexerDb.getSwapInfo.resolves(swapRow());
        await settle({ a_amount: '30' });
        assert.deepStrictEqual(ledger(indexer.indexerDb.createEscrow).map(r => r.slice(0, 2)), [['AAA', '-30']]);
    });

    it('releases the match tick as signed when it differs from the swap give tick', async function () {
        indexer.indexerDb.getSwapInfo.resolves(swapRow());
        await settle({ a_tick: 'QUUX' });
        assert.deepStrictEqual(ledger(indexer.indexerDb.createEscrow).map(r => r.slice(0, 2)), [['QUUX', '-10']]);
        assert.ok(indexer.indexerDb.createSwapStatus.calledWith(777, 42, 'complete'));
    });

    it('is the committed mainnet and testnet reading at every height', function () {
        stubGate(sinon, KEY, false).restore();
        const registry = require('../../../../../src/consensus/gate_registry.js');
        // The v0.24.0 cut arms testnet per chain; mainnet stays unarmed.
        const TESTNET = { BTC: 156908, LTC: 4927400, DOGE: 68005165 };
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            for (const h of [0, 1, 1e6, 9e9])
                assert.strictEqual(registry.activeAt(KEY, 'mainnet', coin, h, null), false, 'mainnet/' + coin + '@' + h);
            assert.strictEqual(registry.activeAt(KEY, 'testnet', coin, TESTNET[coin] - 1, null), false, 'testnet/' + coin + ' below');
            assert.strictEqual(registry.activeAt(KEY, 'testnet', coin, TESTNET[coin], null), true, 'testnet/' + coin + ' at');
        }
        assert.strictEqual(registry.activeAt(KEY, 'regtest', 'BTC', 0, null), true);
    });
});
