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
// DISPENSE unit suite: Mode B oracle pricing per token under the
// DISPENSER_ORACLE_PER_TOKEN_PRICE gate. One part of dispense.test.js; the shared
// fixtures are in helpers/dispense_suite.js.

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

// The measured case, LTC regtest 2026-07-31, DISPENSE 1956: oracle at
// 1.5 USD per XCHAIN, GIVE_AMOUNT 5, a 0.37 LTC payment worth $11.10.
// That is 7.4 tokens of affordability => 1 whole fill of 5 tokens ($7.50),
// where the chain credited 7 fills / 35 tokens ($0.317 a token).
const MEASURED = { units: 7, rawUnits: '7.4' };

function modeBDispenser(overrides = {}) {
    return makeDispenserInfo({
        FIAT: 'USD', FIAT_AMOUNT: null, GET_AMOUNT: null,
        ORACLE_ADDRESS: '1OracleAddrXXXXXXXXXXXXXXXXXXXX',
        GIVE_AMOUNT: '5', GIVE_REMAINING: '100',
        ...overrides,
    });
}

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    // DISPENSER_ORACLE_PER_TOKEN_PRICE.
    //
    // A PRICE v1 oracle publishes the price of one TOKEN. Below the activation
    // dispense.js used the affordable TOKEN count as the FILL multiplier and then
    // credited multiplier x GIVE_AMOUNT, so a dispenser giving N per fill sold each
    // token at 1/N of the published price. Above it the token count is divided by
    // GIVE_AMOUNT first. Both sides are pinned: a replay of a pre-activation block
    // must still credit the old amount, or historical mainnet state forks.
    //
    // Every case here uses GIVE_AMOUNT != 1 on purpose. At GIVE_AMOUNT 1 the two
    // readings coincide exactly, which is the whole reason this survived every
    // documented example and every test written before 2026-07-31.
    describe('DISPENSER_ORACLE_PER_TOKEN_PRICE gate (Mode B)', function () {
        it('at activation the published price buys one TOKEN, not one fill', async function () {
            indexer.indexerDb.getDispenserInfo.resolves(modeBDispenser());
            sinon.stub(indexer.util, 'reverseOraclePriceMatch').resolves(MEASURED);

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.37', BLOCK_TIME });
            await dispense.parse([], data, false);

            const rec = indexer.indexerDb.createDispense.firstCall.args[0];
            assert.strictEqual(rec['STATUS'], 'valid');
            assert.strictEqual(String(rec['GIVE_AMOUNT']), '5',
                '7.4 affordable tokens at 5 per fill is ONE fill of 5 tokens');
        });

        it('below activation it still credits the legacy per-fill amount', async function () {
            // Only this gate is flipped, so a changed verdict cannot be attributed
            // to some other dispenser gate switching at the same time.
            actionsCtx.protocolChanges.isEnabled
                .withArgs('DISPENSER_ORACLE_PER_TOKEN_PRICE', sinon.match.any).resolves(false);
            indexer.indexerDb.getDispenserInfo.resolves(modeBDispenser());
            sinon.stub(indexer.util, 'reverseOraclePriceMatch').resolves(MEASURED);

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.37', BLOCK_TIME });
            await dispense.parse([], data, false);

            const rec = indexer.indexerDb.createDispense.firstCall.args[0];
            assert.strictEqual(rec['STATUS'], 'valid');
            assert.strictEqual(String(rec['GIVE_AMOUNT']), '35',
                'a pre-activation block must replay to the 35 XCHAIN the chain actually credited');
        });
    });
});

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('DISPENSER_ORACLE_PER_TOKEN_PRICE gate (Mode B)', function () {
        it('agrees with the legacy reading exactly at GIVE_AMOUNT 1', async function () {
            // The two readings coincide at 1, so the flag day must be a no-op there
            // and no live GIVE_AMOUNT-1 dispenser changes behavior on the day.
            indexer.indexerDb.getDispenserInfo.resolves(modeBDispenser({ GIVE_AMOUNT: '1' }));
            sinon.stub(indexer.util, 'reverseOraclePriceMatch').resolves(MEASURED);
            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.37', BLOCK_TIME });

            for(const enabled of [true, false]){
                indexer.indexerDb.createDispense.resetHistory();
                actionsCtx.protocolChanges.isEnabled
                    .withArgs('DISPENSER_ORACLE_PER_TOKEN_PRICE', sinon.match.any).resolves(enabled);

                await dispense.parse([], data, false);

                const rec = indexer.indexerDb.createDispense.firstCall.args[0];
                assert.strictEqual(String(rec['GIVE_AMOUNT']), '7',
                    `GIVE_AMOUNT 1 must settle identically with the gate ${enabled ? 'on' : 'off'}`);
            }
        });
    });
});

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('DISPENSER_ORACLE_PER_TOKEN_PRICE gate (Mode B)', function () {
        it('floors the fill count ONCE, so a sub-1 GIVE_AMOUNT is not under-credited', async function () {
            // 1.75 affordable tokens at half a token per fill is 3 fills = 1.5
            // tokens. Flooring to whole tokens first (floor(floor(1.75)/0.5)) gives
            // 2 fills = 1 token, which quietly keeps 0.5 of a token the buyer paid
            // for. Only reachable on a divisible token, which is most of them.
            indexer.indexerDb.getDispenserInfo.resolves(modeBDispenser({
                GIVE_AMOUNT: '0.5', GIVE_REMAINING: '100',
            }));
            sinon.stub(indexer.util, 'reverseOraclePriceMatch').resolves({ units: 1, rawUnits: '1.75' });

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });
            await dispense.parse([], data, false);

            const rec = indexer.indexerDb.createDispense.firstCall.args[0];
            assert.strictEqual(rec['STATUS'], 'valid');
            assert.strictEqual(String(rec['GIVE_AMOUNT']), '1.5');
        });

        it('falls back to the whole-token count when the matcher supplies no rawUnits', async function () {
            indexer.indexerDb.getDispenserInfo.resolves(modeBDispenser({ GIVE_AMOUNT: '2' }));
            sinon.stub(indexer.util, 'reverseOraclePriceMatch').resolves({ units: 7 });

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.37', BLOCK_TIME });
            await dispense.parse([], data, false);

            const rec = indexer.indexerDb.createDispense.firstCall.args[0];
            assert.strictEqual(String(rec['GIVE_AMOUNT']), '6', 'floor(7/2) = 3 fills of 2 tokens');
        });

        it('rejects a payment that does not cover one whole fill', async function () {
            // The matcher matched (the buyer can afford at least one token) but the
            // dispenser only sells in blocks of 5. Under-payment must be refused,
            // not rounded up, and the message is the existing insufficient-funds one.
            indexer.indexerDb.getDispenserInfo.resolves(modeBDispenser());
            sinon.stub(indexer.util, 'reverseOraclePriceMatch').resolves({ units: 4, rawUnits: '4.9' });

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.2', BLOCK_TIME });
            await dispense.parse([], data, false);

            const rec = indexer.indexerDb.createDispense.firstCall.args[0];
            assert.ok(String(rec['STATUS']).startsWith('invalid: insufficient funds'),
                `expected an insufficient-funds refusal, got ${rec['STATUS']}`);
        });
    });
});

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('DISPENSER_ORACLE_PER_TOKEN_PRICE gate (Mode B)', function () {
        it('does not divide by a balance dispenser empty GIVE_AMOUNT', async function () {
            // The case the giveAmountPositive guard covers: a BALANCE dispenser opened
            // with an empty GIVE_AMOUNT, still legal below
            // dispenser_give_amount_activation. Dividing here would be a divide-by-zero,
            // and bcdiv's zero-divisor return of 0 would refuse every such dispense as
            // insufficient funds instead of leaving the legacy verdict in place.
            indexer.indexerDb.getDispenserInfo.resolves(modeBDispenser({
                GIVE_AMOUNT: null, GIVE_REMAINING: '100',
            }));
            sinon.stub(indexer.util, 'reverseOraclePriceMatch').resolves(MEASURED);

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.37', BLOCK_TIME });
            await dispense.parse([], data, false);

            const rec = indexer.indexerDb.createDispense.firstCall.args[0];
            assert.strictEqual(rec['STATUS'], 'valid', 'the legacy verdict must be left in place');
        });

        it('divides for an ownership dispenser, whose GIVE_AMOUNT arrives virtualized to 1', async function () {
            // getDispenserInfo never hands this handler the wire-level empty
            // GIVE_AMOUNT: an ownership dispenser arrives as '1', so the per-token
            // divide runs and 7 affordable tokens become 7 fills, capped to the single
            // fill an ownership dispenser is allowed.
            indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();
            indexer.indexerDb.getDispenserInfo.resolves(modeBDispenser({
                GIVE_OWNERSHIP: 1, GIVE_AMOUNT: '1', GIVE_ESCROW: '1', GIVE_REMAINING: '1',
            }));
            sinon.stub(indexer.util, 'reverseOraclePriceMatch').resolves(MEASURED);

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.37', BLOCK_TIME });
            await dispense.parse([], data, false);

            const rec = indexer.indexerDb.createDispense.firstCall.args[0];
            assert.strictEqual(rec['STATUS'], 'valid', 'an ownership dispense must still settle');
            assert.strictEqual(String(rec['GIVE_AMOUNT']), '1', 'single-shot: exactly one fill');
            sinon.assert.called(indexer.indexerDb.clearTokenEscrow);
        });
    });
});

