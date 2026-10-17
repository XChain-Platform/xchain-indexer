/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * CONSENSUS REGRESSION GUARD: the controller-guard stake snapshot decimal gate.
 *
 * GUARD_STAKE_SNAPSHOT_DECIMAL_STRINGS is decided on the host block and passed
 * to getContractStakeDataForVM as its fourth argument.
 ********************************************************************/

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer } = require('../../fixtures/mocks');
const Execute = require('../../../src/actions/execute/index.js');

const ADDR = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

function build(flags) {
    const indexer = createMockIndexer();
    indexer.protocolChanges = {
        isDefined: sinon.stub().returns(true),
        isEnabled: sinon.stub().callsFake(async (name) => !!flags[name]),
    };
    const db = indexer.indexerDb;
    db.getContract               = sinon.stub().resolves({ code: 'module.exports={guard:function(){}};', status_id: 7 });
    db.getContractPermissions    = sinon.stub().resolves(null);
    db.getStatusString           = sinon.stub().resolves('valid');
    db.getContractState          = sinon.stub().resolves({});
    db.getOracleDataForVM        = sinon.stub().resolves({});
    db.getCrossChainDataForVM    = sinon.stub().resolves({});
    db.getPollResultsForVM       = sinon.stub().resolves({ polls: {} });
    db.getContractStakeDataForVM = sinon.stub().resolves({});
    db.buildVmBalancesAndTokenInfo = sinon.stub().resolves({ balances: {}, tokenInfo: {} });
    db.createSavepoint           = sinon.stub().resolves();
    db.releaseSavepoint          = sinon.stub().resolves();
    db.rollbackToSavepoint       = sinon.stub().resolves();
    db.createContractState       = sinon.stub().resolves();
    db.createContractExecution   = sinon.stub().resolves();
    db.createContractEmission    = sinon.stub().resolves();
    db.doQuery                   = sinon.stub().resolves([{ cnt: 0 }]);
    db.countContractEmissionsForExecution =
        require('../../../src/db/contracts').countContractEmissionsForExecution.bind(db);
    db.currentTxEpoch = sinon.stub().returns(1);
    indexer.vm = { execute: sinon.stub().resolves({
        success: true, error: null, gasUsed: 10, returnValue: JSON.stringify({}),
        stateChanges: [], stateDeletes: [], emittedActions: [], logs: [],
    }) };
    indexer.hubDb = null;
    const handler = new Execute(indexer);
    handler.processEmission = sinon.stub().resolves();
    return { handler, db, indexer };
}

const opts = {
    actionType: 'SEND', controllerIndex: 5, tick: 'TOK',
    from: ADDR, to: ADDR, amount: '100', price: '', proceedsTick: '',
    hostData: { ACTION_INDEX: 10, BLOCK_INDEX: 100, BLOCK_TIME: 1700000000,
        SOURCE: ADDR, TX_HASH: 'aa', TX_INDEX: 1, TX_VOUT: 0 },
    callDepth: 0, seq: 0,
};

async function load(flags) {
    const { handler, db } = build(flags);
    await handler.runControllerGuard(opts);
    return db.getContractStakeDataForVM.firstCall.args;
}
describe('controller guard stake snapshot decimal gate @regression @tier1', function () {
    it('passes false while GUARD_STAKE_SNAPSHOT_DECIMAL_STRINGS is off', async function () {
        const args = await load({});
        assert.deepStrictEqual(args.slice(0, 2), [5, 100]);
        assert.strictEqual(args[3], false);
    });

    it('passes true once GUARD_STAKE_SNAPSHOT_DECIMAL_STRINGS is on', async function () {
        assert.strictEqual((await load({ GUARD_STAKE_SNAPSHOT_DECIMAL_STRINGS: true }))[3], true);
    });

    it('does not follow the primary-path STAKE_SNAPSHOT_DECIMAL_STRINGS flag', async function () {
        assert.strictEqual((await load({ STAKE_SNAPSHOT_DECIMAL_STRINGS: true }))[3], false);
    });

    it('keeps the slash-window flag independent', async function () {
        const args = await load({ STAKE_SNAPSHOT_SLASH_WINDOW: true });
        assert.strictEqual(args[2], true);
        assert.strictEqual(args[3], false);
    });

    it('asks the registry about the host block', async function () {
        const { handler, indexer } = build({});
        await handler.runControllerGuard(opts);
        assert.ok(indexer.protocolChanges.isEnabled.calledWith('GUARD_STAKE_SNAPSHOT_DECIMAL_STRINGS', 100));
    });
});
