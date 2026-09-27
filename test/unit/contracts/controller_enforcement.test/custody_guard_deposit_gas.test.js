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
const { createBaseData } = require('../../../fixtures/mocks');
const {
    SOURCE,
    CUSTODY,
    ALLOW_CONTROLLER,
    makeDepositCustodyContext,
} = require('../../actions/stake/deposit.test/helpers/custody_guard_fixture');

function depositData() {
    return createBaseData({ ACTION: 'DEPOSIT', FORMAT: 0, SOURCE });
}

function custodyOpts(context, overrides = {}) {
    return {
        actionType: 'DEPOSIT',
        tick: 'TEST',
        from: SOURCE,
        to: CUSTODY,
        amount: '10',
        data: depositData(),
        ...overrides,
    };
}

function maximumGuardFee(context) {
    const { config, util } = context.indexer;
    return util.bcmul(util.resolveGuardGasCeiling(config), config['GAS_PRICE'], 8);
}

async function runCustodyGuard(context, overrides) {
    return context.indexer.util.maybeRunCustodyGuard(
        context.actionsCtx,
        context.indexer.indexerDb,
        custodyOpts(context, overrides)
    );
}

describe('DEPOSIT custody guard gas reservation @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('refuses a BTC source with no GAS balance before running its token guard', async function () {
        const context = makeDepositCustodyContext({
            custodyGuard: true,
            balances: { [SOURCE]: { 1: '1000' } },
            tokenBinding: { actionClass: 'transfer', contract_index: ALLOW_CONTROLLER },
        });
        const result = await runCustodyGuard(context);

        assert.strictEqual(context.indexer.config['COIN'], 'BTC');
        assert.deepStrictEqual(result, {
            error: 'insufficient funds (guard gas)', guardFee: 0, payoutLegs: null,
        });
        assert.strictEqual(context.guardCalls.length, 0);
    });

    it('reserves guard gas from the amount-debited snapshot when TICK is GAS', async function () {
        const refused = makeDepositCustodyContext({
            custodyGuard: true,
            addressBinding: { actionClass: 'transfer', contract_index: ALLOW_CONTROLLER },
        });
        const gasTick = refused.indexer.config['GAS'];
        const gasInfo = await refused.indexer.indexerDb.getTokenInfo(gasTick);
        const maxFee = maximumGuardFee(refused);
        const justShy = refused.indexer.util.bcsub(maxFee, '0.00000001', 8);
        const refusedSource = refused.indexer.util.bcadd('10', justShy, 8);
        const refusedBalances = refused.indexer.util.debitBalances(
            { [gasInfo['TICK_ID']]: refusedSource }, gasInfo['TICK_ID'], '10'
        );
        const refusedResult = await runCustodyGuard(refused, {
            tick: gasTick,
            gasBalances: refusedBalances,
        });

        assert.deepStrictEqual(refusedResult, {
            error: 'insufficient funds (guard gas)', guardFee: 0, payoutLegs: null,
        });
        assert.strictEqual(refused.guardCalls.length, 0);

        const allowed = makeDepositCustodyContext({
            custodyGuard: true,
            addressBinding: { actionClass: 'transfer', contract_index: ALLOW_CONTROLLER },
        });
        const allowedSource = allowed.indexer.util.bcadd('10', maxFee, 8);
        const allowedBalances = allowed.indexer.util.debitBalances(
            { [gasInfo['TICK_ID']]: allowedSource }, gasInfo['TICK_ID'], '10'
        );
        const allowedResult = await runCustodyGuard(allowed, {
            tick: gasTick,
            gasBalances: allowedBalances,
        });

        assert.strictEqual(allowedResult.error, null);
        assert.strictEqual(allowed.indexer.util.bcstr(allowedResult.guardFee), '0.01');
        assert.strictEqual(allowed.guardCalls.length, 1);
    });

    it('refuses when the token fee leaves too little for the address guard ceiling', async function () {
        const context = makeDepositCustodyContext({
            custodyGuard: true,
            tokenBinding: { actionClass: 'transfer', contract_index: ALLOW_CONTROLLER },
            addressBinding: { actionClass: 'transfer', contract_index: ALLOW_CONTROLLER },
        });
        const gasInfo = await context.indexer.indexerDb.getTokenInfo(context.indexer.config['GAS']);
        const result = await runCustodyGuard(context, {
            gasBalances: { [gasInfo['TICK_ID']]: maximumGuardFee(context) },
        });

        assert.deepStrictEqual(result, {
            error: 'insufficient funds (guard gas)', guardFee: 0, payoutLegs: null,
        });
        assert.strictEqual(context.guardCalls.length, 1);
        assert.strictEqual(context.guardCalls[0].controllerIndex, ALLOW_CONTROLLER);
    });
});
