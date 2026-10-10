'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sinon = require('sinon');

const gateRegistry = require('../../../../src/consensus/gate_registry');
const dispatch = require('../../../../src/actions/actions_class/dispatch.js');
const { createBaseData } = require('../../../fixtures/mocks.js');
const { buildActions, makeTx, shutdownPendingVms } = require('../../action_dispatch/actions.test/helpers/build_actions.js');
const { createBatchHarness, SOURCE } = require('../token/batch.test/helpers/batch_harness.js');

const GATE = 'action_admission_dispatched_only.ACTION_ADMISSION_DISPATCHED_ONLY';

function dispatchNames(){
    const file = path.resolve(__dirname, '../../../../src/actions/actions_class/dispatch.js');
    const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    return [...new Set([...source.matchAll(/if\s*\(\s*action\s*==\s*'([A-Z_]+)'\s*\)\s*await\s+this\.[A-Za-z0-9_]+\.parse\s*\(/g)]
        .map((match) => match[1]))].sort();
}

describe('dispatched-only ACTION admission @regression @tier1', function(){
    afterEach(async function(){
        sinon.restore();
        await shutdownPendingVms();
    });

    it('defines the admission set as exactly the names in the dispatch table', function(){
        assert.deepStrictEqual([...dispatch.DISPATCHED_ACTIONS].sort(), dispatchNames());
    });

    it('is unarmed on public networks and active from regtest genesis', function(){
        for(const network of ['mainnet', 'testnet'])
            assert.strictEqual(gateRegistry.activeAt(GATE, network, 'BTC', 9999999998, null), false);
        assert.strictEqual(gateRegistry.activeAt(GATE, 'regtest', 'BTC', 0, null), true);
    });

    it('routes a top-level registered feature flag to UNKNOWN once active', async function(){
        const { actions, stubs, indexer } = buildActions({ defined: true, enabled: true });
        await actions.processTransaction(makeTx({ data: 'VM_ACTIONS|0', block_index: 0 }));
        assert.strictEqual(stubs.actionUnknown.callCount, 1);
        const [, data, error] = stubs.actionUnknown.firstCall.args;
        assert.strictEqual(data.ACTION, 'UNKNOWN');
        assert.strictEqual(error, 'invalid: Unknown ACTION');
        assert.strictEqual(indexer.protocolChanges.isEnabled.calledWith('VM_ACTIONS'), false);
    });

    it('preserves top-level admission below the gate', async function(){
        const { actions, stubs, indexer } = buildActions({ defined: true, enabled: true });
        actions.config.NETWORK = 'mainnet';
        await actions.processTransaction(makeTx({ data: 'VM_ACTIONS|0', block_index: 1 }));
        assert.strictEqual(stubs.actionUnknown.callCount, 0);
        assert.strictEqual(indexer.protocolChanges.isEnabled.calledWith('VM_ACTIONS', 1), true);
        assert.strictEqual(indexer.indexerDb.createActionIndex.firstCall.args[0].ACTION, 'VM_ACTIONS');
    });

    it('invalidates a whole BATCH containing a registered but undispatched name once active', async function(){
        const { indexer, actionsCtx, handler } = createBatchHarness();
        const data = createBaseData({
            ACTION: 'BATCH', FORMAT: 0, SOURCE,
            BLOCK_INDEX: 0, TX_DATA: 'BATCH|0|VM_ACTIONS|0',
        });
        indexer.indexerDb.isActionAllowed.resolves(true);
        await handler.parse(['0'], data, null);
        assert.strictEqual(data.STATUS, 'invalid: ACTION (unknown)');
        assert.strictEqual(actionsCtx.processAction.callCount, 0);
    });

    it('preserves the legacy empty-action no-op in a BATCH once active', async function(){
        const { indexer, actionsCtx, handler } = createBatchHarness();
        const data = createBaseData({
            ACTION: 'BATCH', FORMAT: 0, SOURCE,
            BLOCK_INDEX: 0, TX_DATA: 'BATCH|0||;SEND|0|TEST|1|destination|',
        });
        indexer.indexerDb.isActionAllowed.resolves(true);
        await handler.parse(['0'], data, null);
        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(actionsCtx.processAction.callCount, 2);
        assert.strictEqual(actionsCtx.processAction.firstCall.args[0], '');
        assert.strictEqual(actionsCtx.processAction.secondCall.args[0], 'SEND');
    });

    it('preserves BATCH admission below the gate', async function(){
        const { indexer, actionsCtx, handler } = createBatchHarness();
        handler.config.NETWORK = 'mainnet';
        const data = createBaseData({
            ACTION: 'BATCH', FORMAT: 0, SOURCE,
            BLOCK_INDEX: 1, TX_DATA: 'BATCH|0|VM_ACTIONS|0',
        });
        indexer.indexerDb.isActionAllowed.resolves(true);
        await handler.parse(['0'], data, null);
        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(actionsCtx.processAction.calledWith('VM_ACTIONS'), true);
    });
});
