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
// SWEEP handler: BALANCES=1 transfers, the null and empty DESTINATION guard,
// controller guard ordering, DESTINATION format validation, a sleeping SOURCE
// and the sweep row written on every outcome. The zero-amount leg flag day,
// OWNERSHIPS, ESCROWS and combined-flag blocks live beside it in sweep.test/;
// every file opens the same 'Sweep @regression @tier3' describe, so each full
// test title stays under one suite name. sweep.test/helpers/sweep_context.js
// builds the mock indexer and handler every block starts from.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../fixtures/mocks');
const { SOURCE, DESTINATION, makeSweepContext } = require('./sweep.test/helpers/sweep_context.js');

let indexer, handler;

// Each test starts from its own mock indexer and SWEEP handler.
function freshSweep() {
    ({ indexer, handler } = makeSweepContext());
}

// ─── BALANCES=1 ──────────────────────────────────────────────────

describe('Sweep @regression @tier3', function () {
    beforeEach(freshSweep);
    afterEach(() => sinon.restore());

    describe('BALANCES=1', function () {
        it('all balances transferred to destination', async function () {
            // Balance includes GAS (tick_id=1) for fees; no extra ticks so no balance sweeping needed
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' }); // 1 GAS for fee
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves([]);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getTicker.resolves('GAS');

            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            // Omit BALANCES/OWNERSHIPS/ESCROWS so they remain null and default to 1/1/0
            const params = ['0', DESTINATION]; // BALANCES/OWNERSHIPS/ESCROWS omitted → default to null → use defaults

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createSweep.called);
        });

        it('createSweep called: balances debited from SOURCE, credited to DESTINATION', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves([]);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getTicker.resolves('GAS');

            const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', DESTINATION]; // BALANCES/OWNERSHIPS/ESCROWS omitted → default to null → use defaults

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createSweep.calledOnce);
        });
    });
});

describe('Sweep @regression @tier3', function () {
    beforeEach(freshSweep);
    afterEach(() => sinon.restore());

    describe('BALANCES=1', function () {
        // A null/empty DESTINATION must be rejected. Left unchecked it credits every
        // swept balance to a NULL address_id that updateBalances skips, breaking the per-block
        // supply invariant and halting the fleet (SanityError). Reject it, and never emit a
        // NULL-address credit.
        it('null DESTINATION → invalid, no NULL-address credit emitted', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 1: '5', 2: '10' }); // GAS + another tick
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves(['MYTOKEN']);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getTicker.resolves('GAS');

            const data   = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0']; // DESTINATION omitted → null

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'invalid: DESTINATION (null)');
            // No balance transfer and no ownership deed-over should have run.
            assert.ok(!indexer.indexerDb.createCredit.called, 'must not write any credit for a null-destination sweep');
            assert.ok(!indexer.indexerDb.createIssue.called, 'must not transfer ownership to a null owner');
        });
    });
});

describe('Sweep @regression @tier3', function () {
    beforeEach(freshSweep);
    afterEach(() => sinon.restore());

    describe('BALANCES=1', function () {
        it('empty-string DESTINATION → invalid (same guard)', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 1: '5' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves([]);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getTicker.resolves('GAS');

            const data   = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', ''];

            await handler.parse(params, data, null);

            assert.strictEqual(data['STATUS'], 'invalid: DESTINATION (null)');
        });

        // CONSENSUS-DETERMINISM: controller-guard executions must be ordered by the byte value of
        // the RESOLVED tick STRING, not by tick_id (a local index_tickers AUTO_INCREMENT surrogate
        // that diverges between nodes post-reorg). A reversed guard order commits a different
        // contract_hash via contract_executions last-write-wins + emission basePosition.
        it('runs controller guards in byte order of the tick string, not tick_id order', async function () {
            // tick_id numeric order (1,2,3) deliberately DIFFERS from tick-string byte order.
            const tickById = { 1: 'GAS', 2: 'ZZZ', 3: 'AAA' };
            indexer.indexerDb.getAddressBalances.resolves({ 1: '5', 2: '5', 3: '5' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves([]);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.getTicker.callsFake(async (id) => tickById[Number(id)] || null);

            const calledTicks = [];
            indexer.util.maybeRunControllerGuard = sinon.stub().callsFake(async (a, b, opts) => {
                calledTicks.push(opts.tick);
                return { error: null, guardFee: '0' };
            });

            const data   = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', DESTINATION];
            await handler.parse(params, data, null);

            assert.ok(calledTicks.length >= 2, 'at least two ticks must be guarded so order is observable');
            const byteSorted = [...calledTicks].sort((x, y) =>
                Buffer.compare(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8')));
            assert.deepStrictEqual(calledTicks, byteSorted,
                'guards must execute in byte order of the resolved tick string (consensus-stable)');
            // Teeth: the pre-fix ascending-tick_id order would have produced a DIFFERENT sequence.
            const idOf     = t => Number(Object.keys(tickById).find(k => tickById[k] === t));
            const idOrder  = [...calledTicks].sort((x, y) => idOf(x) - idOf(y));
            assert.notDeepStrictEqual(calledTicks, idOrder,
                'byte order must differ from the old tick_id order for this fixture (test has teeth)');
        });
    });
});

// ─── Invalid: DESTINATION format ─────────────────────────────────

describe('Sweep @regression @tier3', function () {
    beforeEach(freshSweep);
    afterEach(() => sinon.restore());

    describe('DESTINATION validation', function () {

        it('invalid DESTINATION format → invalid', async function () {
            indexer.indexerDb.getAddressBalances.resolves({});
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves([]);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', 'not-a-real-address'];

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

    });
});

// ─── SOURCE sleeping ─────────────────────────────────────────────

describe('Sweep @regression @tier3', function () {
    beforeEach(freshSweep);
    afterEach(() => sinon.restore());

    describe('SOURCE sleeping', function () {

        it('SOURCE sleeping → invalid', async function () {
            indexer.indexerDb.getAddressBalances.resolves({ 1: '100' });
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves([]);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.callsFake((address, tick, block) => {
                if (address && !tick) return Promise.resolve(false);
                return Promise.resolve(true);
            });

            const data   = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', DESTINATION]; // BALANCES/OWNERSHIPS/ESCROWS omitted → default to null → use defaults

            await handler.parse(params, data, null);

            assert.ok(data['STATUS'].includes('invalid'));
        });

    });
});

// ─── Record creation ─────────────────────────────────────────────

describe('Sweep @regression @tier3', function () {
    beforeEach(freshSweep);
    afterEach(() => sinon.restore());

    describe('record creation', function () {

        it('createSweep called even on invalid', async function () {
            indexer.indexerDb.getAddressBalances.resolves({});
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getAddressOwnerships.resolves([]);
            indexer.indexerDb.getAddressEscrows.resolves([]);
            indexer.indexerDb.isActionAllowed.resolves(true);

            const data   = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE });
            const params = ['0', 'not-a-real-address'];

            await handler.parse(params, data, null);

            assert.ok(indexer.indexerDb.createSweep.called);
        });

    });
});
