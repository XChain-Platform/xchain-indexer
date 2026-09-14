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
// DISPENSE unit suite: FIAT-priced dispensers and the FIAT_DISPENSER_PRICING gate.
// One part of dispense.test.js; the shared fixtures are in
// helpers/dispense_suite.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createBaseData } = require('../../../fixtures/mocks');
const { makeDispenserInfo, BUYER_ADDR, BLOCK_TIME, freshDispenseSuite } = require('./helpers/dispense_suite.js');

// The suite's fixtures. Every same-title block below runs freshSuite before
// each test, so each test starts from the same fixtures as the rest of the suite.
let indexer, actionsCtx, dispense;
function freshSuite() {
    ({ indexer, actionsCtx, dispense } = freshDispenseSuite());
}

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });
    // FIAT_DISPENSER_PRICING gate (follow-on to the give-remaining fix, operator decision 2026-07-24).
    // Genesis-active everywhere today, retrofitted while every mainnet chain held
    // zero dispensers, so it is byte-identical to the ungated code. Registered so
    // the settlement path is in the activation inventory with its siblings and so a
    // future matching correction has a height to hang off. These pin both states,
    // because an "off" branch nothing ever exercises is an unverified branch.
    describe('FIAT_DISPENSER_PRICING gate', function () {
        it('is genesis-active, so a FIAT dispenser settles normally', async function () {
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
                FIAT: 'USD', FIAT_AMOUNT: '100', ORACLE_ADDRESS: null, GET_AMOUNT: null,
            }));
            sinon.stub(indexer.util, 'reversePriceMatch').resolves({ units: 2 });

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.02', BLOCK_TIME });
            await dispense.parse([], data, false);

            const rec = indexer.indexerDb.createDispense.firstCall.args[0];
            assert.strictEqual(rec['STATUS'], 'valid',
                'the gate must be on from genesis, or live FIAT dispensers stop settling');
        });

        it('below activation a FIAT dispense is rejected without consulting any price', async function () {
            // Only this gate is flipped, so the rejection cannot be attributed to
            // some other dispenser gate going off at the same time.
            actionsCtx.protocolChanges.isEnabled
                .withArgs('FIAT_DISPENSER_PRICING', sinon.match.any).resolves(false);
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
                FIAT: 'USD', FIAT_AMOUNT: '100', ORACLE_ADDRESS: null, GET_AMOUNT: null,
            }));
            const match = sinon.stub(indexer.util, 'reversePriceMatch').resolves({ units: 2 });

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.02', BLOCK_TIME });
            await dispense.parse([], data, false);

            const rec = indexer.indexerDb.createDispense.firstCall.args[0];
            assert.strictEqual(rec['STATUS'], 'invalid: FIAT dispenser pricing not active');
            sinon.assert.notCalled(match);
        });

        it('below activation an ORACLE_ADDRESS dispense is rejected the same way', async function () {
            actionsCtx.protocolChanges.isEnabled
                .withArgs('FIAT_DISPENSER_PRICING', sinon.match.any).resolves(false);
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
                FIAT: 'JPY', FIAT_AMOUNT: null, ORACLE_ADDRESS: '1OracleAddrXXXXXXXXXXXXXXXXXXXX', GET_AMOUNT: null,
            }));
            const match = sinon.stub(indexer.util, 'reverseOraclePriceMatch').resolves({ units: 5 });

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.02', BLOCK_TIME });
            await dispense.parse([], data, false);

            const rec = indexer.indexerDb.createDispense.firstCall.args[0];
            assert.strictEqual(rec['STATUS'], 'invalid: FIAT dispenser pricing not active');
            sinon.assert.notCalled(match);
        });
    });
});

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('FIAT_DISPENSER_PRICING gate', function () {
        it('the gate never touches a non-FIAT dispenser', async function () {
            // A non-FIAT dispense must not consult FIAT_DISPENSER_PRICING at all, so
            // turning the gate off can never disturb the ordinary GET_AMOUNT path.
            const isEnabled = actionsCtx.protocolChanges.isEnabled;
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo());

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });
            await dispense.parse([], data, false);

            const rec = indexer.indexerDb.createDispense.firstCall.args[0];
            assert.strictEqual(rec['STATUS'], 'valid');
            assert.ok(!isEnabled.getCalls().some(c => c.args[0] === 'FIAT_DISPENSER_PRICING'),
                'non-FIAT dispenses must not query the FIAT gate');
        });
    });
});

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // ─── FIAT-priced dispenser (validator price snapshot) ─────────────────
    it('FIAT dispenser resolves units via reversePriceMatch', async function () {
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
            FIAT: 'USD', FIAT_AMOUNT: '100', ORACLE_ADDRESS: null, GET_AMOUNT: null,
        }));
        sinon.stub(indexer.util, 'reversePriceMatch').resolves({ units: 2 });

        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.02', BLOCK_TIME });
        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.strictEqual(rec['STATUS'], 'valid');
    });

    it('FIAT dispenser rejects when no price snapshot matches', async function () {
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
            FIAT: 'USD', FIAT_AMOUNT: '100', ORACLE_ADDRESS: null, GET_AMOUNT: null,
        }));
        sinon.stub(indexer.util, 'reversePriceMatch').resolves(null);

        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.02', BLOCK_TIME });
        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.strictEqual(rec['STATUS'], 'invalid: no matching price snapshot');
    });
});

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // ─── FIAT dispenser with a user oracle (cross-conversion) ─────────────
    it('FIAT dispenser with ORACLE_ADDRESS resolves units via reverseOraclePriceMatch', async function () {
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
            FIAT: 'JPY', FIAT_AMOUNT: '1000', ORACLE_ADDRESS: '1OracleAddrXXXXXXXXXXXXXXXXXXXX', GET_AMOUNT: null,
        }));
        const match = sinon.stub(indexer.util, 'reverseOraclePriceMatch').resolves({ units: 1 });

        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });
        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.strictEqual(rec['STATUS'], 'valid');

        // The matcher takes the priced-token chain (GIVE_COIN) for the oracle row
        // and the PAY coin (GET_COIN) for the validator pair. Equal today under the
        // same-chain guard, so pin the wiring rather than the values: passing
        // GIVE_COIN for both would be invisible until cross-chain dispensers land.
        const args = match.firstCall.args;
        assert.strictEqual(args[2], 'BTC', 'arg 3 is GIVE_COIN, the priced token chain');
        assert.strictEqual(args[8], 'BTC', 'arg 9 is GET_COIN, the coin the buyer pays');
    });

    it('FIAT oracle dispenser rejects when no oracle price matches', async function () {
        indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
            FIAT: 'JPY', FIAT_AMOUNT: '1000', ORACLE_ADDRESS: '1OracleAddrXXXXXXXXXXXXXXXXXXXX', GET_AMOUNT: null,
        }));
        sinon.stub(indexer.util, 'reverseOraclePriceMatch').resolves(null);

        const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });
        await dispense.parse([], data, false);

        const rec = indexer.indexerDb.createDispense.firstCall.args[0];
        assert.strictEqual(rec['STATUS'], 'invalid: no matching oracle price');
    });
});
