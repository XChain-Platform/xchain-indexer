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
// SWEEP with every flag set: balances, ownerships and escrow closes in one
// sweep, and an escrowed ownership transferred exactly once.
// Part of the SWEEP suite; see ../sweep.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const { SOURCE, DESTINATION, makeSweepContext } = require('./helpers/sweep_context.js');

let indexer, handler;

// Each test starts from its own mock indexer and SWEEP handler.
function freshSweep() {
    ({ indexer, handler } = makeSweepContext());
}

// ─── All three flags combined ─────────────────────────────────────

describe('Sweep @regression @tier3', function () {
    beforeEach(freshSweep);
    afterEach(() => sinon.restore());

    describe('all flags combined', function () {
        it('BALANCES=1, OWNERSHIPS=1, ORDERS/SWAPS/DISPENSERS=1 all processed (via data override)', async function () {
            const orderInfo = {
                ACTION_INDEX: 10, SOURCE, GIVE_TICK: 'TEST', GIVE_REMAINING: '10',
            };
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves(['TEST']);
            indexer.indexerDb.getAddressEscrows.resolves([{ type: 'order', action_index: 10 }]);
            indexer.indexerDb.getOrderInfo.resolves(orderInfo);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getTicker.resolves('GAS');
            indexer.indexerDb.createActionIndex.resolves(99);

            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', DESTINATION]; // BALANCES/OWNERSHIPS/ESCROWS omitted → default to null → use defaults

            // Inject ORDERS/SWAPS/DISPENSERS=1 to test all three escrow-close flags
            const origSetActionParams = indexer.util.setActionParams.bind(indexer.util);
            indexer.util.setActionParams = (d, p, f, v) => {
                const result = origSetActionParams(d, p, f, v);
                result['ORDERS']     = 1;
                result['SWAPS']      = 1;
                result['DISPENSERS'] = 1;
                return result;
            };

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createSweep.called);
            assert.ok(indexer.indexerDb.createIssue.called);
            assert.ok(indexer.indexerDb.createOrderStatus.called);
        });
    });
});

describe('Sweep @regression @tier3', function () {
    beforeEach(freshSweep);
    afterEach(() => sinon.restore());

    describe('all flags combined', function () {
        it('escrowed-ownership tick produces exactly ONE ISSUE when OWNERSHIPS=1 and ORDERS=1', async function () {
            // SOURCE has an open GIVE_OWNERSHIP=1 order escrowing TEST's ownership.
            // The real getAddressOwnerships query excludes escrowed ticks, but even
            // with a stale snapshot that still contains the tick (stubbed here), the
            // handler must not write a second ownership-transfer ISSUE after the
            // order-cancel path already delivered it; a duplicate ISSUE would
            // change the per-block actions hash.
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves(['TEST']); // stale snapshot still contains the escrowed tick
            indexer.indexerDb.getAddressEscrows.resolves([{ type: 'order', action_index: 10 }]);
            indexer.indexerDb.getOrderInfo.resolves({ ACTION_INDEX: 10, SOURCE, GIVE_TICK: 'TEST', GIVE_REMAINING: '0', GIVE_OWNERSHIP: 1 });
            indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([]);
            indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getTicker.resolves('GAS');
            indexer.indexerDb.createActionIndex.resolves(99);

            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', DESTINATION]; // BALANCES/OWNERSHIPS default to 1

            const origSetActionParams = indexer.util.setActionParams.bind(indexer.util);
            indexer.util.setActionParams = (d, p, f, v) => {
                const result = origSetActionParams(d, p, f, v);
                result['ORDERS'] = 1;
                return result;
            };

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createOrderStatus.calledWith(sinon.match.any, 10, 'cancelled'));
            assert.strictEqual(indexer.indexerDb.createIssue.callCount, 1,
                'escrowed-ownership tick must be transferred exactly once (offer-close path only)');
        });
    });
});

describe('Sweep @regression @tier3', function () {
    beforeEach(freshSweep);
    afterEach(() => sinon.restore());

    describe('all flags combined', function () {
        it('escrowed-ownership tick via SWAP produces exactly ONE ISSUE when OWNERSHIPS=1 and SWAPS=1', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves(['TEST']); // stale snapshot still contains the escrowed tick
            indexer.indexerDb.getAddressEscrows.resolves([{ type: 'swap', action_index: 20 }]);
            indexer.indexerDb.getSwapInfo.resolves({ ACTION_INDEX: 20, SOURCE, GIVE_TICK: 'TEST', GIVE_AMOUNT: '0', GIVE_OWNERSHIP: 1 });
            indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getTicker.resolves('GAS');
            indexer.indexerDb.createActionIndex.resolves(99);

            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', DESTINATION];

            const origSetActionParams = indexer.util.setActionParams.bind(indexer.util);
            indexer.util.setActionParams = (d, p, f, v) => {
                const result = origSetActionParams(d, p, f, v);
                result['SWAPS'] = 1;
                return result;
            };

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createSwapStatus.calledWith(sinon.match.any, 20, 'cancelled'));
            assert.strictEqual(indexer.indexerDb.createIssue.callCount, 1,
                'escrowed-ownership tick must be transferred exactly once (offer-close path only)');
        });
    });
});

describe('Sweep @regression @tier3', function () {
    beforeEach(freshSweep);
    afterEach(() => sinon.restore());

    describe('all flags combined', function () {
        it('non-escrowed ownership still transferred alongside an escrowed-order tick', async function () {
            // TEST is escrowed by the order; XTEST is a plain ownership. The sweep
            // must deliver both to DESTINATION with exactly one ISSUE each.
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves(['TEST', 'XTEST']);
            indexer.indexerDb.getAddressEscrows.resolves([{ type: 'order', action_index: 10 }]);
            indexer.indexerDb.getOrderInfo.resolves({ ACTION_INDEX: 10, SOURCE, GIVE_TICK: 'TEST', GIVE_REMAINING: '0', GIVE_OWNERSHIP: 1 });
            indexer.indexerDb.getPendingCoinpayObligationsByOrder.resolves([]);
            indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getTicker.resolves('GAS');
            indexer.indexerDb.createActionIndex.resolves(99);

            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', DESTINATION];

            const origSetActionParams = indexer.util.setActionParams.bind(indexer.util);
            indexer.util.setActionParams = (d, p, f, v) => {
                const result = origSetActionParams(d, p, f, v);
                result['ORDERS'] = 1;
                return result;
            };

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(indexer.indexerDb.createIssue.callCount, 2,
                'one ISSUE for the escrowed tick (offer-close path) + one for the plain ownership');
        });

    });
});
