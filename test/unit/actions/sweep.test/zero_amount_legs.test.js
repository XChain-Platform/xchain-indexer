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
// SWEEP zero-amount leg flag day: below the height a held tick with nothing
// to move still writes its zero-amount credit and debit legs; at and above
// it they are skipped, and mainnet is inert.
// Part of the SWEEP suite; see ../sweep.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../fixtures/mocks');
const { SOURCE, DESTINATION, makeSweepContext } = require('./helpers/sweep_context.js');

const { SWEEP_ZERO_LEG_ACTIVATION } = require('../../../../src/sweep_zero_leg_activation.js');

let indexer, handler;

// Each test starts from its own mock indexer and SWEEP handler.
function freshSweep() {
    ({ indexer, handler } = makeSweepContext());
}

// GAS (tick_id=1) pays the fee; tick_id=2 is held at exactly 0, nothing to move.
function zeroTickStubs() {
    indexer.indexerDb.getAddressBalances.resolves({ 1: '1', 2: '0' });
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    indexer.indexerDb.getAddressOwnerships.resolves([]);
    indexer.indexerDb.getAddressEscrows.resolves([]);
    indexer.indexerDb.isActionAllowed.resolves(true);
    const tickById = { 1: 'GAS', 2: 'ZEROTICK' };
    indexer.indexerDb.getTicker.callsFake(async (id) => tickById[Number(id)] || null);
}

async function sweepAt(network, blockIndex) {
    handler.config = Object.assign({}, indexer.config, { NETWORK: network });
    const data = createBaseData({ ACTION: 'SWEEP', FORMAT: 0, SOURCE, COIN: 'BTC', BLOCK_INDEX: blockIndex });
    await handler.parse(['0', DESTINATION], data, null);
    assert.strictEqual(data['STATUS'], 'valid');
    // Teeth: the non-zero GAS leg settles on both sides of the height.
    assert.ok(indexer.indexerDb.createCredit.calledWith(sinon.match.any, 'GAS', sinon.match.any, DESTINATION),
        'the non-zero GAS balance must still be credited');
    return data;
}

function assertZeroLegsWritten() {
    assert.ok(indexer.indexerDb.createDebit.calledWith(sinon.match.any, 'ZEROTICK', '0', SOURCE),
        'below the height the zero-amount debit leg is written as the deployed fleet writes it');
    assert.ok(indexer.indexerDb.createCredit.calledWith(sinon.match.any, 'ZEROTICK', '0', DESTINATION),
        'below the height the zero-amount credit leg is written as the deployed fleet writes it');
}

// ─── BALANCES=1 ──────────────────────────────────────────────────

describe('Sweep @regression @tier3', function () {
    beforeEach(freshSweep);
    afterEach(() => sinon.restore());

    describe('BALANCES=1', function () {
        // A SWEEP with nothing to move for a held tick wrote a zero-amount credit/debit
        // leg for it (seen on SWEEP 1237, amount "0"), a fake row on the action page and
        // the address Credits tab. Those rows are in the hashed ledger, so the skip is
        // gated on the SWEEP's own chain height (sweep_zero_leg_activation.js): the legs
        // are written below the height and skipped at/above it.
        describe('zero-amount leg flag day', function () {
            const BTC_TESTNET_HEIGHT = SWEEP_ZERO_LEG_ACTIVATION['BTC:testnet'];

            function assertZeroLegsSkipped() {
                assert.ok(!indexer.indexerDb.createCredit.calledWith(sinon.match.any, 'ZEROTICK', sinon.match.any, sinon.match.any),
                    'no credit leg for a held tick with nothing to move');
                assert.ok(!indexer.indexerDb.createDebit.calledWith(sinon.match.any, 'ZEROTICK', sinon.match.any, sinon.match.any),
                    'no debit leg for a held tick with nothing to move');
            }

            it('testnet BTC one block below the height still writes the zero-amount legs', async function () {
                assert.ok(Number.isInteger(BTC_TESTNET_HEIGHT) && BTC_TESTNET_HEIGHT > 0, 'the BTC testnet height must be armed for this case to have teeth');
                zeroTickStubs();
                await sweepAt('testnet', BTC_TESTNET_HEIGHT - 1);
                assertZeroLegsWritten();
            });

            it('testnet BTC at the height emits no credit/debit leg for the zero balance', async function () {
                zeroTickStubs();
                await sweepAt('testnet', BTC_TESTNET_HEIGHT);
                assertZeroLegsSkipped();
            });

            it('testnet BTC above the height emits no credit/debit leg for the zero balance', async function () {
                zeroTickStubs();
                await sweepAt('testnet', BTC_TESTNET_HEIGHT + 1);
                assertZeroLegsSkipped();
            });

            it('regtest is genesis-active: block 100 emits no leg for the zero balance', async function () {
                assert.strictEqual(SWEEP_ZERO_LEG_ACTIVATION.regtest, 0);
                zeroTickStubs();
                await sweepAt('regtest', 100);
                assertZeroLegsSkipped();
            });
        });
    });
});

describe('Sweep @regression @tier3', function () {
    beforeEach(freshSweep);
    afterEach(() => sinon.restore());

    describe('BALANCES=1', function () {
        describe('zero-amount leg flag day', function () {
            it('mainnet is inert (null): the zero-amount legs are written at any height', async function () {
                assert.strictEqual(SWEEP_ZERO_LEG_ACTIVATION['BTC:mainnet'], null);
                zeroTickStubs();
                await sweepAt('mainnet', 10000000);
                assertZeroLegsWritten();
            });
        });

    });
});
