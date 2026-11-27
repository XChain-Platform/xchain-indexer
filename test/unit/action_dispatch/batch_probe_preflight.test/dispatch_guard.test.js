// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// test/unit/action_dispatch/batch_probe_preflight.test/dispatch_guard.test.js
//
// Covers the load-bearing dispatch guard and its below-probe controls.

const Batch = require('../../../../src/actions/batch/index.js');
const {
    assert, sinon, Actions, createMockIndexer, createBaseData
} = require('./helpers/preflight.js');

let indexer, actionsCtx, handler;
let executeGateBefore;
const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const WIRE = 'BATCH|0|SEND|0|TEST|10|mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM;DEPLOY|0|Y29kZQ==;SEND|0|TEST|5|mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
const EXECUTE_GATE = 'XC_EXECUTE_NATIVE_METERED_GAS_REGTEST_ACTIVATION';

function setupBatchHarness() {
    indexer    = createMockIndexer();
    actionsCtx = {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
        isBatchProbeForbiddenSubAction: Actions.isBatchProbeForbiddenSubAction,
        // Model a handler: every dispatched sub-command records its own verdict on the
        // shared data object, which is what the loop reads back.
        processAction:   sinon.stub().callsFake(async (action, params, data) => {
            data['STATUS'] = 'valid:' + action;
        }),
        actionAliases:   { TRANSFER: 'SEND', ADDR: 'ADDRESS', DROP: 'AIRDROP', CAST: 'BROADCAST', MSG: 'MESSAGE' }
    };
    handler = new Batch(actionsCtx);
    indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.util.resetLists();
}

function probeData(){
    return createBaseData({ ACTION: 'BATCH', FORMAT: 0, SOURCE, TX_DATA: WIRE,
        FEE_PROBE: true, GUARD_INERT: true, DRY_RUN: true });
}

