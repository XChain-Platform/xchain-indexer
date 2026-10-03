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
 **********************************************************************
 * test/unit/contracts/controller_enforcement.test/custody_routing.test.js
 *
 * Pins custody action routing, activation, guard ordering and cumulative gas
 * reservation before the deposit and withdrawal handlers adopt the helper.
 ********************************************************************/

const assert = require('assert');
const sinon = require('sinon');
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
const Utility = require('../../../../src/utility.js');

function useBtcCoin(){
    let priorCoin;

    before(function () {
        priorCoin = process.env.INDEXER_COIN;
        process.env.INDEXER_COIN = 'BTC';
    });

    after(function () {
        if(priorCoin === undefined) delete process.env.INDEXER_COIN;
        else process.env.INDEXER_COIN = priorCoin;
    });
}

const BASE = { BLOCK_INDEX: 100, ACTION_INDEX: 5, SOURCE: 'owner' };
const OPTS = {
    actionType: 'DEPOSIT', tick: 'AAA', from: 'owner', to: 'C:BTC:7', amount: '10'
};

function mkActions(custodyEnabled, guardResults, calls){
    return {
        protocolChanges: {
            isEnabled: async (name) => name === 'CONTROLLER_CUSTODY_GUARD' ? custodyEnabled : true
        },
        actionExecute: {
            runControllerGuard: async (opts) => {
                calls.push(opts);
                return guardResults.shift();
            }
        }
    };
}

function mkDb(overrides){
    return Object.assign({
        config: { GAS: 'XCHAIN', GAS_PRICE: '0.00001', GAS_SCHEDULE: { VM_GUARD_GAS_CEILING: 200000 } },
        getTokenInfo: async () => ({ TICK_ID: 1 }),
        getAddressBalances: async () => ({ 1: '10' }),
        getTickerId: async () => 2,
        getEffectiveTokenControllerForGuard: async () => ({ contract_index: 9 }),
        getAddressId: async () => 3,
        getEffectiveAddressControllerForGuard: async () => ({ contract_index: 12 })
    }, overrides || {});
}

function custodyOpts(extra){
    return Object.assign({}, OPTS, { data: Object.assign({}, BASE) }, extra || {});
}

describe('Programmable policy layer : custody guard routing @regression', function () {
    useBtcCoin();

    it('routes DEPOSIT and WITHDRAW to the transfer class', function () {
        const util = new Utility();
        assert.strictEqual(util.controllerActionClass('DEPOSIT'), 'transfer');
        assert.strictEqual(util.controllerActionClass('WITHDRAW'), 'transfer');
    });

    it('below activation performs no db read, sets no marker and calls neither guard', async function () {
        const util = new Utility();
        const tokenGuard = sinon.stub(util, 'maybeRunControllerGuard');
        const addressGuard = sinon.stub(util, 'maybeRunAddressControllerGuard');
        const data = Object.assign({}, BASE);
        const db = new Proxy({ config: { GAS: 'XCHAIN' } }, {
            get(target, key){
                if(key in target) return target[key];
                throw new Error('unexpected db read: ' + String(key));
            }
        });
        const result = await util.maybeRunCustodyGuard(mkActions(false, [], []), db,
            Object.assign({}, OPTS, { data }));

        assert.deepStrictEqual(result, { error: null, guardFee: 0, payoutLegs: null });
        assert.strictEqual(data['_CUSTODY_GUARD_ARMED'], undefined);
        assert.strictEqual(tokenGuard.called, false);
        assert.strictEqual(addressGuard.called, false);
    });

    it('passes the custody leg through the token guard and SOURCE transfer-address guard', async function () {
        const util = new Utility();
        const data = Object.assign({}, BASE);
        const suppliedBalances = { 1: '10' };
        const tokenGuard = sinon.stub(util, 'maybeRunControllerGuard').resolves({ error: null, guardFee: '0.5' });
        const addressGuard = sinon.stub(util, 'maybeRunAddressControllerGuard').resolves({ error: null, guardFee: '0.25' });
        const result = await util.maybeRunCustodyGuard(mkActions(true, [], []), mkDb(),
            Object.assign({}, OPTS, { data, gasBalances: suppliedBalances }));

        assert.strictEqual(data['_CUSTODY_GUARD_ARMED'], true);
        assert.deepStrictEqual(tokenGuard.firstCall.args[2], {
            actionType: 'DEPOSIT', tick: 'AAA', from: 'owner', to: 'C:BTC:7', amount: '10',
            data, gasInfo: { TICK_ID: 1 }, gasBalances: suppliedBalances, seq: 0
        });
        const { gasBalances: reservedBalances, ...addressOpts } = addressGuard.firstCall.args[2];
        assert.deepStrictEqual(addressOpts, {
            actionType: 'DEPOSIT', actionClass: 'transfer', address: 'owner', tick: 'AAA',
            from: 'owner', to: 'C:BTC:7', amount: '10', data, gasInfo: { TICK_ID: 1 },
            seq: 0
        });
        assert.notStrictEqual(reservedBalances, suppliedBalances);
        assert.strictEqual(String(reservedBalances[1]), '9.5');
        assert.deepStrictEqual(suppliedBalances, { 1: '10' });
        assert.strictEqual(result.error, null);
        assert.strictEqual(String(result.guardFee), '0.75');
        assert.strictEqual(result.payoutLegs, null);
    });
});

describe('Programmable policy layer : custody guard ordering @regression', function () {
    useBtcCoin();

    it('does not run the address guard after a token denial', async function () {
        const util = new Utility();
        sinon.stub(util, 'maybeRunControllerGuard').resolves({ error: 'token denied', guardFee: 0 });
        const addressGuard = sinon.stub(util, 'maybeRunAddressControllerGuard');
        const result = await util.maybeRunCustodyGuard(mkActions(true, [], []), mkDb(), custodyOpts());

        assert.deepStrictEqual(result, { error: 'token denied', guardFee: 0, payoutLegs: null });
        assert.strictEqual(addressGuard.called, false);
    });

    it('returns an address denial with no fee after the token guard allowed', async function () {
        const util = new Utility();
        sinon.stub(util, 'maybeRunControllerGuard').resolves({ error: null, guardFee: '0.5' });
        sinon.stub(util, 'maybeRunAddressControllerGuard').resolves({ error: 'address denied', guardFee: 0 });
        const result = await util.maybeRunCustodyGuard(mkActions(true, [], []), mkDb(), custodyOpts());

        assert.deepStrictEqual(result, { error: 'address denied', guardFee: 0, payoutLegs: null });
    });

    it('reserves the address ceiling after the token fee', async function () {
        const util = new Utility();
        const calls = [];
        const actions = mkActions(true, [
            { allow: true, reason: null, gasBilled: 100000 },
            { allow: true, reason: null, gasBilled: 0 }
        ], calls);
        const result = await util.maybeRunCustodyGuard(actions, mkDb(),
            custodyOpts({ gasBalances: { 1: '2.5' } }));

        assert.deepStrictEqual(result, {
            error: 'insufficient funds (guard gas)', guardFee: 0, payoutLegs: null
        });
        assert.strictEqual(calls.length, 1);
    });
});
