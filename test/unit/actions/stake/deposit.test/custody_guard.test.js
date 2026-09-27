'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const {
    SOURCE,
    CONTRACT_INDEX,
    CUSTODY,
    DENY_CONTROLLER,
    ALLOW_CONTROLLER,
    makeDepositCustodyContext,
} = require('./helpers/custody_guard_fixture');

function depositData(extra = {}) {
    return createBaseData({ ACTION: 'DEPOSIT', FORMAT: 0, SOURCE, ...extra });
}

async function runDeposit(context, options = {}) {
    const tick = options.tick || 'TEST';
    const amount = options.amount || '10';
    const data = depositData(options.data);
    await context.handler.parse(['0', CONTRACT_INDEX, tick, amount], data, null);
    return data;
}

function ledgerLegs(context) {
    const [, , credits, debits] = context.ledgerSpy.firstCall.args;
    return { credits, debits };
}

function normalizedLegs(legs) {
    return legs.map(([tick, amount, address]) => [tick, String(amount), address]);
}

function assertDepositLegs(context) {
    const legs = ledgerLegs(context);
    assert.deepStrictEqual(normalizedLegs(legs.credits), [['TEST', '10', CUSTODY]]);
    assert.deepStrictEqual(normalizedLegs(legs.debits), [['TEST', '10', SOURCE]]);
}

function assertNoLedgerLegs(context) {
    assert.deepStrictEqual(ledgerLegs(context), { credits: [], debits: [] });
}

function maximumGuardFee(context) {
    const { config, util } = context.indexer;
    return util.bcmul(util.resolveGuardGasCeiling(config), config['GAS_PRICE'], 8);
}

function noGasInfoRead(context) {
    const gasTick = context.indexer.config['GAS'];
    return !context.indexer.indexerDb.getTokenInfo.getCalls()
        .some((call) => call.args[0] === gasTick);
}

describe('DEPOSIT custody guard handler @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('bypasses a denying token controller before activation', async function () {
        const context = makeDepositCustodyContext({
            custodyGuard: false,
            tokenBinding: { actionClass: 'transfer', contract_index: DENY_CONTROLLER },
        });
        const data = await runDeposit(context);

        assert.strictEqual(data['STATUS'], 'valid');
        assertDepositLegs(context);
        assert.deepStrictEqual(context.guardCalls, []);
        assert.strictEqual(noGasInfoRead(context), true);
    });

    it('bypasses a denying depositor controller before activation', async function () {
        const context = makeDepositCustodyContext({
            custodyGuard: false,
            addressBinding: { actionClass: 'transfer', contract_index: DENY_CONTROLLER },
        });
        const data = await runDeposit(context);

        assert.strictEqual(data['STATUS'], 'valid');
        assertDepositLegs(context);
        assert.deepStrictEqual(context.guardCalls, []);
        assert.strictEqual(noGasInfoRead(context), true);
    });
});

describe('DEPOSIT custody guard verdicts @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('rejects a token guard denial without settlement legs', async function () {
        const context = makeDepositCustodyContext({
            custodyGuard: true,
            tokenBinding: { actionClass: 'transfer', contract_index: DENY_CONTROLLER },
        });
        const data = await runDeposit(context);

        assert.strictEqual(data['STATUS'], 'invalid: policy denied');
        assertNoLedgerLegs(context);
        assert.strictEqual(context.guardCalls.length, 1);
        assert.strictEqual(context.guardCalls[0].controllerIndex, DENY_CONTROLLER);
    });

    it('rejects a depositor guard denial without settlement legs', async function () {
        const context = makeDepositCustodyContext({
            custodyGuard: true,
            addressBinding: { actionClass: 'transfer', contract_index: DENY_CONTROLLER },
        });
        const data = await runDeposit(context);

        assert.strictEqual(data['STATUS'], 'invalid: policy denied');
        assertNoLedgerLegs(context);
        assert.strictEqual(context.guardCalls.length, 1);
        assert.strictEqual(context.guardCalls[0].controllerIndex, DENY_CONTROLLER);
    });

    it('burns the summed metered fee when both guards allow', async function () {
        const context = makeDepositCustodyContext({
            custodyGuard: true,
            tokenBinding: { actionClass: 'transfer', contract_index: ALLOW_CONTROLLER },
            addressBinding: { actionClass: 'transfer', contract_index: ALLOW_CONTROLLER },
        });
        const data = await runDeposit(context);
        const eachFee = context.indexer.util.bcmul('1000', context.indexer.config['GAS_PRICE'], 8);
        const totalFee = context.indexer.util.bcadd(eachFee, eachFee, 8);
        const legs = ledgerLegs(context);

        assert.strictEqual(data['STATUS'], 'valid');
        assert.deepStrictEqual(normalizedLegs(legs.credits), [['TEST', '10', CUSTODY]]);
        assert.deepStrictEqual(normalizedLegs(legs.debits), [
            ['TEST', '10', SOURCE],
            [context.indexer.config['GAS'], String(totalFee), SOURCE],
        ]);
        assert.strictEqual(context.guardCalls.length, 2);
        assert.deepStrictEqual(
            context.guardCalls.map(({ actionType, tick, from, to, amount }) =>
                ({ actionType, tick, from, to, amount })),
            [
                { actionType: 'DEPOSIT', tick: 'TEST', from: SOURCE, to: CUSTODY, amount: '10' },
                { actionType: 'DEPOSIT', tick: 'TEST', from: SOURCE, to: CUSTODY, amount: '10' },
            ]
        );
    });
});

