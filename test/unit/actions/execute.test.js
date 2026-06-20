// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');
const { getTestConfig } = require('../../fixtures/config');

const Execute = require('../../../src/actions/execute.js');

describe('Execute (EXECUTE) @regression @tier2', function () {
    let indexer, actionsCtx, handler;

    const SOURCE   = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
    const CONTRACT = 5;

    function addExecuteStubs(db) {
        db.getContract             = sinon.stub().resolves({ contract_index: CONTRACT, code: 'module.exports={}', status_id: 1 });
        db.getContractPermissions  = sinon.stub().resolves(null);   // Phase E: no manifest → unrestricted
        db.getStatusString         = sinon.stub().resolves('valid');
        db.getContractState        = sinon.stub().resolves({});
        db.getOracleDataForVM      = sinon.stub().resolves({});
        db.getCrossChainDataForVM  = sinon.stub().resolves({});
        db.getContractStakeDataForVM = sinon.stub().resolves({});
        db.createContractExecution = sinon.stub().resolves();
        db.createContractState     = sinon.stub().resolves();
        db.createContractEmission  = sinon.stub().resolves();
        db.createSavepoint         = sinon.stub().resolves('sp1');
        db.releaseSavepoint        = sinon.stub().resolves();
        db.rollbackToSavepoint     = sinon.stub().resolves();
    }

    function makeVm(overrides = {}) {
        return {
            execute: sinon.stub().resolves({
                success:        true,
                gasUsed:        100,
                stateChanges:   [],
                stateDeletes:   [],
                emittedActions: [],
            }),
            ...overrides,
        };
    }

    function executeData(overrides = {}) {
        return createBaseData({ ACTION: 'EXECUTE', FORMAT: 0, SOURCE, BLOCK_INDEX: 100, ...overrides });
    }

    beforeEach(function () {
        const config = getTestConfig();
        config['GAS_PRICE'] = '0'; // fee = 0 → skip gas-balance validation

        indexer = createMockIndexer({ config });
        addExecuteStubs(indexer.indexerDb);
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 1 });
        indexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });

        actionsCtx = {
            config:    indexer.config,
            util:      indexer.util,
            mapper:    indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
            protocolChanges: indexer.protocolChanges,
        };
        handler = new Execute(actionsCtx);
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('format validation', function () {

        it('rejects unknown VERSION', async function () {
            const data = executeData({ FORMAT: 9 });
            await handler.parse(['9', String(CONTRACT), 'run', 'arg1'], data, null);
            assert.ok(String(data['STATUS']).includes('VERSION'));
        });

        it('accepts FORMAT 0', async function () {
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

    });

    describe('contract validations', function () {

        it('rejects missing CONTRACT_ACTION_INDEX', async function () {
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', '', 'run', ''], data, null);
            assert.ok(String(data['STATUS']).includes('CONTRACT_ACTION_INDEX'));
        });

        it('rejects when contract does not exist', async function () {
            indexer.indexerDb.getContract.resolves(null);
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(String(data['STATUS']).includes('CONTRACT_ACTION_INDEX'));
        });

        it('rejects when contract is not active', async function () {
            indexer.indexerDb.getStatusString.resolves('invalid');
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(String(data['STATUS']).includes('not active'));
        });

        it('rejects missing METHOD', async function () {
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), '', ''], data, null);
            assert.ok(String(data['STATUS']).includes('METHOD'));
        });

    });

    describe('source sleeping', function () {

        it('rejects when SOURCE is sleeping', async function () {
            indexer.indexerDb.isActionAllowed.resolves(false);
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(String(data['STATUS']).includes('sleeping'));
        });

    });

    describe('valid execution without VM', function () {

        it('STATUS is valid when no vm is configured', async function () {
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('createContractExecution always called', async function () {
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(indexer.indexerDb.createContractExecution.calledOnce);
        });

        it('updateBalances and updateTokens called after parse', async function () {
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(indexer.indexerDb.updateBalances.calledOnce);
            assert.ok(indexer.indexerDb.updateTokens.calledOnce);
        });

        it('mapper.createMappings called after parse', async function () {
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(indexer.mapper.createMappings.calledOnce);
        });

    });

    describe('valid execution with VM', function () {

        it('vm.execute called with correct method and params', async function () {
            const vm = makeVm();
            actionsCtx.vm = vm;
            handler = new Execute(actionsCtx);

            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'transfer', 'recipient', '50'], data, null);

            assert.ok(vm.execute.calledOnce);
            const callArgs = vm.execute.firstCall.args[0];
            assert.strictEqual(callArgs.method, 'transfer');
            assert.deepStrictEqual(callArgs.params, ['recipient', '50']);
        });

        it('STATUS is valid on successful VM execution', async function () {
            actionsCtx.vm = makeVm();
            handler = new Execute(actionsCtx);

            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('applies state changes via createContractState', async function () {
            actionsCtx.vm = makeVm({
                execute: sinon.stub().resolves({
                    success: true,
                    gasUsed: 50,
                    stateChanges:   [{ key: 'foo', value: 'bar' }],
                    stateDeletes:   [],
                    emittedActions: [],
                }),
            });
            handler = new Execute(actionsCtx);

            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(indexer.indexerDb.createContractState.calledOnce);
        });

        it('applies state deletes via createContractState with null value', async function () {
            actionsCtx.vm = makeVm({
                execute: sinon.stub().resolves({
                    success: true,
                    gasUsed: 50,
                    stateChanges:   [],
                    stateDeletes:   ['oldKey'],
                    emittedActions: [],
                }),
            });
            handler = new Execute(actionsCtx);

            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(indexer.indexerDb.createContractState.calledOnce);
            const stateArg = indexer.indexerDb.createContractState.firstCall.args[0];
            assert.strictEqual(stateArg.STATE_VALUE, null);
        });

    });

    describe('VM failure paths', function () {

        it('normalises a revert to a stable status token (not raw error string)', async function () {
            actionsCtx.vm = makeVm({
                execute: sinon.stub().resolves({
                    success: false,
                    error:   'revert: unauthorised caller',
                    gasUsed: 200,
                    stateChanges: [], stateDeletes: [], emittedActions: [],
                }),
            });
            handler = new Execute(actionsCtx);

            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            // Status should be a stable token (reverted) not a raw VM string
            assert.strictEqual(data['STATUS'], 'reverted',
                'revert must map to the stable "reverted" consensus token');
        });

        it('normalises out_of_gas to out_of_resource', async function () {
            actionsCtx.vm = makeVm({
                execute: sinon.stub().resolves({
                    success: false,
                    error:   'out_of_gas',
                    gasUsed: 1000000,
                    stateChanges: [], stateDeletes: [], emittedActions: [],
                }),
            });
            handler = new Execute(actionsCtx);

            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.strictEqual(data['STATUS'], 'out_of_resource');
        });

        it('still calls createContractExecution on VM failure', async function () {
            actionsCtx.vm = makeVm({
                execute: sinon.stub().resolves({
                    success: false, error: 'revert', gasUsed: 100,
                    stateChanges: [], stateDeletes: [], emittedActions: [],
                }),
            });
            handler = new Execute(actionsCtx);

            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(indexer.indexerDb.createContractExecution.calledOnce);
        });

        it('rolls back state changes on emission failure', async function () {
            // VM succeeds but the emission handler throws
            actionsCtx.vm = makeVm({
                execute: sinon.stub().resolves({
                    success: true,
                    gasUsed: 100,
                    stateChanges:   [{ key: 'k', value: 'v' }],
                    stateDeletes:   [],
                    emittedActions: [{ action: 'SEND', params: { tick: 'TEST', quantity: '1', destination: SOURCE } }],
                }),
            });

            // Cause savepoint write to throw (simulating emission failure)
            indexer.indexerDb.createContractState.rejects(new Error('db gone'));
            handler = new Execute(actionsCtx);

            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            // Must have called rollbackToSavepoint after the failure
            assert.ok(indexer.indexerDb.rollbackToSavepoint.calledOnce);
        });

    });

    describe('buildActionParams', function () {

        it('SEND → positional array VERSION|TICK|AMOUNT|DESTINATION|MEMO', function () {
            const p = handler.buildActionParams('SEND', { tick: 'TEST', quantity: '10', destination: '1Dest', memo: 'hi' });
            assert.deepStrictEqual(p, [0, 'TEST', '10', '1Dest', 'hi']);
        });

        it('DESTROY → VERSION|TICK|AMOUNT|MEMO', function () {
            const p = handler.buildActionParams('DESTROY', { tick: 'TEST', quantity: '5', memo: '' });
            assert.deepStrictEqual(p, [0, 'TEST', '5', '']);
        });

        it('MINT → VERSION|TICK|AMOUNT|DESTINATION|MEMO', function () {
            const p = handler.buildActionParams('MINT', { tick: 'TEST', quantity: '50', destination: '', memo: '' });
            assert.deepStrictEqual(p, [0, 'TEST', '50', '', '']);
        });

        it('BROADCAST → VERSION|MESSAGE|VALUE', function () {
            const p = handler.buildActionParams('BROADCAST', { message: 'hello', value: '42' });
            assert.deepStrictEqual(p, [0, 'hello', '42']);
        });

        it('COINPAY → VERSION|ORDER_MATCH_ACTION_INDEX', function () {
            const p = handler.buildActionParams('COINPAY', { orderMatchActionIndex: 99 });
            assert.deepStrictEqual(p, [0, 99]);
        });

        it('throws for unsupported emission action', function () {
            assert.throws(
                () => handler.buildActionParams('UNKNOWNACTION', {}),
                /unsupported emission action/
            );
        });

    });

    describe('getActionHandler', function () {

        it('returns null for unknown action', function () {
            assert.strictEqual(handler.getActionHandler('TOTALLY_UNKNOWN'), null);
        });

        it('returns the SEND handler when wired', function () {
            actionsCtx.actionSend = { parse: sinon.stub() };
            handler = new Execute(actionsCtx);
            assert.strictEqual(handler.getActionHandler('SEND'), actionsCtx.actionSend);
        });

        it('returns the DESTROY handler when wired', function () {
            actionsCtx.actionDestroy = { parse: sinon.stub() };
            handler = new Execute(actionsCtx);
            assert.strictEqual(handler.getActionHandler('DESTROY'), actionsCtx.actionDestroy);
        });

    });

    describe('processEmission', function () {

        it('throws when action handler is unknown or unsupported', async function () {
            // buildActionParams throws 'unsupported emission action' before getActionHandler fires
            const emission = { action: 'UNKNOWNACTION', params: {} };
            const execData = executeData({ FORMAT: 0 });
            await assert.rejects(
                () => handler.processEmission(emission, execData, 0),
                /unsupported|unknown/
            );
        });

        it('throws when ATTEST emission is missing position argument', async function () {
            const emission = { action: 'ATTEST', params: { requestId: 'a'.repeat(64) } };
            const execData = executeData({ FORMAT: 0 });
            await assert.rejects(
                () => handler.processEmission(emission, execData, undefined),
                /EMITTER_POSITION/
            );
        });

        // All four throw before buildActionParams, so minimal emission params suffice.

        it('throws when XCALL emission is missing the position argument', async function () {
            const emission = { action: 'XCALL', params: { gasLimit: 50000 } };
            const execData = executeData({ FORMAT: 0 });
            await assert.rejects(
                () => handler.processEmission(emission, execData, undefined),
                /XCALL emission missing EMITTER_POSITION/
            );
        });

        it('throws when XCALL is emitted from a constructor', async function () {
            const emission = { action: 'XCALL', params: { gasLimit: 50000 } };
            const execData = executeData({ FORMAT: 0, IS_CONSTRUCTOR: true });
            await assert.rejects(
                () => handler.processEmission(emission, execData, 0),
                /XCALL emission is not allowed from a constructor/
            );
        });

        it('throws when the host-derived hop count exceeds the cross-chain cap', async function () {
            // CROSS_HOPS=2 → hostHops = 2+1 = 3 > XCALL_MAX_HOPS(2).
            const emission = { action: 'XCALL', params: { gasLimit: 50000 } };
            const execData = executeData({ FORMAT: 0, CROSS_HOPS: 2 });
            await assert.rejects(
                () => handler.processEmission(emission, execData, 0),
                /exceeds max cross-chain hops/
            );
        });

        it('re-validates the XCALL gasLimit host-side (out of range rejected)', async function () {
            for (const gasLimit of [4999, 200001]) {
                const emission = { action: 'XCALL', params: { gasLimit } };
                const execData = executeData({ FORMAT: 0 });
                await assert.rejects(
                    () => handler.processEmission(emission, execData, 0),
                    /XCALL emission gasLimit out of range/,
                    'gasLimit=' + gasLimit
                );
            }
        });

        it('buildActionParams(XCALL) emits the v0 positional wire format', function () {
            const out = handler.buildActionParams('XCALL', {
                callId: 'a'.repeat(64), targetChain: 'DOGE', contractIndex: 99, method: 'onArrival',
                params: ['x', 1], gasLimit: 50000, callbackMethod: 'onResult',
                callbackParams: ['ctx'], deadlineBlocks: 200, crossHops: 1,
            });
            // VERSION|CALL_ID|TARGET_CHAIN|TARGET_CONTRACT_INDEX|METHOD|PARAMS_JSON|GAS_LIMIT|CALLBACK_METHOD|CALLBACK_PARAMS_JSON|DEADLINE_BLOCKS|CROSS_HOPS
            assert.deepStrictEqual(out, [
                0, 'a'.repeat(64), 'DOGE', 99, 'onArrival', '["x","1"]', 50000,
                'onResult', '["ctx"]', 200, 1,
            ]);
        });

        it('routes a SEND emission to the wired SEND handler', async function () {
            const sendHandler = { parse: sinon.stub().callsFake(async (params, data) => { data['STATUS'] = 'valid'; }) };
            actionsCtx.actionSend = sendHandler;
            handler = new Execute(actionsCtx);

            const emission = { action: 'SEND', params: { tick: 'TEST', quantity: '1', destination: SOURCE } };
            const execData = executeData({ FORMAT: 0, CONTRACT_ACTION_INDEX: CONTRACT });
            await handler.processEmission(emission, execData, 0);
            assert.ok(sendHandler.parse.calledOnce);
        });

        it('throws when emission handler sets STATUS to invalid', async function () {
            const sendHandler = { parse: sinon.stub().callsFake(async (params, data) => { data['STATUS'] = 'invalid: bad tick'; }) };
            actionsCtx.actionSend = sendHandler;
            handler = new Execute(actionsCtx);

            const emission = { action: 'SEND', params: { tick: 'TEST', quantity: '1', destination: SOURCE } };
            const execData = executeData({ FORMAT: 0, CONTRACT_ACTION_INDEX: CONTRACT });
            await assert.rejects(
                () => handler.processEmission(emission, execData, 0),
                /invalid/
            );
        });

        it('rejects an emission whose action is not in the contract permissions allowlist', async function () {
            const sendHandler = { parse: sinon.stub().callsFake(async (params, data) => { data['STATUS'] = 'valid'; }) };
            actionsCtx.actionSend = sendHandler;
            handler = new Execute(actionsCtx);
            // The emitter declared a manifest permitting only ISSUE; a SEND must be rejected
            // fail-closed BEFORE the handler ever runs.
            actionsCtx.indexerDb.getContractPermissions = sinon.stub().resolves({ permissions: ['ISSUE'], maxTakeBps: null });

            const emission = { action: 'SEND', params: { tick: 'TEST', quantity: '1', destination: SOURCE } };
            const execData = executeData({ FORMAT: 0, CONTRACT_ACTION_INDEX: CONTRACT });
            await assert.rejects(
                () => handler.processEmission(emission, execData, 0),
                /manifest: action SEND not permitted/
            );
            assert.ok(sendHandler.parse.notCalled, 'handler is never reached for a disallowed action');
        });

        it('allows an emission whose action IS in the permissions allowlist', async function () {
            const sendHandler = { parse: sinon.stub().callsFake(async (params, data) => { data['STATUS'] = 'valid'; }) };
            actionsCtx.actionSend = sendHandler;
            handler = new Execute(actionsCtx);
            actionsCtx.indexerDb.getContractPermissions = sinon.stub().resolves({ permissions: ['SEND', 'ISSUE'], maxTakeBps: null });

            const emission = { action: 'SEND', params: { tick: 'TEST', quantity: '1', destination: SOURCE } };
            const execData = executeData({ FORMAT: 0, CONTRACT_ACTION_INDEX: CONTRACT });
            await handler.processEmission(emission, execData, 0);
            assert.ok(sendHandler.parse.calledOnce, 'a permitted action routes to its handler');
        });

        it('an empty permissions allowlist permits no emissions', async function () {
            const sendHandler = { parse: sinon.stub().callsFake(async (params, data) => { data['STATUS'] = 'valid'; }) };
            actionsCtx.actionSend = sendHandler;
            handler = new Execute(actionsCtx);
            actionsCtx.indexerDb.getContractPermissions = sinon.stub().resolves({ permissions: [], maxTakeBps: null });

            const emission = { action: 'SEND', params: { tick: 'TEST', quantity: '1', destination: SOURCE } };
            const execData = executeData({ FORMAT: 0, CONTRACT_ACTION_INDEX: CONTRACT });
            await assert.rejects(
                () => handler.processEmission(emission, execData, 0),
                /not permitted/
            );
        });

    });

    describe('IS_EMISSION: fee skip', function () {

        it('skips gas fee debit when IS_EMISSION is true', async function () {
            const config = getTestConfig();
            config['GAS_PRICE'] = '0.00000001'; // non-zero fee to exercise the skip
            const localIndexer = createMockIndexer({ config });
            addExecuteStubs(localIndexer.indexerDb);
            localIndexer.indexerDb.isActionAllowed.resolves(true);
            localIndexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 1 });
            localIndexer.indexerDb.getAddressBalances.resolves({ 1: '0' }); // zero balance, would fail without skip

            const ctx = {
                config:    localIndexer.config,
                util:      localIndexer.util,
                mapper:    localIndexer.mapper,
                decoderDb: localIndexer.decoderDb,
                indexerDb: localIndexer.indexerDb,
                protocolChanges: localIndexer.protocolChanges,
            };
            const h = new Execute(ctx);

            const data = executeData({ FORMAT: 0, IS_EMISSION: true });
            await h.parse(['0', String(CONTRACT), 'run', ''], data, null);
            // Should be valid because fee was skipped (zero balance would have blocked it otherwise)
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(localIndexer.indexerDb.createDebit.notCalled, 'no fee debit for IS_EMISSION');
        });

    });

    // Driven directly: SLASH emissions never reach the wire/decoder, so they are
    // handled inline by this method rather than the generic emission router.
    describe('_processSlashEmission', function () {

        const PUBKEY = 'a'.repeat(64);

        function slashEmission(overrides = {}) {
            return { action: 'SLASH', params: { contractIndex: CONTRACT, pubkey: PUBKEY, token: 'STK', amount: '100', ...overrides } };
        }

        function slashData(overrides = {}) {
            return executeData({ CONTRACT_ACTION_INDEX: CONTRACT, ACTION_INDEX: 99, BLOCK_INDEX: 200, ...overrides });
        }

        // Wire the DB methods _processSlashEmission needs (absent from the default mock).
        function wireSlashDb(over = {}) {
            indexer.indexerDb.getContract        = sinon.stub().resolves({ slash_destination_id: 42 });
            indexer.indexerDb.getPubkeyId        = sinon.stub().resolves(7);
            indexer.indexerDb.getTickerId        = sinon.stub().resolves(3);
            indexer.indexerDb.slashContractStake = sinon.stub().resolves('100');
            indexer.indexerDb.doQuery            = sinon.stub().resolves([{ address: '1SlashDestXXXXXXXXXXXXXXXXXXXXX' }]);
            indexer.indexerDb.createCredit       = sinon.stub().resolves();
            indexer.indexerDb.createSlashEvent   = sinon.stub().resolves();
            for(const [k, v] of Object.entries(over)) indexer.indexerDb[k] = v;
        }

        it('slashes stake, credits the destination, and writes a slash event (happy path)', async function () {
            wireSlashDb();
            await handler._processSlashEmission(slashEmission(), slashData());
            assert.ok(indexer.indexerDb.slashContractStake.calledWith(CONTRACT, 7, 3, '100'));
            assert.ok(indexer.indexerDb.createCredit.calledWith(99, 'STK', '100', '1SlashDestXXXXXXXXXXXXXXXXXXXXX'));
            assert.ok(indexer.indexerDb.createSlashEvent.calledOnce);
            const ev = indexer.indexerDb.createSlashEvent.firstCall.args[0];
            assert.strictEqual(ev['TARGET_CONTRACT_INDEX'], CONTRACT);
            assert.strictEqual(ev['SIGNING_PUBKEY_ID'], 7);
            assert.strictEqual(ev['AMOUNT'], '100');
        });

        it('throws on a contractIndex mismatch (defense in depth)', async function () {
            wireSlashDb();
            await assert.rejects(
                handler._processSlashEmission(slashEmission({ contractIndex: 999 }), slashData()),
                /contractIndex mismatch/);
        });

        it('throws when the contract row is missing', async function () {
            wireSlashDb({ getContract: sinon.stub().resolves(null) });
            await assert.rejects(handler._processSlashEmission(slashEmission(), slashData()), /contract not found/);
        });

        it('throws when the contract has no slash destination configured', async function () {
            wireSlashDb({ getContract: sinon.stub().resolves({ slash_destination_id: null }) });
            await assert.rejects(handler._processSlashEmission(slashEmission(), slashData()), /no slash destination/);
        });

        it('no-ops silently when the pubkey is not staked here', async function () {
            wireSlashDb({ getPubkeyId: sinon.stub().resolves(null) });
            await handler._processSlashEmission(slashEmission(), slashData());
            assert.ok(indexer.indexerDb.slashContractStake.notCalled);
            assert.ok(indexer.indexerDb.createCredit.notCalled);
        });

        it('no-ops when the token ticker is unknown', async function () {
            wireSlashDb({ getTickerId: sinon.stub().resolves(null) });
            await handler._processSlashEmission(slashEmission(), slashData());
            assert.ok(indexer.indexerDb.slashContractStake.notCalled);
            assert.ok(indexer.indexerDb.createCredit.notCalled);
        });

        it('no-ops when nothing was actually slashed (0 available)', async function () {
            wireSlashDb({ slashContractStake: sinon.stub().resolves('0') });
            await handler._processSlashEmission(slashEmission(), slashData());
            assert.ok(indexer.indexerDb.createCredit.notCalled);
            assert.ok(indexer.indexerDb.createSlashEvent.notCalled);
        });

        it('throws when the destination address row is missing', async function () {
            wireSlashDb({ doQuery: sinon.stub().resolves([]) });
            await assert.rejects(handler._processSlashEmission(slashEmission(), slashData()), /destination address row missing/);
        });
    });

    describe('cross-contract calls', function () {

        const CALLEE = 7;

        function emitExecute(overrides = {}) {
            return { action: 'EXECUTE', params: { contractIndex: CALLEE, method: 'onPing', params: ['x'], gasLimit: 50000, ...overrides } };
        }

        it('getActionHandler routes EXECUTE to the wired actionExecute', function () {
            actionsCtx.actionExecute = { parse: sinon.stub() };
            handler = new Execute(actionsCtx);
            assert.strictEqual(handler.getActionHandler('EXECUTE'), actionsCtx.actionExecute);
        });

        it('processEmission threads depth, gasLimit and the deterministic call-path to the callee', async function () {
            const calleeHandler = { parse: sinon.stub().callsFake(async (params, data) => { data['STATUS'] = 'valid'; }) };
            actionsCtx.actionExecute = calleeHandler;
            handler = new Execute(actionsCtx);

            // Parent execution sits at call-path '2'; this is its emission #0, so the
            // callee's own execution path is '2>0' and the callee re-derives any of its
            // own request_ids against EMITTER_PATH = its execution path.
            const execData = executeData({ CONTRACT_ACTION_INDEX: CONTRACT, ACTION_INDEX: 11, CALL_DEPTH: 1, CALL_PATH: '2' });
            await handler.processEmission(emitExecute(), execData, 0);

            assert.ok(calleeHandler.parse.calledOnce);
            const [params, data] = calleeHandler.parse.firstCall.args;
            assert.deepStrictEqual(params, [0, CALLEE, 'onPing', 'x']);
            assert.strictEqual(data['CALL_DEPTH'], 2);                      // parent depth + 1
            assert.strictEqual(data['VM_GAS_LIMIT'], 50000);                // caller-funded ceiling
            assert.strictEqual(data['EMITTER_PATH'], '2');                  // the emitting execution's path
            assert.strictEqual(data['CALL_PATH'], '2>0');                   // the callee's own execution path
            assert.strictEqual(data['IS_EMISSION'], true);
            assert.strictEqual(data['SOURCE'], 'C:' + indexer.config['CHAIN'] + ':' + CONTRACT);
        });

        it('a callee run uses VM_GAS_LIMIT as its VM ceiling and reports its unused subtree gas', async function () {
            const vm = makeVm({
                execute: sinon.stub().resolves({
                    success: true, gasUsed: 20000,
                    stateChanges: [], stateDeletes: [], emittedActions: [],
                }),
            });
            actionsCtx.vm = vm;
            handler = new Execute(actionsCtx);

            const data = executeData({ IS_EMISSION: true, VM_GAS_LIMIT: 50000, CALL_DEPTH: 1, ACTION_INDEX: 12 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);

            const vmArgs = vm.execute.firstCall.args[0];
            assert.strictEqual(vmArgs.gasCeiling, 50000);
            assert.strictEqual(vmArgs.callDepth, 1);
            assert.strictEqual(vmArgs.actionIndex, 12);

            // billed 20000 of the 50000 reservation -> 30000 flows back to the parent
            assert.strictEqual(data['VM_GAS_UNUSED_SUBTREE'], 30000);
            const row = indexer.indexerDb.createContractExecution.firstCall.args[0];
            assert.strictEqual(row['GAS_USED'], 20000);
            assert.strictEqual(row['GAS_LIMIT'], 50000);
        });

        it('a top-level run nets callee refunds out of its billed gas', async function () {
            // Caller metered 60000 (incl. the 500+50000 reservation); the callee
            // hands back 30000 unused -> billed 30000.
            actionsCtx.vm = makeVm({
                execute: sinon.stub().resolves({
                    success: true, gasUsed: 60000,
                    stateChanges: [], stateDeletes: [],
                    emittedActions: [emitExecute()],
                }),
            });
            actionsCtx.actionExecute = { parse: sinon.stub().callsFake(async (params, data) => {
                data['STATUS'] = 'valid';
                data['VM_GAS_UNUSED_SUBTREE'] = 30000;
            }) };
            handler = new Execute(actionsCtx);

            const data = executeData({ ACTION_INDEX: 13 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            const row = indexer.indexerDb.createContractExecution.firstCall.args[0];
            assert.strictEqual(row['GAS_USED'], 30000, 'billed = 60000 metered - 30000 refunded');
            assert.strictEqual(row['GAS_LIMIT'], 1000000);
            assert.ok(indexer.indexerDb.createContractEmission.calledOnce);
        });

        it('uses an execution-unique savepoint name (nested savepoints must not collide)', async function () {
            actionsCtx.vm = makeVm();
            handler = new Execute(actionsCtx);

            const data = executeData({ ACTION_INDEX: 14 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(indexer.indexerDb.createSavepoint.calledWith('vm_execute_14'),
                'got: ' + JSON.stringify(indexer.indexerDb.createSavepoint.firstCall.args));
        });

        it('a failed callee rolls back the tree and forfeits all refunds', async function () {
            actionsCtx.vm = makeVm({
                execute: sinon.stub().resolves({
                    success: true, gasUsed: 60000,
                    stateChanges: [], stateDeletes: [],
                    emittedActions: [emitExecute()],
                }),
            });
            actionsCtx.actionExecute = { parse: sinon.stub().callsFake(async (params, data) => {
                data['STATUS'] = 'out_of_resource';
            }) };
            handler = new Execute(actionsCtx);

            const data = executeData({ ACTION_INDEX: 15 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);

            assert.ok(indexer.indexerDb.rollbackToSavepoint.calledOnce);
            assert.strictEqual(data['STATUS'], 'failed'); // 'emission failed: ...' -> failed token
            const row = indexer.indexerDb.createContractExecution.firstCall.args[0];
            assert.strictEqual(row['GAS_USED'], 60000, 'no refunds on a failed tree');
        });

        it('clamps a resource-terminated callee to ITS reservation, not the protocol ceiling', async function () {
            actionsCtx.vm = makeVm({
                execute: sinon.stub().resolves({
                    success: false, error: 'out_of_gas: used 999999 of 50000', gasUsed: 999999,
                    stateChanges: [], stateDeletes: [], emittedActions: [],
                }),
            });
            handler = new Execute(actionsCtx);

            const data = executeData({ IS_EMISSION: true, VM_GAS_LIMIT: 50000, CALL_DEPTH: 1, ACTION_INDEX: 16 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);

            const row = indexer.indexerDb.createContractExecution.firstCall.args[0];
            assert.strictEqual(row['GAS_USED'], 50000, 'defense-in-depth clamp must use the per-call ceiling');
            assert.strictEqual(data['STATUS'], 'out_of_resource');
        });

        it('system-injected callbacks (IS_EMISSION without VM_GAS_LIMIT) keep the protocol ceiling', async function () {
            const vm = makeVm();
            actionsCtx.vm = vm;
            handler = new Execute(actionsCtx);

            const data = executeData({ IS_EMISSION: true, ACTION_INDEX: 17 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.strictEqual(vm.execute.firstCall.args[0].gasCeiling, 1000000);
        });
    });

    // The default suite runs with GAS_PRICE=0 (fee skipped). Raising GAS_PRICE makes
    // fee = VM_EXECUTE_BASE * GAS_PRICE > 0, driving the native/xchain fee branch. The
    // rejected/invalid paths set `error` and short-circuit BEFORE VM execution, so they
    // are deterministic without a live VM.
    describe('gas-fee payment modes', function () {

        beforeEach(function () {
            indexer.config['GAS_PRICE'] = '0.00000100'; // fee = base * price > 0
        });

        it('rejects when a native-coin fee output is required but absent (rejected)', async function () {
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('rejected');
            const data = executeData();
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: insufficient fee (native coin output required)');
        });

        it('rejects an invalid native-coin fee', async function () {
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({ valid: false, error: 'underpaid' });
            const data = executeData();
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(String(data['STATUS']).startsWith('invalid'));
        });

        it('accepts a valid native-coin fee and records the native-coin metadata', async function () {
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('native');
            const valStub = sinon.stub(indexer.util, 'validateNativeCoinFee').resolves({
                valid: true, nativeCoinAmount: '0.0005', nativeCoin: 'BTC', oracleRound: 5,
            });
            const data = executeData();
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(valStub.called);
            // native-coin metadata is stamped on the action before VM execution
            assert.strictEqual(data['NATIVE_COIN'], 'BTC');
            assert.strictEqual(data['NATIVE_COIN_AMOUNT'], '0.0005');
            assert.strictEqual(data['ORACLE_ROUND'], 5);
        });

        it('rejects when SOURCE lacks the XCHAIN gas balance', async function () {
            sinon.stub(indexer.util, 'detectFeePaymentMode').returns('xchain');
            indexer.indexerDb.getAddressBalances.resolves({ 1: '0' }); // no GAS balance
            const data = executeData();
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: insufficient funds (GAS)');
        });
    });
});
