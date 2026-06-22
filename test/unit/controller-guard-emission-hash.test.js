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
 * CONSENSUS REGRESSION GUARD: controller-guard emissions must enter contract_hash.
 *
 * A controller guard's emitted actions (royalty/fee splits, etc.) write contract_emissions
 * keyed (execution_index) to the NATIVE action's action_index (a guard has no action_index
 * of its own). The block contract_hash preimage pulls emissions via
 *   INNER JOIN contract_executions ce ON (ce.action_index = em.execution_index)
 * so a guard that writes NO parent contract_executions row drops every one of its emissions
 * from contract_hash: two nodes that diverge on guard emissions still hash identically,
 * creating a silent consensus fork. runControllerGuard must therefore write the parent execution row.
 *
 * A single native action can run MULTIPLE guards on the same action_index (a multi-leg
 * SEND/DESTROY; or one SEND firing both the token-controller and the destination
 * address-controller). They share one execution row (action_index is UNIQUE), and their
 * emissions share execution_index; position is offset by the count of emissions already
 * recorded for the action, keeping (execution_index, position) globally unique. That preserves
 * a TOTAL order under the preimage's ORDER BY (execution_index, position) with no read-side
 * query change (same property the credits/debits tie-order fix ffd061a relies on).
 *
 * Pure: fakes the VM + DB + processEmission, so it runs on any Node version.
 ********************************************************************/

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer } = require('../fixtures/mocks');
const Execute = require('../../src/actions/execute.js');

