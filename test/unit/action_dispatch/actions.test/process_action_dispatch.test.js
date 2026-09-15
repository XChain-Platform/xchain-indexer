/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Actions.processAction(): resetLists before every dispatch, one handler per action
 * name, and params, data and error passed through untouched. Part of the suite whose
 * entry is test/unit/actions.test.js; handler parse() methods are stubbed.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert  = require('assert');
const sinon   = require('sinon');

// The stubbed-Actions builder shared with the suite entry.
const { shutdownPendingVms, buildActions } = require('./helpers/build_actions.js');

let actions;
let stubs;
let util;

async function call(action, params = [], data = {}, error = false) {
    return actions.processAction(action, params, data, error);
}

// ---------------------------------------------------------------------------
// describe: processAction : handler dispatch + resetLists
// ---------------------------------------------------------------------------
describe('Actions.processAction() @regression @tier3', function () {
    beforeEach(function () {
        const built = buildActions();
        actions = built.actions;
        stubs   = built.stubs;
        util    = built.indexer.util;
        sinon.spy(util, 'resetLists');
    });

    afterEach(async function () {
        sinon.restore();
        await shutdownPendingVms();
    });

    it('calls util.resetLists() before dispatching', async function () {
        await call('SEND');
        assert.ok(util.resetLists.calledOnce, 'resetLists should be called once');
    });

    it('calls resetLists even when action is UNKNOWN', async function () {
        await call('UNKNOWN');
        assert.ok(util.resetLists.calledOnce);
    });

    it('dispatches ADDRESS to actionAddress.parse', async function () {
        await call('ADDRESS');
        assert.ok(stubs.actionAddress.calledOnce);
    });

    it('dispatches AIRDROP to actionAirdrop.parse', async function () {
        await call('AIRDROP');
        assert.ok(stubs.actionAirdrop.calledOnce);
    });

    it('dispatches BATCH to actionBatch.parse', async function () {
        await call('BATCH');
        assert.ok(stubs.actionBatch.calledOnce);
    });

    it('dispatches BROADCAST to actionBroadcast.parse', async function () {
        await call('BROADCAST');
        assert.ok(stubs.actionBroadcast.calledOnce);
    });

    it('dispatches CALLBACK to actionCallback.parse', async function () {
        await call('CALLBACK');
        assert.ok(stubs.actionCallback.calledOnce);
    });

    it('dispatches DESTROY to actionDestroy.parse', async function () {
        await call('DESTROY');
        assert.ok(stubs.actionDestroy.calledOnce);
    });

    it('dispatches DISPENSER to actionDispenser.parse', async function () {
        await call('DISPENSER');
        assert.ok(stubs.actionDispenser.calledOnce);
    });
});

describe('Actions.processAction() @regression @tier3', function () {
    beforeEach(function () {
        const built = buildActions();
        actions = built.actions;
        stubs   = built.stubs;
        util    = built.indexer.util;
        sinon.spy(util, 'resetLists');
    });

    afterEach(async function () {
        sinon.restore();
        await shutdownPendingVms();
    });

    it('dispatches DISPENSER_CLOSE to actionDispenserClose.parse', async function () {
        await call('DISPENSER_CLOSE');
        assert.ok(stubs.actionDispenserClose.calledOnce);
    });

    it('dispatches DISPENSER_EXPIRE to actionDispenserExpire.parse', async function () {
        await call('DISPENSER_EXPIRE');
        assert.ok(stubs.actionDispenserExpire.calledOnce);
    });

    it('dispatches DISPENSE to actionDispense.parse', async function () {
        await call('DISPENSE');
        assert.ok(stubs.actionDispense.calledOnce);
    });

    it('dispatches DIVIDEND to actionDividend.parse', async function () {
        await call('DIVIDEND');
        assert.ok(stubs.actionDividend.calledOnce);
    });

    it('dispatches FILE to actionFile.parse', async function () {
        await call('FILE');
        assert.ok(stubs.actionFile.calledOnce);
    });

    it('dispatches ISSUE to actionIssue.parse', async function () {
        await call('ISSUE');
        assert.ok(stubs.actionIssue.calledOnce);
    });

    it('dispatches LIST to actionList.parse', async function () {
        await call('LIST');
        assert.ok(stubs.actionList.calledOnce);
    });

    it('dispatches LINK to actionLink.parse', async function () {
        await call('LINK');
        assert.ok(stubs.actionLink.calledOnce);
    });

    it('dispatches MINT to actionMint.parse', async function () {
        await call('MINT');
        assert.ok(stubs.actionMint.calledOnce);
    });
});

