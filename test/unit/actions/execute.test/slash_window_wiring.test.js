// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Both VM stake-snapshot loaders decide STAKE_SNAPSHOT_SLASH_WINDOW through
// ProtocolChanges.isEnabled at the host block and hand the verdict to
// getContractStakeDataForVM, which no longer reads a block time of its own.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const Execute = require('../../../../src/actions/execute/index.js');
const { CONTRACT, SOURCE, makeVm, executeData, buildExecute } = require('./helpers/fixture.js');

// Answer every other flag the way the shared mock does, and the slash window as asked.
function stubSlashWindow(protocolChanges, active) {
    protocolChanges.isEnabled = sinon.stub().callsFake(async (name) =>
        (name === 'STAKE_SNAPSHOT_SLASH_WINDOW' ? active : true));
    return protocolChanges.isEnabled;
}

const guardVmResult = {
    success: true, error: null, gasUsed: 100, returnValue: JSON.stringify({}),
    stateChanges: [], stateDeletes: [], emittedActions: [], logs: [],
};

const guardOpts = () => ({
    actionType: 'SEND', controllerIndex: CONTRACT, tick: 'TOK',
    from: SOURCE, to: '', amount: '100', price: '100', proceedsTick: 'PAY',
    hostData: { ACTION_INDEX: 10, BLOCK_INDEX: 321, BLOCK_TIME: 1700000000,
                SOURCE, TX_HASH: 'aa', TX_INDEX: 1, TX_VOUT: 0 },
    callDepth: 0, seq: 0,
});

afterEach(function () { sinon.restore(); });

describe('STAKE_SNAPSHOT_SLASH_WINDOW reaches the VM stake snapshot through isEnabled @regression @tier1', function () {
    for (const active of [true, false]) {
        it('EXECUTE passes the isEnabled verdict (' + active + ') at the block being processed', async function () {
            const { indexer, actionsCtx } = buildExecute();
            const isEnabled = stubSlashWindow(actionsCtx.protocolChanges, active);
            actionsCtx.vm = makeVm();
            const handler = new Execute(actionsCtx);

            await handler.parse(['0', String(CONTRACT), 'transfer', 'recipient', '50'], executeData({ BLOCK_INDEX: 100 }), null);

            assert.ok(isEnabled.calledWith('STAKE_SNAPSHOT_SLASH_WINDOW', 100));
            const snap = indexer.indexerDb.getContractStakeDataForVM;
            assert.ok(snap.calledOnce);
            assert.strictEqual(snap.firstCall.args[1], 100);
            assert.strictEqual(snap.firstCall.args[2], active);
        });

        it('the controller guard passes the isEnabled verdict (' + active + ') at the host block', async function () {
            const { indexer, actionsCtx } = buildExecute();
            const isEnabled = stubSlashWindow(actionsCtx.protocolChanges, active);
            const db = indexer.indexerDb;
            db.getContract = sinon.stub().resolves({ code: "module.exports={meta:{name:'Guard',description:'Controller guard fixture.',version:'1.0.0'},guard:function(){}};", status_id: 7 });
            db.buildVmBalancesAndTokenInfo = sinon.stub().resolves({ balances: {}, tokenInfo: {} });
            db.doQuery = sinon.stub().resolves([{ cnt: 0 }]);
            db.countContractEmissionsForExecution =
                require('../../../../src/db/contracts').countContractEmissionsForExecution.bind(db);
            actionsCtx.vm = { execute: sinon.stub().resolves(guardVmResult) };
            actionsCtx.hubDb = null;
            const handler = new Execute(actionsCtx);

            const res = await handler.runControllerGuard(guardOpts());

            assert.strictEqual(res.allow, true, 'the guard ran to its verdict');
            assert.ok(isEnabled.calledWith('STAKE_SNAPSHOT_SLASH_WINDOW', 321));
            const snap = db.getContractStakeDataForVM;
            assert.ok(snap.calledOnce);
            assert.strictEqual(snap.firstCall.args[1], 321);
            assert.strictEqual(snap.firstCall.args[2], active);
        });
    }
});
