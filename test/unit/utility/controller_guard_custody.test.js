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
 * test/unit/utility/controller_guard_custody.test.js
 ********************************************************************/

const assert = require('assert');
const sinon = require('sinon');

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const Utility = require('../../../src/utility.js');

const NO_GUARD = { error: null, guardFee: 0, payoutLegs: null };

function makeActions(enabled){
    return {
        protocolChanges: { isEnabled: sinon.stub().resolves(enabled) },
        actionExecute: { runControllerGuard: sinon.stub() }
    };
}

function makeDb(){
    return {
        config: {
            GAS: 'XCHAIN', GAS_PRICE: '0.00001',
            GAS_SCHEDULE: { VM_GUARD_GAS_CEILING: 200000 }
        },
        getTokenInfo: sinon.stub().resolves({ TICK_ID: 99 }),
        getAddressBalances: sinon.stub().resolves({ 99: '100' }),
        getTickerId: sinon.stub().resolves(1),
        getEffectiveTokenControllerForGuard: sinon.stub().resolves(null),
        getAddressId: sinon.stub().resolves(2),
        getEffectiveAddressControllerForGuard: sinon.stub().resolves(null)
    };
}

function makeOpts(extra){
    return Object.assign({
        actionType: 'DEPOSIT', tick: 'AAA', from: 'owner', to: 'vault', amount: '10',
        data: { BLOCK_INDEX: 100, ACTION_INDEX: 5, SOURCE: 'owner' },
        gasBalances: { 99: '100' }
    }, extra || {});
}

function dbStubs(db){
    return [
        db.getTokenInfo, db.getAddressBalances, db.getTickerId,
        db.getEffectiveTokenControllerForGuard, db.getAddressId,
        db.getEffectiveAddressControllerForGuard
    ];
}

function assertNoGuardValue(result){
    assert.strictEqual(result.error, null);
    assert.strictEqual(result.guardFee.toString(), '0');
    assert.strictEqual(result.payoutLegs, null);
}

function registerGuardActivationTests(getUtil){
    it('returns without any guard work when custody guards are disabled', async function () {
        const actions = makeActions(false);
        const db = makeDb();
        const opts = makeOpts();

        const result = await getUtil().maybeRunCustodyGuard(actions, db, opts);

        assert.deepStrictEqual(result, NO_GUARD);
        sinon.assert.calledOnceWithExactly(actions.protocolChanges.isEnabled,
            'CONTROLLER_CUSTODY_GUARD', 100);
        sinon.assert.notCalled(actions.actionExecute.runControllerGuard);
        dbStubs(db).forEach((stub) => sinon.assert.notCalled(stub));
        assert.strictEqual(opts.data['_CUSTODY_GUARD_ARMED'], undefined);
    });

    it('arms custody enforcement and returns when neither controller is bound', async function () {
        const actions = makeActions(true);
        const db = makeDb();
        const opts = makeOpts();

        const result = await getUtil().maybeRunCustodyGuard(actions, db, opts);

        assertNoGuardValue(result);
        assert.strictEqual(opts.data['_CUSTODY_GUARD_ARMED'], true);
        sinon.assert.calledOnce(db.getEffectiveTokenControllerForGuard);
        sinon.assert.calledOnce(db.getEffectiveAddressControllerForGuard);
        sinon.assert.notCalled(actions.actionExecute.runControllerGuard);
    });
}