describe('BATCH sub-command pre-flight (spec row 46) @regression @tier1', function () {

    describe('batch.js dispatch-loop guard (the load-bearing one)', function () {
        beforeEach(function () {
            executeGateBefore = process.env[EXECUTE_GATE];
            setupBatchHarness();
        });
        afterEach(function () {
            if(executeGateBefore === undefined) delete process.env[EXECUTE_GATE];
            else process.env[EXECUTE_GATE] = executeGateBefore;
            sinon.restore();
        });

        it('never dispatches a VM sub-command on the probe path', async function () {
            const data = probeData();
            await handler.parse(['0'], data, null);

            const dispatched = actionsCtx.processAction.getCalls().map(c => c.args[0]);
            assert.deepStrictEqual(dispatched, ['SEND', 'SEND'],
                'DEPLOY reached processAction on a read-only probe');
        });

        it('reports the refusal in place rather than dropping the sub-command', async function () {
            const data = probeData();
            await handler.parse(['0'], data, null);

            assert.deepStrictEqual(data['PROBE_SUB_VERDICTS'].map(v => [v.position, v.action, v.status]),
                [[0, 'SEND', 'valid:SEND'], [1, 'DEPLOY', null], [2, 'SEND', 'valid:SEND']]);
            assert.ok(data['PROBE_SUB_VERDICTS'][1].refused, 'the DEPLOY row must say why it has no verdict');
            assert.strictEqual(data['PROBE_SUB_VERDICTS'][0].refused, null);
        });

        it('the raw dry-run collects verdicts but still dispatches VM sub-commands', async function () {
            const data = createBaseData({ ACTION: 'BATCH', FORMAT: 0, SOURCE,
                TX_DATA: WIRE, DRY_RUN: true });
            await handler.parse(['0'], data, null);

            assert.deepStrictEqual(actionsCtx.processAction.getCalls().map(c => c.args[0]),
                ['SEND', 'DEPLOY', 'SEND']);
            assert.deepStrictEqual(data['PROBE_SUB_VERDICTS'].map(v => v.action),
                ['SEND', 'DEPLOY', 'SEND']);
        });

        it('answers for the BATCH, not for whichever sub-command ran last', async function () {
            const data = createBaseData({
                ACTION: 'BATCH', FORMAT: 0, SOURCE, FEE_PROBE: true, GUARD_INERT: true, DRY_RUN: true,
                TX_DATA: 'BATCH|0|SEND|0|TEST|10|mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM'
            });
            await handler.parse(['0'], data, null);
            assert.strictEqual(data['STATUS'], 'valid',
                'the top-level status must be the BATCH verdict, not the last handler\'s');
        });

        it('reports null for a sub-command whose handler recorded no verdict', async function () {
            // A settlement leg that early-exits (coinpay.js on an unmatched payee) writes no
            // STATUS. Without the per-command reset it would inherit its predecessor's.
            actionsCtx.processAction = sinon.stub().callsFake(async (action, params, data) => {
                if(action !== 'COINPAY') data['STATUS'] = 'valid:' + action;
            });
            handler = new Batch(actionsCtx);
            const data = createBaseData({
                ACTION: 'BATCH', FORMAT: 0, SOURCE, FEE_PROBE: true, GUARD_INERT: true, DRY_RUN: true,
                TX_DATA: 'BATCH|0|SEND|0|TEST|10|mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM;COINPAY|0|42'
            });
            await handler.parse(['0'], data, null);
            assert.deepStrictEqual(data['PROBE_SUB_VERDICTS'].map(v => v.status), ['valid:SEND', null]);
        });

        it('reports null for a skipped sub-command in an authenticated dry-run', async function () {
            actionsCtx.processAction = sinon.stub().callsFake(async (action, params, data) => {
                if(action !== 'COINPAY') data['STATUS'] = 'valid:' + action;
            });
            handler = new Batch(actionsCtx);
            const data = createBaseData({
                ACTION: 'BATCH', FORMAT: 0, SOURCE, DRY_RUN: true,
                TX_DATA: 'BATCH|0|SEND|0|TEST|10|mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM;COINPAY|0|42'
            });

            await handler.parse(['0'], data, null);
            assert.deepStrictEqual(data['PROBE_SUB_VERDICTS'].map(v => [v.status, v.refused]),
                [['valid:SEND', null], [null, null]]);
            assert.strictEqual(data['STATUS'], 'valid', 'top-level verdict must remain the batch verdict');
        });

        it('runs quote EXECUTE after prior state and captures both staged fees', async function () {
            process.env[EXECUTE_GATE] = '100';
            let deposited = false;
            actionsCtx.processAction = sinon.stub().callsFake(async (action, params, data) => {
                if(action === 'DEPOSIT') deposited = true;
                if(action === 'EXECUTE'){
                    assert.strictEqual(deposited, true, 'EXECUTE did not see DEPOSIT state');
                    data['PROBE_SETTLED_GAS_FEE'] = '7.00000000';
                }
                data['STATUS'] = 'valid';
            });
            indexer.indexerDb.getFeeRecord = sinon.stub().resolves({ amount: '1.00000000' });
            handler = new Batch(actionsCtx);
            const data = createBaseData({ ACTION: 'BATCH', FORMAT: 0, SOURCE,
                FEE_PROBE: true, GUARD_INERT: true, DRY_RUN: true, BATCH_FEE_QUOTE: true,
                TX_DATA: 'BATCH|0|DEPOSIT|0|JDOG|1|7;EXECUTE|0|7|claim' });
            await handler.parse(['0'], data, null);
            assert.deepStrictEqual(actionsCtx.processAction.getCalls().map(c => c.args[0]),
                ['DEPOSIT', 'EXECUTE']);
            assert.deepStrictEqual(data['PROBE_BATCH_FEES'], [
                { action: 'DEPOSIT', xchainFee: '1.00000000' },
                { action: 'EXECUTE', xchainFee: '7.00000000' }
            ]);
        });

        it('refuses quote EXECUTE below the metered-gas gate', async function () {
            process.env[EXECUTE_GATE] = '101';
            actionsCtx.processAction = sinon.stub().callsFake(async (action, params, data) => {
                data['STATUS'] = 'valid';
            });
            indexer.indexerDb.getFeeRecord = sinon.stub().resolves({ amount: '1.00000000' });
            handler = new Batch(actionsCtx);
            const data = createBaseData({ ACTION: 'BATCH', FORMAT: 0, SOURCE,
                FEE_PROBE: true, GUARD_INERT: true, DRY_RUN: true, BATCH_FEE_QUOTE: true,
                TX_DATA: 'BATCH|0|DEPOSIT|0|JDOG|1|7;EXECUTE|0|7|claim' });
            await handler.parse(['0'], data, null);
            assert.deepStrictEqual(actionsCtx.processAction.getCalls().map(c => c.args[0]), ['DEPOSIT']);
            assert.deepStrictEqual(data['PROBE_SUB_VERDICTS'][1], {
                position: 1,
                action: 'EXECUTE',
                status: null,
                refused: 'VM action not dispatched on the public pre-flight'
            });
        });
    });
});

