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
    makeDepositCustodyContext,
} = require('./helpers/custody_guard_fixture');

function depositData() {
    return createBaseData({ ACTION: 'DEPOSIT', FORMAT: 0, SOURCE });
}

function normalizedLegs(legs) {
    return legs.map(([tick, amount, address]) => [tick, String(amount), address]);
}

function assertSettledBypass(context, data) {
    assert.strictEqual(data['STATUS'], 'valid');
    assert.strictEqual(context.ledgerSpy.callCount, 1);
    const [, , credits, debits] = context.ledgerSpy.firstCall.args;
    assert.deepStrictEqual(normalizedLegs(debits), [['TEST', '10', SOURCE]]);
    assert.deepStrictEqual(normalizedLegs(credits), [['TEST', '10', CUSTODY]]);
    assert.deepStrictEqual(context.guardCalls, []);
    const gasTick = context.indexer.config['GAS'];
    assert.strictEqual(context.indexer.indexerDb.getTokenInfo.getCalls()
        .some((call) => call.args[0] === gasTick), false);
}

async function runBypass(bindingOptions) {
    const context = makeDepositCustodyContext({ custodyGuard: false, ...bindingOptions });
    const data = depositData();
    await context.handler.parse(['0', CONTRACT_INDEX, 'TEST', '10'], data, null);
    assertSettledBypass(context, data);
}

describe('DEPOSIT custody guard pre-activation bypass @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('settles past a denying transfer controller bound to the token', async function () {
        await runBypass({
            tokenBinding: { actionClass: 'transfer', contract_index: DENY_CONTROLLER },
        });
    });

    it('settles past a denying transfer controller bound to SOURCE', async function () {
        await runBypass({
            addressBinding: { actionClass: 'transfer', contract_index: DENY_CONTROLLER },
        });
    });

    it('settles past denying catch-all bindings on the token and SOURCE', async function () {
        await runBypass({
            tokenBinding: { actionClass: 'all', contract_index: DENY_CONTROLLER },
            addressBinding: { actionClass: 'all', contract_index: DENY_CONTROLLER },
        });
    });

    it('runs the denying token guard through the shared guard utility', async function () {
        const context = makeDepositCustodyContext({
            tokenBinding: { actionClass: 'transfer', contract_index: DENY_CONTROLLER },
        });
        const data = depositData();
        const gasInfo = { TICK: context.indexer.config['GAS'], TICK_ID: 2, DECIMALS: 8 };
        const result = await context.indexer.util.maybeRunControllerGuard(
            context.actionsCtx,
            context.indexer.indexerDb,
            {
                actionType: 'SEND',
                tick: 'TEST',
                from: SOURCE,
                to: CUSTODY,
                amount: '10',
                data,
                gasInfo,
                gasBalances: { 2: '100' },
            }
        );
        assert.strictEqual(result.error, 'policy denied');
        assert.strictEqual(context.guardCalls.length, 1);
        assert.strictEqual(context.guardCalls[0].controllerIndex, DENY_CONTROLLER);
    });
});
