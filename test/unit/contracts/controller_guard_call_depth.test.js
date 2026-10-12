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
 * runControllerGuard: the call-depth gate at its exact edge.
 *
 * A guard runs one level below the action it guards, so it may run at
 * VM_MAX_CALL_DEPTH itself (where the VM then refuses its own emit.execute)
 * and is denied one level deeper, before any savepoint or VM work. Both
 * sides of that edge are pinned here so a `>` / `>=` drift fails a test.
 ********************************************************************/

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer } = require('../../fixtures/mocks');
const Execute = require('../../../src/actions/execute/index.js');
const PROTO   = require('../../../src/protocol/constants.js');

const ADDR = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

// Fake VM + DB around the real Execute, so the production limits apply.
function buildHandler() {
    const indexer = createMockIndexer();
    const db = indexer.indexerDb;
    db.getContract               = sinon.stub().resolves({ code: "module.exports={meta:{name:'Guard',description:'Controller guard fixture.',version:'1.0.0'},guard:function(){}};", status_id: 7 });
    db.getContractPermissions    = sinon.stub().resolves(null);
    db.getStatusString           = sinon.stub().resolves('valid');
    db.getContractState          = sinon.stub().resolves({});
    db.getOracleDataForVM        = sinon.stub().resolves({});
    db.getCrossChainDataForVM    = sinon.stub().resolves({});
    db.getPollResultsForVM       = sinon.stub().resolves({ polls: {} });
    db.getContractStakeDataForVM = sinon.stub().resolves({});
    db.buildVmBalancesAndTokenInfo = sinon.stub().resolves({ balances: {}, tokenInfo: {} });
    db.createSavepoint           = sinon.stub().resolves('sp');
    db.releaseSavepoint          = sinon.stub().resolves();
    db.rollbackToSavepoint       = sinon.stub().resolves();
    db.createContractState       = sinon.stub().resolves();
    db.createContractEmission    = sinon.stub().resolves();
    db.createContractExecution   = sinon.stub().resolves();
    db.doQuery                   = sinon.stub().resolves([{ cnt: 0 }]);
    db.countContractEmissionsForExecution =
        require('../../../src/db/contracts').countContractEmissionsForExecution.bind(db);
    indexer.vm    = { execute: sinon.stub().resolves({
        success: true, error: null, gasUsed: 100, returnValue: JSON.stringify({}),
        stateChanges: [], stateDeletes: [], emittedActions: [], logs: [] }) };
    indexer.hubDb = null;
    return { handler: new Execute(indexer), indexer };
}

const opts = (callDepth) => ({
    actionType: 'ORDER_CREATE', controllerIndex: 5, tick: 'TOK',
    from: ADDR, to: '', amount: '100', price: '100', proceedsTick: 'PAY',
    hostData: { ACTION_INDEX: 10, BLOCK_INDEX: 100, BLOCK_TIME: 1700000000,
                SOURCE: ADDR, TX_HASH: 'aa', TX_INDEX: 1, TX_VOUT: 0 },
    callDepth, seq: 0,
});

describe('runControllerGuard: call-depth gate edge @regression @tier1', function () {
    it('denies one level past the max call depth before any savepoint or VM run', async function () {
        const { handler, indexer } = buildHandler();
        const res = await handler.runControllerGuard(opts(PROTO.VM_MAX_CALL_DEPTH + 1));
        assert.deepStrictEqual(res, { allow: false, reason: 'controller (max call depth)', gasBilled: 0 });
        sinon.assert.notCalled(indexer.vm.execute);
        sinon.assert.notCalled(indexer.indexerDb.createSavepoint);
    });

    it('runs the guard at exactly the max call depth and hands the VM that depth', async function () {
        const { handler, indexer } = buildHandler();
        const res = await handler.runControllerGuard(opts(PROTO.VM_MAX_CALL_DEPTH));
        assert.strictEqual(res.allow, true);
        sinon.assert.calledOnce(indexer.vm.execute);
        assert.strictEqual(indexer.vm.execute.firstCall.args[0].callDepth, PROTO.VM_MAX_CALL_DEPTH);
    });
});
