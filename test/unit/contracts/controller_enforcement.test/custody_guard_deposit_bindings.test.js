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

function depositData(extra = {}) {
    return createBaseData({ ACTION: 'DEPOSIT', FORMAT: 0, SOURCE, ...extra });
}

async function runCustodyGuard(context, extraData = {}) {
    const data = depositData(extraData);
    const result = await context.indexer.util.maybeRunCustodyGuard(
        context.actionsCtx,
        context.indexer.indexerDb,
        {
            actionType: 'DEPOSIT',
            tick: 'TEST',
            from: SOURCE,
            to: CUSTODY,
            amount: '10',
            data,
        }
    );
    return { data, result };
}

describe('DEPOSIT custody guard bindings @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it("runs a token guard bound only to the 'all' class", async function () {
        const context = makeDepositCustodyContext({
            custodyGuard: true,
            tokenBinding: { actionClass: 'all', contract_index: ALLOW_CONTROLLER },
        });
        const { result } = await runCustodyGuard(context);

        assert.strictEqual(result.error, null);
        assert.strictEqual(context.guardCalls.length, 1);
        assert.strictEqual(context.guardCalls[0].controllerIndex, ALLOW_CONTROLLER);
        assert.strictEqual(context.indexer.util.bcgt(result.guardFee, 0), true);
    });

    it("runs a SOURCE address guard bound only to the 'all' class", async function () {
        const context = makeDepositCustodyContext({
            custodyGuard: true,
            addressBinding: { actionClass: 'all', contract_index: ALLOW_CONTROLLER },
        });
        const { result } = await runCustodyGuard(context);

        assert.strictEqual(result.error, null);
        assert.strictEqual(context.guardCalls.length, 1);
        assert.strictEqual(context.guardCalls[0].controllerIndex, ALLOW_CONTROLLER);
        assert.strictEqual(context.indexer.util.bcgt(result.guardFee, 0), true);
    });

    it('names the token when an inert probe reaches its binding', async function () {
        const context = makeDepositCustodyContext({
            custodyGuard: true,
            tokenBinding: { actionClass: 'all', contract_index: ALLOW_CONTROLLER },
        });
        const { result } = await runCustodyGuard(context, { GUARD_INERT: true });

        assert.strictEqual(context.indexer.util.isGuardInertError(result.error), true);
        assert.ok(result.error.includes('FEE_QUOTE_CONTROLLER_UNSUPPORTED'));
        assert.ok(result.error.includes('token TEST'));
        assert.strictEqual(result.guardFee, 0);
        assert.strictEqual(context.guardCalls.length, 0);
    });

    it("names the depositor's address when an inert probe reaches its binding", async function () {
        const context = makeDepositCustodyContext({
            custodyGuard: true,
            addressBinding: { actionClass: 'all', contract_index: ALLOW_CONTROLLER },
        });
        const { result } = await runCustodyGuard(context, { GUARD_INERT: true });

        assert.strictEqual(context.indexer.util.isGuardInertError(result.error), true);
        assert.ok(result.error.includes('FEE_QUOTE_CONTROLLER_UNSUPPORTED'));
        assert.ok(result.error.includes('address ' + SOURCE));
        assert.strictEqual(result.guardFee, 0);
        assert.strictEqual(context.guardCalls.length, 0);
    });

    it('returns a strict no-op for an unbound tick and unbound SOURCE', async function () {
        const context = makeDepositCustodyContext({ custodyGuard: true });
        const { result } = await runCustodyGuard(context);

        assert.strictEqual(result.error, null);
        assert.strictEqual(String(result.guardFee), '0');
        assert.strictEqual(result.payoutLegs, null);
        assert.strictEqual(context.guardCalls.length, 0);
        assert.strictEqual(context.indexer.indexerDb.getEffectiveTokenControllerForGuard.calledOnce, true);
        assert.strictEqual(context.indexer.indexerDb.getEffectiveAddressControllerForGuard.calledOnce, true);
    });
});