describe('Dispense action handler @regression @tier2', function () {
    beforeEach(freshSuite);
    afterEach(function () { sinon.restore(); });

    describe('DISPENSER_ORACLE_PER_TOKEN_PRICE gate (Mode B)', function () {
        it('never touches Mode A, which prices from the validator snapshot', async function () {
            // Mode A's FIAT_AMOUNT is a separate surface with its own reading; this
            // decision moved Mode B only, so the gate must not even be consulted.
            const isEnabled = actionsCtx.protocolChanges.isEnabled;
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo({
                FIAT: 'USD', FIAT_AMOUNT: '100', ORACLE_ADDRESS: null, GET_AMOUNT: null,
                GIVE_AMOUNT: '5', GIVE_REMAINING: '100',
            }));
            sinon.stub(indexer.util, 'reversePriceMatch').resolves({ units: 7 });

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.37', BLOCK_TIME });
            await dispense.parse([], data, false);

            const rec = indexer.indexerDb.createDispense.firstCall.args[0];
            assert.strictEqual(String(rec['GIVE_AMOUNT']), '35');
            assert.ok(!isEnabled.getCalls().some(c => c.args[0] === 'DISPENSER_ORACLE_PER_TOKEN_PRICE'),
                'a Mode A dispense must not query the Mode B gate');
        });
    });

    describe('DISPENSER_ORACLE_PER_TOKEN_PRICE gate (Mode B)', function () {
        it('never touches a non-FIAT dispenser', async function () {
            const isEnabled = actionsCtx.protocolChanges.isEnabled;
            indexer.indexerDb.getDispenserInfo.resolves(makeDispenserInfo());

            const data = createBaseData({ ACTION: 'DISPENSE', SOURCE: BUYER_ADDR, COIN_AMOUNT: '0.01', BLOCK_TIME });
            await dispense.parse([], data, false);

            assert.ok(!isEnabled.getCalls().some(c => c.args[0] === 'DISPENSER_ORACLE_PER_TOKEN_PRICE'),
                'the ordinary GET_AMOUNT path must not query the Mode B gate');
        });
    });
});
