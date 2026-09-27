'use strict';

// SPDX-License-Identifier: AGPL-3.0-or-later

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const {
    SOURCE, CONTRACT_INDEX, TICK, CONTRACT_ADDRESS, makeData,
} = require('./helpers/withdraw_context.js');
const {
    DENY_CONTROLLER, ALLOW_CONTROLLER, makeWithdrawCustodyContext,
} = require('./helpers/custody_guard_context.js');

function binding(controller){
    return { actionClass: 'transfer', contract_index: controller };
}

async function withdraw(context){
    const data = makeData({ FORMAT: 0 });
    await context.handler.parse(['0', CONTRACT_INDEX, TICK, '10'], data, null);
    return data;
}

function ledgerLegs(context){
    return context.ledgerSpy.firstCall.args.slice(2);
}

function assertCustodyUntouched(context){
    const [credits, debits] = ledgerLegs(context);
    assert.deepStrictEqual(credits, []);
    assert.deepStrictEqual(debits, []);
}

async function activateAfterBalanceExists(context){
    let active = false;
    context.actionsCtx.protocolChanges.isEnabled.callsFake(async (name) => {
        return name === 'CONTROLLER_CUSTODY_GUARD' ? active : true;
    });
    assert.strictEqual(
        await context.actionsCtx.protocolChanges.isEnabled('CONTROLLER_CUSTODY_GUARD'),
        false
    );
    active = true;
}

describe('Withdraw custody guard handler integration @regression @tier1', function () {
    afterEach(() => sinon.restore());

    it('settles a token-bound denial before activation', async function () {
        const context = makeWithdrawCustodyContext({
            custodyGuard: false,
            tokenBinding: binding(DENY_CONTROLLER),
        });

        const data = await withdraw(context);

        assert.strictEqual(data.STATUS, 'valid');
        assert.deepStrictEqual(context.guardCalls, []);
        assert.deepStrictEqual(ledgerLegs(context), [
            [[TICK, '10', SOURCE]],
            [[TICK, '10', CONTRACT_ADDRESS]],
        ]);
    });

    it('settles an owner-address denial before activation', async function () {
        const context = makeWithdrawCustodyContext({
            custodyGuard: false,
            addressBinding: binding(DENY_CONTROLLER),
        });

        const data = await withdraw(context);

        assert.strictEqual(data.STATUS, 'valid');
        assert.deepStrictEqual(context.guardCalls, []);
        assert.deepStrictEqual(ledgerLegs(context), [
            [[TICK, '10', SOURCE]],
            [[TICK, '10', CONTRACT_ADDRESS]],
        ]);
    });

    it('rejects an activated token denial without moving custody', async function () {
        const context = makeWithdrawCustodyContext({
            custodyGuard: true,
            tokenBinding: binding(DENY_CONTROLLER),
        });

        const data = await withdraw(context);

        assert.strictEqual(data.STATUS, 'invalid: policy denied');
        assertCustodyUntouched(context);
    });

    it('rejects an activated owner-address denial without moving custody', async function () {
        const context = makeWithdrawCustodyContext({
            custodyGuard: true,
            addressBinding: binding(DENY_CONTROLLER),
        });

        const data = await withdraw(context);

        assert.strictEqual(data.STATUS, 'invalid: policy denied');
        assertCustodyUntouched(context);
    });

    it('does not grandfather a custody balance against a later token denial', async function () {
        const context = makeWithdrawCustodyContext({
            custodyGuard: false,
            tokenBinding: binding(DENY_CONTROLLER),
        });
        await activateAfterBalanceExists(context);

        const data = await withdraw(context);

        assert.strictEqual(data.STATUS, 'invalid: policy denied');
        assertCustodyUntouched(context);
    });

    it('does not grandfather a custody balance against a later address denial', async function () {
        const context = makeWithdrawCustodyContext({
            custodyGuard: false,
            addressBinding: binding(DENY_CONTROLLER),
        });
        await activateAfterBalanceExists(context);

        const data = await withdraw(context);

        assert.strictEqual(data.STATUS, 'invalid: policy denied');
        assertCustodyUntouched(context);
    });

    it('shows both guards the withdrawal leg from custody to SOURCE', async function () {
        const context = makeWithdrawCustodyContext({
            custodyGuard: true,
            tokenBinding: binding(DENY_CONTROLLER),
            addressBinding: binding(ALLOW_CONTROLLER),
            verdicts: {
                [DENY_CONTROLLER]: { allow: true, gasBilled: 1000 },
            },
        });

        const data = await withdraw(context);

        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(context.guardCalls.length, 2);
        for(const request of context.guardCalls){
            assert.strictEqual(request.actionType, 'WITHDRAW');
            assert.strictEqual(request.from, CONTRACT_ADDRESS);
            assert.strictEqual(request.to, SOURCE);
        }
    });

    it('burns the summed fee when both guards allow', async function () {
        const tokenGas = 2000;
        const addressGas = 500;
        const context = makeWithdrawCustodyContext({
            custodyGuard: true,
            tokenBinding: binding(DENY_CONTROLLER),
            addressBinding: binding(ALLOW_CONTROLLER),
            verdicts: {
                [DENY_CONTROLLER]: { allow: true, gasBilled: tokenGas },
                [ALLOW_CONTROLLER]: { allow: true, gasBilled: addressGas },
            },
        });

        const data = await withdraw(context);
        const expectedFee = context.indexer.util.bcadd(
            context.indexer.util.bcmul(tokenGas, context.indexer.config.GAS_PRICE, 8),
            context.indexer.util.bcmul(addressGas, context.indexer.config.GAS_PRICE, 8),
            8
        );
        const [credits, debits] = ledgerLegs(context);

        assert.strictEqual(data.STATUS, 'valid');
        assert.deepStrictEqual(credits, [[TICK, '10', SOURCE]]);
        assert.deepStrictEqual(debits, [
            [TICK, '10', CONTRACT_ADDRESS],
            [context.indexer.config.GAS, expectedFee, SOURCE],
        ]);
    });

    it('rejects a BTC owner without GAS before moving custody', async function () {
        const context = makeWithdrawCustodyContext({
            custodyGuard: true,
            tokenBinding: binding(ALLOW_CONTROLLER),
            balances: {
                [CONTRACT_ADDRESS]: { 1: '1000' },
                [SOURCE]: {},
            },
        });

        const data = await withdraw(context);

        assert.strictEqual(data.STATUS, 'invalid: insufficient funds (guard gas)');
        assert.deepStrictEqual(context.guardCalls, []);
        assertCustodyUntouched(context);
    });
});