describe('Actions.processAction() @regression @tier3', function () {
    beforeEach(function () {
        const built = buildActions();
        actions = built.actions;
        stubs   = built.stubs;
        util    = built.indexer.util;
        sinon.spy(util, 'resetLists');
    });

    afterEach(async function () {
        sinon.restore();
        await shutdownPendingVms();
    });

    it('dispatches MESSAGE to actionMessage.parse', async function () {
        await call('MESSAGE');
        assert.ok(stubs.actionMessage.calledOnce);
    });

    it('dispatches ORDER to actionOrder.parse', async function () {
        await call('ORDER');
        assert.ok(stubs.actionOrder.calledOnce);
    });

    it('dispatches ORDER_EXPIRE to actionOrderExpire.parse', async function () {
        await call('ORDER_EXPIRE');
        assert.ok(stubs.actionOrderExpire.calledOnce);
    });

    it('dispatches ORDER_MATCH to actionOrderMatch.parse', async function () {
        await call('ORDER_MATCH');
        assert.ok(stubs.actionOrderMatch.calledOnce);
    });

    it('dispatches SLEEP to actionSleep.parse', async function () {
        await call('SLEEP');
        assert.ok(stubs.actionSleep.calledOnce);
    });

    it('dispatches SEND to actionSend.parse', async function () {
        await call('SEND');
        assert.ok(stubs.actionSend.calledOnce);
    });

    it('dispatches SWAP to actionSwap.parse', async function () {
        await call('SWAP');
        assert.ok(stubs.actionSwap.calledOnce);
    });

    it('dispatches SWAP_EXPIRE to actionSwapExpire.parse', async function () {
        await call('SWAP_EXPIRE');
        assert.ok(stubs.actionSwapExpire.calledOnce);
    });

    it('dispatches SWAP_MATCH to actionSwapMatch.parse', async function () {
        await call('SWAP_MATCH');
        assert.ok(stubs.actionSwapMatch.calledOnce);
    });
});

describe('Actions.processAction() @regression @tier3', function () {
    beforeEach(function () {
        const built = buildActions();
        actions = built.actions;
        stubs   = built.stubs;
        util    = built.indexer.util;
        sinon.spy(util, 'resetLists');
    });

    afterEach(async function () {
        sinon.restore();
        await shutdownPendingVms();
    });

    it('dispatches SWEEP to actionSweep.parse', async function () {
        await call('SWEEP');
        assert.ok(stubs.actionSweep.calledOnce);
    });

    it('dispatches UNKNOWN to actionUnknown.parse', async function () {
        await call('UNKNOWN');
        assert.ok(stubs.actionUnknown.calledOnce);
    });

    it('dispatches COLLECT to actionCollect.parse', async function () {
        await call('COLLECT');
        assert.ok(stubs.actionCollect.calledOnce);
    });

    it('dispatches PRICE to actionPrice.parse', async function () {
        await call('PRICE');
        assert.ok(stubs.actionPrice.calledOnce);
    });

    it('dispatches ATTEST to actionAttest.parse', async function () {
        await call('ATTEST');
        assert.ok(stubs.actionAttest.calledOnce);
    });

    it('does not call any other handler when dispatching SEND', async function () {
        await call('SEND');
        const others = Object.entries(stubs)
            .filter(([k]) => k !== 'actionSend')
            .filter(([, s]) => s.called);
        assert.strictEqual(others.length, 0, `unexpected handlers called: ${others.map(([k]) => k).join(', ')}`);
    });

    it('passes params, data, and error through to the handler', async function () {
        const params = ['TEST', '100', 'addr'];
        const data   = { ACTION: 'SEND', FORMAT: 0 };
        const error  = 'some error';
        await call('SEND', params, data, error);
        const call0 = stubs.actionSend.firstCall;
        assert.deepStrictEqual(call0.args[0], params);
        assert.strictEqual(call0.args[1], data);
        assert.strictEqual(call0.args[2], error);
    });
});
