'use strict';

// SPDX-License-Identifier: AGPL-3.0-or-later

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const {
    SOURCE, CONTRACT_INDEX, TICK, CONTRACT_ADDRESS, makeData,
} = require('./helpers/withdraw_context.js');
const {
    DENY_CONTROLLER, makeWithdrawCustodyContext,
} = require('./helpers/custody_guard_context.js');

function denyBinding(actionClass){
    return { actionClass, contract_index: DENY_CONTROLLER };
}

async function runWithdrawal(opts){
    const context = makeWithdrawCustodyContext(opts);
    const data = makeData({ FORMAT: 0 });
    await context.handler.parse(['0', CONTRACT_INDEX, TICK, '10'], data, null);
    return { context, data };
}

function assertBypass(context, data){
    assert.strictEqual(data.STATUS, 'valid');
    assert.strictEqual(context.ledgerSpy.callCount, 1);
    const [, , credits, debits] = context.ledgerSpy.firstCall.args;
    assert.deepStrictEqual(debits, [[TICK, '10', CONTRACT_ADDRESS]]);
    assert.deepStrictEqual(credits, [[TICK, '10', SOURCE]]);
    assert.deepStrictEqual(context.guardCalls, []);
    assert.strictEqual(
        context.indexer.indexerDb.getTokenInfo.calledWith(context.indexer.config['GAS']),
        false
    );
}

describe('Withdraw custody guard pre-activation bypass @regression @tier1', function () {
    afterEach(() => sinon.restore());

    it('settles a token-bound transfer without running its deny guard', async function () {
        const { context, data } = await runWithdrawal({
            custodyGuard: false,
            tokenBinding: denyBinding('transfer'),
        });
        assertBypass(context, data);
    });

    it('settles an owner address-bound transfer without running its deny guard', async function () {
        const { context, data } = await runWithdrawal({
            custodyGuard: false,
            addressBinding: denyBinding('transfer'),
        });
        assertBypass(context, data);
    });

    it('settles with token and owner address catch-all bindings', async function () {
        const { context, data } = await runWithdrawal({
            custodyGuard: false,
            tokenBinding: denyBinding('all'),
            addressBinding: denyBinding('all'),
        });
        assertBypass(context, data);
    });

    it('runs the owner address deny guard when the controller guard is enabled', async function () {
        const context = makeWithdrawCustodyContext({ addressBinding: denyBinding('transfer') });
        const data = makeData({ FORMAT: 0 });
        const gasInfo = await context.indexer.indexerDb.getTokenInfo(context.indexer.config['GAS']);
        const gasBalances = await context.indexer.indexerDb.getAddressBalances(SOURCE);
        const result = await context.indexer.util.maybeRunAddressControllerGuard(
            context.actionsCtx,
            context.indexer.indexerDb,
            {
                actionClass: 'transfer', address: SOURCE, actionType: 'SEND', tick: TICK,
                from: CONTRACT_ADDRESS, to: SOURCE, amount: '10', data, gasInfo, gasBalances,
            }
        );

        assert.strictEqual(result.error, 'policy denied');
        assert.strictEqual(context.guardCalls.length, 1);
    });
});