describe('runControllerGuard: guard emissions enter contract_hash @regression @tier1', function () {

    const ADDR = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

    // priorEmissionCount = what `SELECT COUNT(*) FROM contract_emissions WHERE execution_index=?`
    // returns for this action (emissions an EARLIER guard on the same action already wrote).
    function buildHandler(emittedActions, priorEmissionCount = 0) {
        const indexer = createMockIndexer();
        const db = indexer.indexerDb;
        db.getContract               = sinon.stub().resolves({ code: 'module.exports={guard:function(){}};', status_id: 7 });
        db.getContractPermissions    = sinon.stub().resolves(null);
        db.getStatusString           = sinon.stub().resolves('valid');
        db.getContractState          = sinon.stub().resolves({});
        db.getOracleDataForVM        = sinon.stub().resolves({});
        db.getCrossChainDataForVM    = sinon.stub().resolves({});
        db.getContractStakeDataForVM = sinon.stub().resolves({});
        db.buildVmBalancesAndTokenInfo = sinon.stub().resolves({ balances: {}, tokenInfo: {} });
        db.createSavepoint           = sinon.stub().resolves('sp');
        db.releaseSavepoint          = sinon.stub().resolves();
        db.rollbackToSavepoint       = sinon.stub().resolves();
        db.createContractState       = sinon.stub().resolves();
        db.createContractExecution   = sinon.stub().resolves();
        db.createContractEmission    = sinon.stub().resolves();
        // The per-action emission counter that backs the position offset.
        db.doQuery                   = sinon.stub().resolves([{ cnt: priorEmissionCount }]);
        indexer.vm    = { execute: sinon.stub().resolves({
            success: true, error: null, gasUsed: 100, returnValue: JSON.stringify({}),
            stateChanges: [], stateDeletes: [], emittedActions, logs: [],
        }) };
        indexer.hubDb = null;
        const handler = new Execute(indexer);
        // Isolate runControllerGuard's bookkeeping from the full emission router: assign each
        // emission a result action_index exactly as the real processEmission would.
        handler.processEmission = sinon.stub().callsFake(async (emission) => {
            emission.resultActionIndex = 5000 + (emission.__seq || 0);
        });
        return { handler, db };
    }

    const opts = (over = {}) => Object.assign({
        actionType: 'SEND', controllerIndex: 5, tick: 'TOK',
        from: ADDR, to: ADDR, amount: '100', price: '', proceedsTick: '',
        hostData: { ACTION_INDEX: 10, BLOCK_INDEX: 100, BLOCK_TIME: 1700000000,
                    SOURCE: ADDR, TX_HASH: 'aa', TX_INDEX: 1, TX_VOUT: 0 },
        callDepth: 0, seq: 0,
    }, over);

    it('writes a contract_executions parent row keyed to the native action_index (so the contract_hash INNER JOIN resolves the emissions)', async function () {
        const { handler, db } = buildHandler([{ action: 'SEND', __seq: 0 }]);
        const res = await handler.runControllerGuard(opts());

        assert.strictEqual(res.allow, true);
        assert.strictEqual(db.createContractExecution.callCount, 1,
            'guard must write exactly one parent contract_executions row');
        const row = db.createContractExecution.firstCall.args[0];
        assert.strictEqual(row.ACTION_INDEX, 10,
            'parent row action_index MUST equal the emission execution_index (the native action_index) or the JOIN drops the emissions');
        assert.strictEqual(row.CONTRACT_INDEX, 5);
        assert.strictEqual(row.STATUS, 'valid');
        assert.strictEqual(row.GAS_USED, 100);

        // The emission must point its execution_index at that same parent row.
        const em = db.createContractEmission.firstCall.args[0];
        assert.strictEqual(em.EXECUTION_INDEX, 10);
        assert.strictEqual(em.POSITION, 0);
    });

    it('always writes the parent row even when the guard emits nothing (the guard execution itself enters the hash)', async function () {
        const { handler, db } = buildHandler([]);
        const res = await handler.runControllerGuard(opts());
        assert.strictEqual(res.allow, true);
        assert.strictEqual(db.createContractExecution.callCount, 1);
        assert.strictEqual(db.createContractEmission.callCount, 0);
        assert.strictEqual(db.createContractExecution.firstCall.args[0].EMITTED_COUNT, 0);
    });

    it('offsets emission position by emissions already recorded for the action (multiple guards on one action_index stay collision-free)', async function () {
        // An earlier guard on this same native action already wrote 2 emissions (positions 0,1).
        const { handler, db } = buildHandler(
            [{ action: 'SEND', __seq: 0 }, { action: 'DESTROY', __seq: 1 }],
            2
        );
        const res = await handler.runControllerGuard(opts());
        assert.strictEqual(res.allow, true);

        const positions = db.createContractEmission.getCalls().map(c => c.args[0].POSITION);
        assert.deepStrictEqual(positions, [2, 3],
            'this guard\'s emissions must start AFTER the prior guard\'s; otherwise (execution_index, position) collides and ORDER BY is not a total order (fork)');

        // emitted_count accumulates so the surviving (last-write-wins) parent row reflects the
        // action's true total emission count.
        assert.strictEqual(db.createContractExecution.firstCall.args[0].EMITTED_COUNT, 4);
    });

    it('rolls back the parent row with the emissions when a guard emission fails (denied guard leaves no record)', async function () {
        const { handler, db } = buildHandler([{ action: 'SEND', __seq: 0 }]);
        handler.processEmission = sinon.stub().rejects(new Error('boom'));
        const res = await handler.runControllerGuard(opts());
        assert.strictEqual(res.allow, false, 'a failed emission denies the action');
        assert.strictEqual(db.rollbackToSavepoint.callCount, 1,
            'the savepoint (covering the parent execution row + emissions) must roll back');
    });

    it('gives each guard invocation a unique savepoint name even when (action, controller, seq) collide (duplicate-savepoint safety)', async function () {
        // Up to three guards run on one SEND leg sharing the leg's seq, and two can
        // share a controller index (token-controller == address-controller, or a
        // self-send). The savepoint name must still be unique per invocation:
        // MariaDB silently destroys a duplicate-named savepoint, so a collision in a
        // re-entrant guard path could orphan an outer rollback target. Two calls on
        // the SAME handler with identical (ACTION_INDEX, controllerIndex, seq) must
        // therefore derive distinct names (a trailing per-invocation ordinal).
        const { handler, db } = buildHandler([]);
        await handler.runControllerGuard(opts());
        await handler.runControllerGuard(opts());
        assert.strictEqual(db.createSavepoint.callCount, 2);
        const n1 = db.createSavepoint.getCall(0).args[0];
        const n2 = db.createSavepoint.getCall(1).args[0];
        assert.ok(n1.startsWith('controller_guard_10_5_0_'), `unexpected savepoint name: ${n1}`);
        assert.ok(n2.startsWith('controller_guard_10_5_0_'), `unexpected savepoint name: ${n2}`);
        assert.notStrictEqual(n1, n2,
            'two guards sharing (action, controller, seq) must get distinct savepoint names or a re-entrant collision could destroy an outer savepoint');
    });
});
