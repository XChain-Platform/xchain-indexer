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
// DISPENSE unit suite: what a settled dispense records, across several dispensers,
// in the ledger, for an ownership dispenser and for an unknown one. One part of
// dispense.test.js; the shared fixtures are in helpers/dispense_suite.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData } = require('../../../fixtures/mocks');
const { makeDispenserInfo, OWNER_ADDR, BUYER_ADDR, BLOCK_TIME, freshDispenseSuite } = require('./helpers/dispense_suite.js');

// The suite's fixtures. Every same-title block below runs freshSuite before
// each test, so each test starts from the same fixtures as the rest of the suite.
let indexer, dispense;
function freshSuite() {
    ({ indexer, dispense } = freshDispenseSuite());
}

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // ─── Multiple dispensers ──────────────────────────────────────────────

    it('multiple matching dispensers: createDispense called for each', async function () {
        const dispenser2 = makeDispenserInfo({ ACTION_INDEX: 11, GET_ADDRESS: OWNER_ADDR });
        indexer.indexerDb.findMatchingDispensers.resolves([10, 11]);
        indexer.indexerDb.getDispenserInfo
            .withArgs('BTC', 10, sinon.match.any)
            .resolves(makeDispenserInfo());
        indexer.indexerDb.getDispenserInfo
            .withArgs('BTC', 11, sinon.match.any)
            .resolves(dispenser2);

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        assert.ok(indexer.indexerDb.createDispense.callCount >= 2,
            `Expected createDispense called >=2, got ${indexer.indexerDb.createDispense.callCount}`);
    });

    // ─── Ledger changes ───────────────────────────────────────────────────

    it('valid dispense processes ledger changes and updates balances', async function () {
        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        sinon.assert.calledOnce(indexer.indexerDb.updateBalances);
    });

    it('valid dispense creates action mappings', async function () {
        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await dispense.parse([], data, false);

        sinon.assert.calledOnce(indexer.mapper.createMappings);
    });
});

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // ─── Ownership dispense (GIVE_OWNERSHIP=1) ────────────────────────────
    it('ownership dispense transfers token ownership to the buyer', async function () {
        indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({ GIVE_OWNERSHIP: 1 }));

        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });
        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.strictEqual(rec['STATUS'], 'valid');
        sinon.assert.called(indexer.indexerDb.clearTokenEscrow);  // ownership transfer path
        sinon.assert.called(indexer.indexerDb.createIssue);
        sinon.assert.notCalled(indexer.indexerDb.createEscrow);   // no balance escrow move
    });
});

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // Regression for the dead 'invalid: Dispenser unknown' branch: getDispenserInfo
    // returning falsy for a matched action_index must not throw a TypeError out of
    // the settlement loop (dispenserInfo[...] is never populated for it).
    // It is skipped with no dispense recorded.
    it('unknown dispenser (getDispenserInfo returns false): does not throw, no dispense recorded for it', async function () {
        indexer.indexerDb.findMatchingDispensers.resolves([10]);
        indexer.indexerDb.getDispenserInfo.resolves(false);

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await assert.doesNotReject(dispense.parse([], data, false));

        // No settlement occurs for an unknown dispenser: nothing pushed/created for it.
        sinon.assert.notCalled(indexer.indexerDb.createDispense);
    });

    it('unknown dispenser mixed with a valid one: valid dispenser still settles cleanly', async function () {
        const dispenser2 = makeDispenserInfo({ ACTION_INDEX: 11, GET_ADDRESS: OWNER_ADDR });
        indexer.indexerDb.findMatchingDispensers.resolves([10, 11]);
        indexer.indexerDb.getDispenserInfo
            .withArgs('BTC', 10, sinon.match.any)
            .resolves(false);
        indexer.indexerDb.getDispenserInfo
            .withArgs('BTC', 11, sinon.match.any)
            .resolves(dispenser2);

        const data = createBaseData({
            ACTION:      'DISPENSE',
            SOURCE:      BUYER_ADDR,
            COIN_AMOUNT: '0.01',
            BLOCK_TIME,
        });

        await assert.doesNotReject(dispense.parse([], data, false));

        // Only the known dispenser (11) produces a record.
        sinon.assert.calledOnce(indexer.indexerDb.createDispense);
        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.strictEqual(rec['DISPENSER_ACTION_INDEX'], 11);
    });
});
