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
// SWEEP OWNERSHIPS=1: every owned token is deeded to DESTINATION, and the
// `ownership` controller guard runs once per deed in byte order of the tick,
// failing the whole sweep on a denial.
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

// ─── OWNERSHIPS=1 ────────────────────────────────────────────────

describe('Sweep @regression @tier3', function () {
    beforeEach(freshSweep);
    afterEach(() => sinon.restore());

    describe('OWNERSHIPS=1', function () {

        it('createIssue called with TRANSFER for each owned token', async function () {
            // Provide GAS balance for fee
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves(['TEST', 'XTEST']);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.createActionIndex.resolves(99);

            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            // BALANCES=null defaults to 1; OWNERSHIPS=null defaults to 1; ESCROWS=null defaults to 0
            const params = ['0', DESTINATION]; // BALANCES/OWNERSHIPS/ESCROWS omitted → default to null → use defaults

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createIssue.callCount >= 2, 'createIssue called for each ownership');
        });

        it('ownership transferred: updateTokens called per tick', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves(['TEST']);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.createActionIndex.resolves(99);

            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', DESTINATION]; // BALANCES/OWNERSHIPS/ESCROWS omitted → default to null → use defaults

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.updateTokens.called);
        });

    });
});

// ─── OWNERSHIPS controller guard (`ownership` class) ─────────────

describe('Sweep @regression @tier3', function () {
    beforeEach(freshSweep);
    afterEach(() => sinon.restore());

    describe('OWNERSHIPS controller guard', function () {
        // Deed-over of a controlled token's ownership routes to the `ownership` class via the
        // synthetic SWEEP_OWNERSHIP action, run once per swept ownership at from=SOURCE, to=DESTINATION.
        it('runs the ownership guard once per swept ownership (actionType SWEEP_OWNERSHIP)', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves(['TEST', 'XTEST']);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getTicker.resolves('GAS');
            indexer.indexerDb.createActionIndex.resolves(99);

            const guardedOwnershipTicks = [];
            indexer.util.maybeRunControllerGuard = sinon.stub().callsFake(async (a, b, opts) => {
                if (opts.actionType === 'SWEEP_OWNERSHIP') {
                    assert.strictEqual(opts.from, SOURCE, 'ownership guard runs from SOURCE');
                    assert.strictEqual(opts.to, DESTINATION, 'ownership guard runs to DESTINATION');
                    guardedOwnershipTicks.push(opts.tick);
                }
                return { error: null, guardFee: '0' };
            });

            const data   = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', DESTINATION];
            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.deepStrictEqual(guardedOwnershipTicks.sort(), ['TEST', 'XTEST'],
                'each swept ownership is guarded exactly once');
        });
    });
});

describe('Sweep @regression @tier3', function () {
    beforeEach(freshSweep);
    afterEach(() => sinon.restore());

    describe('OWNERSHIPS controller guard', function () {
        // Fail-closed: a controller that denies the ownership deed must fail the WHOLE sweep before
        // status is fixed to 'valid'; no ISSUE (ownership transfer) may be written.
        it('a denied ownership guard fails the whole sweep (no ownership ISSUE written)', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves(['TEST']);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getTicker.resolves('GAS');
            indexer.indexerDb.createActionIndex.resolves(99);

            indexer.util.maybeRunControllerGuard = sinon.stub().callsFake(async (a, b, opts) => {
                if (opts.actionType === 'SWEEP_OWNERSHIP')
                    return { error: 'controller (ownership non-transferable)', guardFee: '0' };
                return { error: null, guardFee: '0' };
            });

            const data   = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', DESTINATION];
            await handler.parse(params, data, null);

            assert.ok(String(data['STATUS']).startsWith('invalid'), 'a denied ownership deed invalidates the sweep');
            assert.ok(!indexer.indexerDb.createIssue.called, 'no ownership transfer ISSUE on a denied sweep');
        });
    });
});

describe('Sweep @regression @tier3', function () {
    beforeEach(freshSweep);
    afterEach(() => sinon.restore());

    describe('OWNERSHIPS controller guard', function () {
        // CONSENSUS-DETERMINISM: ownership guards must run in byte order of the tick STRING, like the
        // BALANCES guards, so a post-reorg tick_id divergence can't reorder the guard executions.
        it('runs ownership guards in byte order of the tick string', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            // Deliberately unsorted input order.
            indexer.indexerDb.getAddressOwnerships.resolves(['ZZZ', 'AAA', 'MMM']);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getTicker.resolves('GAS');
            indexer.indexerDb.createActionIndex.resolves(99);

            const order = [];
            indexer.util.maybeRunControllerGuard = sinon.stub().callsFake(async (a, b, opts) => {
                if (opts.actionType === 'SWEEP_OWNERSHIP') order.push(opts.tick);
                return { error: null, guardFee: '0' };
            });

            const data   = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            await handler.parse(['0', DESTINATION], data, null);

            const byteSorted = [...order].sort((x, y) =>
                Buffer.compare(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8')));
            assert.deepStrictEqual(order, byteSorted,
                'ownership guards must execute in byte order of the resolved tick string');
            assert.notDeepStrictEqual(order, ['ZZZ', 'AAA', 'MMM'],
                'byte order must differ from the raw input order (test has teeth)');
        });

        // OWNERSHIPS=0 must not run any ownership guard.
        it('does not run the ownership guard when OWNERSHIPS=0', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves(['TEST']);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getTicker.resolves('GAS');

            let ownershipGuarded = false;
            indexer.util.maybeRunControllerGuard = sinon.stub().callsFake(async (a, b, opts) => {
                if (opts.actionType === 'SWEEP_OWNERSHIP') ownershipGuarded = true;
                return { error: null, guardFee: '0' };
            });

            const forceOrig = indexer.util.setActionParams.bind(indexer.util);
            indexer.util.setActionParams = (d, p, f, v) => Object.assign(forceOrig(d, p, f, v), { OWNERSHIPS: 0 });

            const data   = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            await handler.parse(['0', DESTINATION], data, null);

            assert.strictEqual(ownershipGuarded, false, 'no ownership guard runs when OWNERSHIPS=0');
        });

    });
});