describe('DEPOSIT custody guard routing @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it("runs catch-all bindings on the token and depositor", async function () {
        const context = makeDepositCustodyContext({
            custodyGuard: true,
            tokenBinding: { actionClass: 'all', contract_index: ALLOW_CONTROLLER },
            addressBinding: { actionClass: 'all', contract_index: ALLOW_CONTROLLER },
        });
        const data = await runDeposit(context);

        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(context.guardCalls.length, 2);
        assert.deepStrictEqual(
            context.guardCalls.map((call) => call.controllerIndex),
            [ALLOW_CONTROLLER, ALLOW_CONTROLLER]
        );
    });

    it("keeps today's legs for an unbound token and depositor", async function () {
        const context = makeDepositCustodyContext({ custodyGuard: true });
        const data = await runDeposit(context);

        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(JSON.stringify(ledgerLegs(context)), JSON.stringify({
            credits: [['TEST', '10', CUSTODY]],
            debits: [['TEST', '10', SOURCE]],
        }));
        assert.deepStrictEqual(context.guardCalls, []);
    });
});

describe('DEPOSIT custody guard gas @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('rejects a guarded BTC deposit with no guard gas', async function () {
        const context = makeDepositCustodyContext({
            custodyGuard: true,
            balances: { [SOURCE]: { 1: '1000' } },
            tokenBinding: { actionClass: 'transfer', contract_index: ALLOW_CONTROLLER },
        });
        const data = await runDeposit(context);

        assert.strictEqual(data['STATUS'], 'invalid: insufficient funds (guard gas)');
        assertNoLedgerLegs(context);
        assert.deepStrictEqual(context.guardCalls, []);
    });

    it('reserves gas after debiting the deposit when TICK equals GAS', async function () {
        const context = makeDepositCustodyContext({
            custodyGuard: true,
            addressBinding: { actionClass: 'transfer', contract_index: ALLOW_CONTROLLER },
        });
        const maxFee = maximumGuardFee(context);
        const sourceBalance = context.indexer.util.bcadd(
            '10', context.indexer.util.bcsub(maxFee, '0.00000001', 8), 8
        );
        context.indexer.indexerDb.getAddressBalances.callsFake(async () => ({ 2: sourceBalance }));
        const data = await runDeposit(context, { tick: context.indexer.config['GAS'] });

        assert.strictEqual(data['STATUS'], 'invalid: insufficient funds (guard gas)');
        assertNoLedgerLegs(context);
        assert.deepStrictEqual(context.guardCalls, []);
    });

    it('reserves the first fee before checking the second guard ceiling', async function () {
        const context = makeDepositCustodyContext({
            custodyGuard: true,
            tokenBinding: { actionClass: 'transfer', contract_index: ALLOW_CONTROLLER },
            addressBinding: { actionClass: 'transfer', contract_index: ALLOW_CONTROLLER },
        });
        const maxFee = maximumGuardFee(context);
        context.indexer.indexerDb.getAddressBalances.callsFake(async () => ({
            1: '1000', 2: maxFee,
        }));
        const data = await runDeposit(context);

        assert.strictEqual(data['STATUS'], 'invalid: insufficient funds (guard gas)');
        assertNoLedgerLegs(context);
        assert.strictEqual(context.guardCalls.length, 1);
        assert.strictEqual(context.guardCalls[0].controllerIndex, ALLOW_CONTROLLER);
    });
});

describe('DEPOSIT custody guard inert probes @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('names the token in a guard-inert refusal', async function () {
        const context = makeDepositCustodyContext({
            custodyGuard: true,
            tokenBinding: { actionClass: 'transfer', contract_index: ALLOW_CONTROLLER },
        });
        const data = await runDeposit(context, { data: { GUARD_INERT: true } });

        assert.strictEqual(context.indexer.util.isGuardInertError(data['STATUS']), true);
        assert.ok(data['STATUS'].includes('token TEST'));
        assertNoLedgerLegs(context);
        assert.deepStrictEqual(context.guardCalls, []);
    });

    it('names the depositor when only its address is bound during an inert probe', async function () {
        const context = makeDepositCustodyContext({
            custodyGuard: true,
            addressBinding: { actionClass: 'transfer', contract_index: ALLOW_CONTROLLER },
        });
        const data = await runDeposit(context, { data: { GUARD_INERT: true } });

        assert.strictEqual(context.indexer.util.isGuardInertError(data['STATUS']), true);
        assert.ok(data['STATUS'].includes('address ' + SOURCE));
        assertNoLedgerLegs(context);
        assert.deepStrictEqual(context.guardCalls, []);
    });
});
