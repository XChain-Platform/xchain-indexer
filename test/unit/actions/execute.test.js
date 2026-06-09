// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
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

    const SOURCE   = '1SourceAddressXXXXXXXXXXXXXXXYs6gYt';
    const CONTRACT = 5;

    function addExecuteStubs(db) {
        db.getContract             = sinon.stub().resolves({ contract_index: CONTRACT, code: 'module.exports={}', status_id: 1 });
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
        };
        handler = new Execute(actionsCtx);
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    // ─── Format validation ────────────────────────────────────────────────

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

    // ─── Contract validations ─────────────────────────────────────────────

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

    // ─── SOURCE sleeping ──────────────────────────────────────────────────

    describe('source sleeping', function () {

        it('rejects when SOURCE is sleeping', async function () {
            indexer.indexerDb.isActionAllowed.resolves(false);
            const data = executeData({ FORMAT: 0 });
            await handler.parse(['0', String(CONTRACT), 'run', ''], data, null);
            assert.ok(String(data['STATUS']).includes('sleeping'));
        });

    });

    // ─── Valid execution (no VM) ──────────────────────────────────────────

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

    // ─── Valid execution (with VM) ────────────────────────────────────────

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

    // ─── VM failure paths ─────────────────────────────────────────────────

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

    // ─── buildActionParams unit checks ────────────────────────────────────

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

    // ─── getActionHandler ─────────────────────────────────────────────────

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

    // ─── processEmission — emission routing ───────────────────────────────

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

    });

    // ─── IS_EMISSION — skip fee ───────────────────────────────────────────

    describe('IS_EMISSION — fee skip', function () {

        it('skips gas fee debit when IS_EMISSION is true', async function () {
            const config = getTestConfig();
            config['GAS_PRICE'] = '0.00000001'; // non-zero fee to exercise the skip
            const localIndexer = createMockIndexer({ config });
            addExecuteStubs(localIndexer.indexerDb);
            localIndexer.indexerDb.isActionAllowed.resolves(true);
            localIndexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 1 });
            localIndexer.indexerDb.getAddressBalances.resolves({ 1: '0' }); // zero balance — would fail without skip

            const ctx = {
                config:    localIndexer.config,
                util:      localIndexer.util,
                mapper:    localIndexer.mapper,
                decoderDb: localIndexer.decoderDb,
                indexerDb: localIndexer.indexerDb,
            };
            const h = new Execute(ctx);

            const data = executeData({ FORMAT: 0, IS_EMISSION: true });
            await h.parse(['0', String(CONTRACT), 'run', ''], data, null);
            // Should be valid because fee was skipped (zero balance would have blocked it otherwise)
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(localIndexer.indexerDb.createDebit.notCalled, 'no fee debit for IS_EMISSION');
        });

    });

    // ─── _processSlashEmission (internal SLASH handler) ───────────────────
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

    // ─── Gas-fee payment modes (fee > 0) ──────────────────────────────────
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