describe('BATCH sub-command pre-flight (spec row 46) @regression @tier1', function () {

    describe('batch.js dispatch-loop guard (the load-bearing one)', function () {
        beforeEach(setupBatchHarness);
        afterEach(function () { sinon.restore(); });

        it('BELOW-PROBE CONTROL: the identical batch off the probe path is untouched', async function () {
            // The guard is inert on every decoded transaction, because actions.js sources
            // FEE_PROBE from the synthetic tx only. Same wire, no probe flag.
            const data = createBaseData({ ACTION: 'BATCH', FORMAT: 0, SOURCE, TX_DATA: WIRE });
            await handler.parse(['0'], data, null);

            const dispatched = actionsCtx.processAction.getCalls().map(c => c.args[0]);
            assert.deepStrictEqual(dispatched, ['SEND', 'DEPLOY', 'SEND'],
                'consensus dispatch must be unchanged');
            assert.strictEqual(data['PROBE_SUB_VERDICTS'], undefined, 'no probe collector off the probe path');
            assert.strictEqual(data['PROBE_ORACLE_FEES'], undefined);
            assert.strictEqual(data['STATUS'], 'valid',
                'off the probe path STATUS is the BATCH verdict too, never the last handler\'s');
        });

        it('keeps inherited sub-command status outside dry-run collection', async function () {
            let coinpayStatus;
            actionsCtx.processAction = sinon.stub().callsFake(async (action, params, data) => {
                if(action === 'COINPAY') coinpayStatus = data['STATUS'];
                else data['STATUS'] = 'valid:' + action;
            });
            handler = new Batch(actionsCtx);
            const data = createBaseData({ ACTION: 'BATCH', FORMAT: 0, SOURCE,
                TX_DATA: 'BATCH|0|SEND|0|TEST|10|mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM;COINPAY|0|42' });

            await handler.parse(['0'], data, null);
            assert.strictEqual(coinpayStatus, 'valid:SEND');
            assert.strictEqual(data['PROBE_SUB_VERDICTS'], undefined);
        });

        it('BELOW-PROBE CONTROL: the consensus value ledger is still seeded and never replaced', async function () {
            const data = createBaseData({ ACTION: 'BATCH', FORMAT: 0, SOURCE, TX_DATA: WIRE,
                FEE_PROBE: true, GUARD_INERT: true, DRY_RUN: true });
            await handler.parse(['0'], data, null);
            // Row 30's seam: a probe IS inside a flagged batch, so the key is present for the
            // READ, and the probe collectors are separate objects that never write to it.
            assert.deepStrictEqual(data['BATCH_VALUE_LEDGER'],
                { nativeFeeConsumed: '0', coinAmountConsumed: '0', oracleFeeConsumed: {} });
        });
    });
});
