'use strict';

// SPDX-License-Identifier: AGPL-3.0-or-later

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const {
    SOURCE, TICK, CONTRACT_ADDRESS, makeData,
} = require('../../actions/stake/withdraw.test/helpers/withdraw_context.js');
const {
    DENY_CONTROLLER, ALLOW_CONTROLLER, makeWithdrawCustodyContext,
} = require('../../actions/stake/withdraw.test/helpers/custody_guard_context.js');

function binding(contractIndex){
    return { actionClass: 'transfer', contract_index: contractIndex };
}

function withdrawOpts(data){
    return {
        actionType: 'WITHDRAW', tick: TICK, from: CONTRACT_ADDRESS, to: SOURCE,
        amount: '10', data, gasBalances: null,
    };
}

async function runCustodyGuard(context, data){
    return context.indexer.util.maybeRunCustodyGuard(
        context.actionsCtx,
        context.indexer.indexerDb,
        withdrawOpts(data)
    );
}

describe('Withdraw custody guard helper routing @regression @tier1', function () {
    afterEach(() => sinon.restore());

    it('sends the custody-to-SOURCE leg to the token and SOURCE transfer guards', async function () {
        const context = makeWithdrawCustodyContext({
            custodyGuard: true,
            tokenBinding: binding(ALLOW_CONTROLLER),
            addressBinding: binding(ALLOW_CONTROLLER),
        });
        const data = makeData();

        const result = await runCustodyGuard(context, data);

        assert.strictEqual(result.error, null);
        assert.strictEqual(context.guardCalls.length, 2);
        for(const request of context.guardCalls){
            assert.strictEqual(request.actionType, 'WITHDRAW');
            assert.strictEqual(request.from, CONTRACT_ADDRESS);
            assert.strictEqual(request.to, SOURCE);
        }
        assert.strictEqual(context.indexer.indexerDb.getAddressId.calledWithExactly(SOURCE), true);
        assert.strictEqual(
            context.indexer.indexerDb.getEffectiveAddressControllerForGuard.calledWithExactly(
                42, 'transfer', data.BLOCK_INDEX, data.ACTION_INDEX
            ),
            true
        );
    });

    it('loads SOURCE balances when the caller supplies null gas balances', async function () {
        const context = makeWithdrawCustodyContext({
            custodyGuard: true,
            tokenBinding: binding(ALLOW_CONTROLLER),
            addressBinding: binding(ALLOW_CONTROLLER),
        });
        const data = makeData();

        await runCustodyGuard(context, data);

        assert.strictEqual(
            context.indexer.indexerDb.getAddressBalances.calledOnceWithExactly(
                SOURCE, null, data.BLOCK_INDEX, data.ACTION_INDEX
            ),
            true
        );
    });
});

describe('Withdraw custody guard helper gas accounting @regression @tier1', function () {
    afterEach(() => sinon.restore());

    it('refuses a BTC owner without GAS before entering either guard', async function () {
        const context = makeWithdrawCustodyContext({
            custodyGuard: true,
            tokenBinding: binding(ALLOW_CONTROLLER),
            balances: { [SOURCE]: {} },
        });

        const result = await runCustodyGuard(context, makeData());

        assert.deepStrictEqual(result, {
            error: 'insufficient funds (guard gas)', guardFee: 0, payoutLegs: null,
        });
        assert.deepStrictEqual(context.guardCalls, []);
    });

    it('returns the sum of both allowed guards metered fees', async function () {
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

        const result = await runCustodyGuard(context, makeData());
        const util = context.indexer.util;
        const expected = util.bcadd(
            util.bcmul(tokenGas, context.indexer.config.GAS_PRICE, 8),
            util.bcmul(addressGas, context.indexer.config.GAS_PRICE, 8),
            8
        );

        assert.deepStrictEqual(context.guardCalls.map(call => call.controllerIndex), [
            DENY_CONTROLLER, ALLOW_CONTROLLER,
        ]);
        assert.strictEqual(result.error, null);
        assert.strictEqual(String(result.guardFee), String(expected));
        assert.strictEqual(result.payoutLegs, null);
    });
});
