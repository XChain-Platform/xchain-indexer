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
 * CONSENSUS REGRESSION GUARD: leg-scoped controller-guard savepoints.
 *
 * Sibling guards on one native-action leg share an outer savepoint after
 * activation. A later denial can therefore undo an earlier guard's writes.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');
const { createMockIndexer } = require('../../fixtures/mocks');
const Execute = require('../../../src/actions/execute/index.js');

const ADDR = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

function vmResult(success, contractIndex, emittedActions = []) {
    return {
        success,
        error: success ? null : 'reverted',
        gasUsed: 10,
        returnValue: success ? JSON.stringify({}) : null,
        stateChanges: success ? [{ key: 'k' + contractIndex, value: 1 }] : [],
        stateDeletes: [],
        emittedActions,
        logs: [],
    };
}

function buildHandler(legActivation, verdicts) {
    const indexer = createMockIndexer();
    indexer.protocolChanges = {
        isDefined: sinon.stub().returns(true),
        isEnabled: sinon.stub().resolves(legActivation),
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
    indexer.vm = { execute: sinon.stub().callsFake(async (call) => {
        const verdict = verdicts[call.contractIndex];
        if(verdict === 'deny') return vmResult(false, call.contractIndex);
        const emitted = verdict === 'emit-fail' ? [{ action: 'SEND' }] : [];
        return vmResult(true, call.contractIndex, emitted);
    }) };
    indexer.hubDb = null;
    const handler = new Execute(indexer);
    handler.processEmission = sinon.stub().resolves();
    return { handler, db };
}

function legOpts(controllerIndex, over = {}) {
    return Object.assign({
        actionType: 'SEND', controllerIndex, tick: 'TOK',
        from: ADDR, to: ADDR, amount: '100', price: '', proceedsTick: '',
        hostData: {
            ACTION_INDEX: 10, BLOCK_INDEX: 100, BLOCK_TIME: 1700000000,
            SOURCE: ADDR, TX_HASH: 'aa', TX_INDEX: 1, TX_VOUT: 0,
        },
        callDepth: 0, seq: 0,
    }, over);
}

function savepointNames(db, prefix) {
    return db.createSavepoint.getCalls().map(call => call.args[0])
        .filter(name => name.startsWith(prefix));
}

describe('runControllerGuard: leg-scoped guard savepoints @regression @tier1', function () {
    it('rolls back an earlier sibling when a later guard on the same leg denies', async function () {
        const { handler, db } = buildHandler(true, { 5: 'allow', 6: 'deny' });

        assert.strictEqual((await handler.runControllerGuard(legOpts(5))).allow, true);
        assert.strictEqual((await handler.runControllerGuard(legOpts(6))).allow, false);

        const legNames = savepointNames(db, 'controller_guard_leg_');
        assert.strictEqual(legNames.length, 1);
        assert.ok(legNames[0].startsWith('controller_guard_leg_10_0_0_'));
        assert.strictEqual(db.rollbackToSavepoint.callCount, 1);
        assert.strictEqual(db.rollbackToSavepoint.firstCall.args[0], legNames[0]);
    });

    it('keeps the outer savepoint open while every sibling allows', async function () {
        const { handler, db } = buildHandler(true, { 5: 'allow', 6: 'allow' });

        assert.strictEqual((await handler.runControllerGuard(legOpts(5))).allow, true);
        assert.strictEqual((await handler.runControllerGuard(legOpts(6))).allow, true);
        assert.strictEqual(savepointNames(db, 'controller_guard_leg_').length, 1);
        assert.strictEqual(db.createSavepoint.callCount, 3);
        assert.strictEqual(db.rollbackToSavepoint.callCount, 0);
    });

    it('does not roll back an outer frame when the first guard denies', async function () {
        const { handler, db } = buildHandler(true, { 5: 'deny' });

        assert.strictEqual((await handler.runControllerGuard(legOpts(5))).allow, false);
        assert.strictEqual(db.rollbackToSavepoint.callCount, 0);
        assert.strictEqual(handler.legSavepoints.size, 0);
    });

    it('rolls back the inner guard frame and the outer leg frame after an emission failure', async function () {
        const { handler, db } = buildHandler(true, { 5: 'allow', 9: 'emit-fail' });
        handler.processEmission = sinon.stub().rejects(new Error('emission boom'));

        assert.strictEqual((await handler.runControllerGuard(legOpts(5))).allow, true);
        assert.strictEqual((await handler.runControllerGuard(legOpts(9))).allow, false);

        const legName = savepointNames(db, 'controller_guard_leg_')[0];
        const rolledBack = db.rollbackToSavepoint.getCalls().map(call => call.args[0]);
        assert.strictEqual(rolledBack.length, 2);
        assert.ok(rolledBack.includes(legName));
        assert.strictEqual(new Set(rolledBack).size, 2);
    });

    it('does not roll back a different leg of the same native action', async function () {
        const { handler, db } = buildHandler(true,
            { 5: 'allow', 6: 'allow', 7: 'allow', 8: 'deny' });

        await handler.runControllerGuard(legOpts(5, { seq: 0 }));
        await handler.runControllerGuard(legOpts(6, { seq: 0 }));
        await handler.runControllerGuard(legOpts(7, { seq: 1 }));
        assert.strictEqual((await handler.runControllerGuard(legOpts(8, { seq: 1 }))).allow, false);

        const legs = savepointNames(db, 'controller_guard_leg_');
        assert.strictEqual(legs.length, 2);
        assert.notStrictEqual(legs[0], legs[1]);
        assert.strictEqual(db.rollbackToSavepoint.lastCall.args[0], legs[1]);
        assert.ok(!db.rollbackToSavepoint.getCalls().some(call => call.args[0] === legs[0]));
    });

    it('preserves the per-guard behavior before activation', async function () {
        const { handler, db } = buildHandler(false, { 5: 'allow', 6: 'deny' });

        assert.strictEqual((await handler.runControllerGuard(legOpts(5))).allow, true);
        assert.strictEqual((await handler.runControllerGuard(legOpts(6))).allow, false);
        assert.strictEqual(db.createSavepoint.callCount, 1);
        assert.strictEqual(savepointNames(db, 'controller_guard_leg_').length, 0);
        assert.strictEqual(db.rollbackToSavepoint.callCount, 0);
        assert.strictEqual(handler.legSavepoints, undefined);
        assert.strictEqual(db.currentTxEpoch.called, false);
    });

    it('opens a fresh frame when the transaction epoch changes before a retry', async function () {
        const { handler, db } = buildHandler(true, { 5: 'allow', 6: 'deny' });

        await handler.runControllerGuard(legOpts(5));
        const staleName = savepointNames(db, 'controller_guard_leg_')[0];
        db.currentTxEpoch = sinon.stub().returns(2);
        await handler.runControllerGuard(legOpts(5));
        const retryName = savepointNames(db, 'controller_guard_leg_')[1];
        assert.notStrictEqual(retryName, staleName);

        assert.strictEqual((await handler.runControllerGuard(legOpts(6))).allow, false);
        assert.strictEqual(db.rollbackToSavepoint.lastCall.args[0], retryName);
    });

    it('keeps recursive guarded legs separate by action and call depth', async function () {
        const { handler, db } = buildHandler(true, { 5: 'allow', 6: 'allow' });

        await handler.runControllerGuard(legOpts(5));
        await handler.runControllerGuard(legOpts(6, {
            callDepth: 1,
            hostData: Object.assign({}, legOpts(6).hostData, { ACTION_INDEX: 11 }),
        }));

        const legs = savepointNames(db, 'controller_guard_leg_');
        assert.strictEqual(legs.length, 2);
        assert.notStrictEqual(legs[0], legs[1]);
    });

    it('propagates a host fault and fences stale entries from the next attempt', async function () {
        const { handler, db } = buildHandler(true, { 5: 'allow' });

        await handler.runControllerGuard(legOpts(5));
        const staleName = savepointNames(db, 'controller_guard_leg_')[0];
        const vm = handler.actions.vm;
        handler.actions.vm = null;
        await assert.rejects(handler.runControllerGuard(legOpts(7, { seq: 1 })),
            error => error.code === 'EXECUTOR_UNAVAILABLE');

        handler.actions.vm = vm;
        db.currentTxEpoch = sinon.stub().returns(2);
        await handler.runControllerGuard(legOpts(5));
        const freshName = savepointNames(db, 'controller_guard_leg_').pop();
        assert.notStrictEqual(freshName, staleName);
        assert.strictEqual(handler.legSavepoints.size, 1);
    });
});

describe('CONTROLLER_GUARD_LEG_SAVEPOINTS: consensus metadata @regression @tier1', function () {
    const protocolChanges = require('../../../src/protocol_changes.js');
    const changes = require('../../../src/protocol_changes/changes_5.js');
    const manifest = require('../../../src/consensus/armed_map/manifest.js');
    const armedFingerprint = require('../../../src/consensus/armed_map/fingerprint.js');
    const { fingerprint } = require('../../../src/consensus/armed_map/canonical.js');
    const digest = require('../../../src/consensus_rules_digest.js');
    const key = 'protocol_changes.changes.CONTROLLER_GUARD_LEG_SAVEPOINTS';
    const partsDir = path.resolve(__dirname, '../../../src/protocol_changes');
    const testnetTime = 1791061097;
    const value = {
        version_major: 0, version_minor: 2, version_revision: 0,
        mainnet_time: 9999999999, testnet_time: testnetTime, regtest_time: 0,
        mainnet_block: 0, testnet_block: 0, regtest_block: 0,
    };

    function finalPartRowCount() {
        const files = fs.readdirSync(partsDir)
            .filter(file => /^changes_\d+\.js$/.test(file))
            .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
        assert.strictEqual(files[files.length - 1], 'changes_5.js');
        const earlierRows = files.slice(0, -1)
            .reduce((count, file) => count + require(path.join(partsDir, file)).length, 0);
        const table = new protocolChanges({ config: {}, util: {} }).changes;
        return Object.keys(table).length - earlierRows;
    }

    it('installs a mainnet-inert, testnet-armed change with genesis-active regtest', function () {
        assert.deepStrictEqual(changes[changes.length - 1], [
            'CONTROLLER_GUARD_LEG_SAVEPOINTS', '0.2.0', 9999999999, testnetTime, 0, 0, 0, 0,
        ]);
        const table = new protocolChanges({ config: {}, util: {} }).changes;
        assert.deepStrictEqual(table.CONTROLLER_GUARD_LEG_SAVEPOINTS, value);
        assert.strictEqual(Object.keys(table).includes('CONTROLLER_GUARD_LEG_SAVEPOINTS'), true);
    });

    it('declares the activation in the registry and armed-map fingerprint', function () {
        assert.strictEqual(changes.length, finalPartRowCount());
        assert.strictEqual(changes[0][0], 'CONTROLLER_CUSTODY_GUARD');
        assert.strictEqual(changes[1][0], 'OWNER_WITHDRAW_OPT_IN');
        assert.strictEqual(changes[changes.length - 1][0], 'CONTROLLER_GUARD_LEG_SAVEPOINTS');
        const rows = protocolChanges.rows();
        const changeRows = rows.filter(([rowKey]) => rowKey.startsWith('protocol_changes.changes.'));
        const table = new protocolChanges({ config: {}, util: {} }).changes;
        assert.strictEqual(changeRows.length, Object.keys(table).length);
        assert.deepStrictEqual(rows.find(([rowKey]) => rowKey === key)[1], value);
        assert.ok(manifest.ENTRIES.some(([rowKey]) => rowKey === key));
        assert.deepStrictEqual(new Map(manifest.collectRows().rows).get(key), value);
        const armed = armedFingerprint.computeArmedMapFingerprintV2();
        assert.match(armed.hex, /^[0-9a-f]{64}$/);
        assert.strictEqual(armed.rows[key], fingerprint([[key, value]]).rows[key]);
    });

    it('activates by block time on testnet and regtest while mainnet remains inert', async function () {
        function build(network, blockTime) {
            return new protocolChanges({
                config: { NETWORK: network }, util: {},
                decoderDb: { getBlockTime: sinon.stub().resolves(blockTime) },
            });
        }
        assert.strictEqual(await build('regtest', 0).isEnabled('CONTROLLER_GUARD_LEG_SAVEPOINTS', 0), true);
        assert.strictEqual(await build('mainnet', 9999999998).isEnabled('CONTROLLER_GUARD_LEG_SAVEPOINTS', 0), false);
        assert.strictEqual(await build('testnet', testnetTime - 1).isEnabled('CONTROLLER_GUARD_LEG_SAVEPOINTS', 0), false);
        assert.strictEqual(await build('testnet', testnetTime).isEnabled('CONTROLLER_GUARD_LEG_SAVEPOINTS', 0), true);
    });

    it('does not alter the hub-indexer shared digest', function () {
        const names = digest.SHARED_GATES.flatMap(([, exportNames]) => exportNames);
        assert.ok(!names.includes('CONTROLLER_GUARD_LEG_SAVEPOINTS'));
        assert.ok(!names.includes('CONTROLLER_GUARD'));
        assert.doesNotThrow(() => digest.computeConsensusRulesDigest());
    });
});