function registerGuardDenialTests(getUtil){
    it('returns a token denial without looking up an address controller', async function () {
        const actions = makeActions(true);
        const db = makeDb();
        db.getEffectiveTokenControllerForGuard.resolves({ contract_index: 7 });
        actions.actionExecute.runControllerGuard.resolves({ allow: false, reason: 'denied' });

        const result = await getUtil().maybeRunCustodyGuard(actions, db, makeOpts());

        assert.deepStrictEqual(result, { error: 'denied', guardFee: 0, payoutLegs: null });
        sinon.assert.calledOnce(actions.actionExecute.runControllerGuard);
        sinon.assert.notCalled(db.getAddressId);
        sinon.assert.notCalled(db.getEffectiveAddressControllerForGuard);
    });

    it('returns an address denial with no guard fee after a token allow', async function () {
        const actions = makeActions(true);
        const db = makeDb();
        db.getEffectiveTokenControllerForGuard.resolves({ contract_index: 7 });
        db.getEffectiveAddressControllerForGuard.resolves({ contract_index: 8 });
        actions.actionExecute.runControllerGuard.onFirstCall()
            .resolves({ allow: true, gasBilled: 1000 });
        actions.actionExecute.runControllerGuard.onSecondCall()
            .resolves({ allow: false, reason: 'address denied' });

        const result = await getUtil().maybeRunCustodyGuard(actions, db, makeOpts());

        assert.deepStrictEqual(result,
            { error: 'address denied', guardFee: 0, payoutLegs: null });
        sinon.assert.calledTwice(actions.actionExecute.runControllerGuard);
    });
}

function registerGuardBillingTests(getUtil){
    it('sums both allowed guards at the configured gas price', async function () {
        const actions = makeActions(true);
        const db = makeDb();
        db.getEffectiveTokenControllerForGuard.resolves({ contract_index: 7 });
        db.getEffectiveAddressControllerForGuard.resolves({ contract_index: 8 });
        actions.actionExecute.runControllerGuard.onFirstCall()
            .resolves({ allow: true, gasBilled: 1000 });
        actions.actionExecute.runControllerGuard.onSecondCall()
            .resolves({ allow: true, gasBilled: 2000 });

        const result = await getUtil().maybeRunCustodyGuard(actions, db, makeOpts());

        assert.strictEqual(result.error, null);
        assert.strictEqual(result.guardFee.toString(), '0.03');
        assert.strictEqual(result.payoutLegs, null);
        sinon.assert.calledTwice(actions.actionExecute.runControllerGuard);
    });

    it('loads SOURCE balances when gasBalances is null', async function () {
        const actions = makeActions(true);
        const db = makeDb();

        const result = await getUtil().maybeRunCustodyGuard(actions, db,
            makeOpts({ gasBalances: null }));

        assertNoGuardValue(result);
        sinon.assert.calledOnceWithExactly(db.getAddressBalances, 'owner', null, 100, 5);
    });
}

function registerGuardContextTests(getUtil){
    it('uses supplied gasBalances without loading SOURCE balances', async function () {
        const actions = makeActions(true);
        const db = makeDb();

        const result = await getUtil().maybeRunCustodyGuard(actions, db,
            makeOpts({ gasBalances: { 99: '25' } }));

        assertNoGuardValue(result);
        sinon.assert.notCalled(db.getAddressBalances);
    });

    it('runs the guard one call level below the host action', async function () {
        const actions = makeActions(true);
        const db = makeDb();
        db.getEffectiveTokenControllerForGuard.resolves({ contract_index: 7 });
        actions.actionExecute.runControllerGuard.resolves({ allow: false, reason: 'denied' });
        const opts = makeOpts();
        opts.data.CALL_DEPTH = 3;

        await getUtil().maybeRunCustodyGuard(actions, db, opts);

        sinon.assert.calledOnce(actions.actionExecute.runControllerGuard);
        assert.strictEqual(actions.actionExecute.runControllerGuard.firstCall.args[0].callDepth, 4);
    });
}

describe('Utility maybeRunCustodyGuard() @regression @tier1', function () {
    let util;

    beforeEach(function () {
        util = new Utility();
    });

    const getUtil = () => util;
    registerGuardActivationTests(getUtil);
    registerGuardDenialTests(getUtil);
    registerGuardBillingTests(getUtil);
    registerGuardContextTests(getUtil);
});
