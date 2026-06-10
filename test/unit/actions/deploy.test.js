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

const Deploy = require('../../../src/actions/deploy.js');

// Minimal valid JS contract code — hex-encoded
const VALID_CODE    = 'module.exports = { run: function() { return 1; } };';
const VALID_CODE_HEX = Buffer.from(VALID_CODE, 'utf8').toString('hex');

describe('Deploy (DEPLOY) @regression @tier2', function () {
    let indexer, actionsCtx, handler;

    const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

    function addDeployStubs(db) {
        db.createContract          = sinon.stub().resolves();
        db.deleteContract          = sinon.stub().resolves();
        db.createContractExecution = sinon.stub().resolves();
        db.createContractState     = sinon.stub().resolves();
        db.createSavepoint         = sinon.stub().resolves('sp1');
        db.releaseSavepoint        = sinon.stub().resolves();
        db.rollbackToSavepoint     = sinon.stub().resolves();
        db.getOracleDataForVM      = sinon.stub().resolves({});
        db.getCrossChainDataForVM  = sinon.stub().resolves({});
        db.getStatusString         = sinon.stub().resolves('valid');
    }

    function makeVm(overrides = {}) {
        return {
            validateSyntax:    sinon.stub().returns({ valid: true }),
            checkFloatWarnings:sinon.stub().returns([]),
            execute:           sinon.stub().resolves({
                success:      true,
                gasUsed:      0,
                stateChanges: [],
                stateDeletes: [],
                emittedActions: [],
            }),
            ...overrides,
        };
    }

    function deployData(overrides = {}) {
        return createBaseData({ ACTION: 'DEPLOY', FORMAT: 0, SOURCE, BLOCK_INDEX: 100, ...overrides });
    }

    beforeEach(function () {
        const config = getTestConfig();
        config['GAS_PRICE'] = '0'; // fee = 0 → skip balance check in most tests

        indexer = createMockIndexer({ config });
        addDeployStubs(indexer.indexerDb);
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
        handler = new Deploy(actionsCtx);
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    // ─── Format validation ────────────────────────────────────────────────

    describe('format validation', function () {

        it('rejects an unknown VERSION', async function () {
            const data = deployData({ FORMAT: 9 });
            await handler.parse(['9', VALID_CODE_HEX, '100000', ''], data, null);
            assert.ok(String(data['STATUS']).includes('VERSION'));
        });

        it('accepts FORMAT 0', async function () {
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_HEX, '100000', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

    });

    // ─── Code validations ─────────────────────────────────────────────────

    describe('code validations', function () {

        it('rejects missing CODE_ENCODING', async function () {
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', '', '100000', ''], data, null);
            assert.ok(String(data['STATUS']).includes('CODE_ENCODING'));
        });

        it('rejects code exceeding MAX_CODE_SIZE', async function () {
            // 64KiB + 1 byte
            const bigCode = 'a'.repeat(Deploy.MAX_CODE_SIZE + 1);
            const bigHex  = Buffer.from(bigCode, 'utf8').toString('hex');
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', bigHex, '100000', ''], data, null);
            assert.ok(String(data['STATUS']).includes('CODE_ENCODING'));
        });

        it('rejects missing GAS_LIMIT', async function () {
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_HEX, '', ''], data, null);
            assert.ok(String(data['STATUS']).includes('GAS_LIMIT'));
        });

        it('rejects non-numeric GAS_LIMIT', async function () {
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_HEX, 'abc', ''], data, null);
            assert.ok(String(data['STATUS']).includes('GAS_LIMIT'));
        });

    });

    // ─── VM syntax rejection ──────────────────────────────────────────────

    describe('VM syntax validation', function () {

        it('rejects code that fails syntax validation', async function () {
            actionsCtx.vm = makeVm({
                validateSyntax: sinon.stub().returns({ valid: false, error: 'SyntaxError: unexpected token' }),
            });
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_HEX, '100000', ''], data, null);
            assert.ok(String(data['STATUS']).includes('CODE_ENCODING'));
        });

        it('accepts code that passes syntax validation', async function () {
            actionsCtx.vm = makeVm();
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_HEX, '100000', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

    });

    // ─── SOURCE sleeping ──────────────────────────────────────────────────

    describe('source sleeping', function () {

        it('rejects when SOURCE is sleeping', async function () {
            indexer.indexerDb.isActionAllowed.resolves(false);
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_HEX, '100000', ''], data, null);
            assert.ok(String(data['STATUS']).includes('sleeping'));
        });

    });

    // ─── DB record writes ─────────────────────────────────────────────────

    describe('record creation', function () {

        it('createContract called on valid deploy', async function () {
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_HEX, '100000', ''], data, null);
            assert.ok(indexer.indexerDb.createContract.calledOnce);
        });

        it('createContractExecution always called', async function () {
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_HEX, '100000', ''], data, null);
            assert.ok(indexer.indexerDb.createContractExecution.calledOnce);
        });

        it('updateBalances and updateTokens called after parse', async function () {
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_HEX, '100000', ''], data, null);
            assert.ok(indexer.indexerDb.updateBalances.calledOnce);
            assert.ok(indexer.indexerDb.updateTokens.calledOnce);
        });

        it('mapper.createMappings called after parse', async function () {
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_HEX, '100000', ''], data, null);
            assert.ok(indexer.mapper.createMappings.calledOnce);
        });

    });

    // ─── Constructor execution ────────────────────────────────────────────

    describe('constructor execution (FORMAT 0 + CONSTRUCTOR_PARAMS)', function () {

        it('runs constructor when CONSTRUCTOR_PARAMS provided and VM present', async function () {
            const vm = makeVm();
            actionsCtx.vm = vm;
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_HEX, '100000', 'initparam'], data, null);
            assert.ok(vm.execute.calledOnce, 'vm.execute should be called for constructor');
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('marks deploy invalid when constructor fails', async function () {
            const vm = makeVm({
                execute: sinon.stub().resolves({
                    success: false,
                    error:   'revert: bad init',
                    gasUsed: 1000,
                    stateChanges:  [],
                    stateDeletes:  [],
                    emittedActions: [],
                }),
            });
            actionsCtx.vm = vm;
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_HEX, '100000', 'initparam'], data, null);
            // Status is a normalised vmFailureStatus token (reverted / failed / out_of_resource)
            assert.notStrictEqual(data['STATUS'], 'valid');
        });

        it('deleteContract called when constructor fails', async function () {
            const vm = makeVm({
                execute: sinon.stub().resolves({
                    success: false, error: 'revert: bad', gasUsed: 500,
                    stateChanges: [], stateDeletes: [], emittedActions: [],
                }),
            });
            actionsCtx.vm = vm;
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_HEX, '100000', 'initparam'], data, null);
            assert.ok(indexer.indexerDb.deleteContract.calledOnce);
        });

    });

    // ─── FORMAT 1 — staking config (COOLDOWN_BLOCKS + SLASH_DESTINATION) ──

    describe('FORMAT 1 — staking config', function () {

        it('valid v1 with COOLDOWN_BLOCKS sets STATUS valid', async function () {
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_HEX, '100000', '', '100', 'BURN'], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('rejects SLASH_DESTINATION without COOLDOWN_BLOCKS', async function () {
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_HEX, '100000', '', '', '1SomeAddress'], data, null);
            assert.ok(String(data['STATUS']).includes('SLASH_DESTINATION'));
        });

        it('rejects non-numeric COOLDOWN_BLOCKS', async function () {
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_HEX, '100000', '', 'abc', ''], data, null);
            assert.ok(String(data['STATUS']).includes('COOLDOWN_BLOCKS'));
        });

        it('rejects COOLDOWN_BLOCKS of 0 (out of range)', async function () {
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_HEX, '100000', '', '0', ''], data, null);
            assert.ok(String(data['STATUS']).includes('COOLDOWN_BLOCKS'));
        });

        it('rejects COOLDOWN_BLOCKS exceeding max', async function () {
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_HEX, '100000', '', '999999', ''], data, null);
            assert.ok(String(data['STATUS']).includes('COOLDOWN_BLOCKS'));
        });

        it('COOLDOWN_BLOCKS without SLASH_DESTINATION defaults to BURN address (line 107-109)', async function () {
            // hasCooldown=true, hasDest=false → SLASH_DESTINATION set to BURN address from config
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_HEX, '100000', '', '100', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            // createContract should have been called (deploy succeeded)
            sinon.assert.calledOnce(indexer.indexerDb.createContract);
        });

    });

    // ─── Hex decode failure (line 141-142) ───────────────────────────────

    describe('hex decode failure', function () {

        it('rejects CODE_ENCODING with non-hex characters', async function () {
            // Buffer.from with invalid hex doesn't throw in Node — it silently ignores bad chars.
            // To hit the catch branch we need to stub Buffer.from or cause a real throw.
            // In practice the try/catch is a defensive guard; test via stub.
            const origBufferFrom = Buffer.from.bind(Buffer);
            const bufferStub = sinon.stub(Buffer, 'from').callsFake((data, encoding) => {
                if(encoding === 'hex') throw new Error('invalid hex');
                return origBufferFrom(data, encoding);
            });

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', 'not-valid-hex!!', '100000', ''], data, null);
            bufferStub.restore();

            assert.ok(String(data['STATUS']).includes('CODE_ENCODING'));
        });

    });

    // ─── Native coin fee payment paths (lines 185-203) ───────────────────

    describe('native coin fee payment', function () {

        it('valid native coin fee sets feePaymentMode=1 and STATUS valid', async function () {
            const config = getTestConfig();
            config['GAS_PRICE'] = '0.00000001'; // non-zero fee to trigger payment mode check
            const localIndexer = createMockIndexer({ config });
            addDeployStubs(localIndexer.indexerDb);
            localIndexer.indexerDb.isActionAllowed.resolves(true);
            localIndexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 1 });
            localIndexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });

            const ctx = { config: localIndexer.config, util: localIndexer.util, mapper: localIndexer.mapper, decoderDb: localIndexer.decoderDb, indexerDb: localIndexer.indexerDb };
            const h = new Deploy(ctx);

            sinon.stub(localIndexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(localIndexer.util, 'validateNativeCoinFee').resolves({ valid: true, nativeCoinAmount: '0.0001', nativeCoin: 'BTC', oracleRound: 1 });

            const data = deployData({ FORMAT: 0 });
            await h.parse(['0', VALID_CODE_HEX, '100000', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('invalid native coin fee returns error', async function () {
            const config = getTestConfig();
            config['GAS_PRICE'] = '0.00000001';
            const localIndexer = createMockIndexer({ config });
            addDeployStubs(localIndexer.indexerDb);
            localIndexer.indexerDb.isActionAllowed.resolves(true);
            localIndexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 1 });
            localIndexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });

            const ctx = { config: localIndexer.config, util: localIndexer.util, mapper: localIndexer.mapper, decoderDb: localIndexer.decoderDb, indexerDb: localIndexer.indexerDb };
            const h = new Deploy(ctx);

            sinon.stub(localIndexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(localIndexer.util, 'validateNativeCoinFee').resolves({ valid: false, error: 'fee too small' });

            const data = deployData({ FORMAT: 0 });
            await h.parse(['0', VALID_CODE_HEX, '100000', ''], data, null);
            assert.ok(String(data['STATUS']).includes('fee too small') || String(data['STATUS']).startsWith('invalid'));
        });

        it('rejected native coin fee returns insufficient fee error', async function () {
            const config = getTestConfig();
            config['GAS_PRICE'] = '0.00000001';
            const localIndexer = createMockIndexer({ config });
            addDeployStubs(localIndexer.indexerDb);
            localIndexer.indexerDb.isActionAllowed.resolves(true);
            localIndexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 1 });
            localIndexer.indexerDb.getAddressBalances.resolves({ 1: '1000000' });

            const ctx = { config: localIndexer.config, util: localIndexer.util, mapper: localIndexer.mapper, decoderDb: localIndexer.decoderDb, indexerDb: localIndexer.indexerDb };
            const h = new Deploy(ctx);

            sinon.stub(localIndexer.util, 'detectFeePaymentMode').returns('rejected');

            const data = deployData({ FORMAT: 0 });
            await h.parse(['0', VALID_CODE_HEX, '100000', ''], data, null);
            assert.ok(String(data['STATUS']).includes('insufficient fee'));
        });

        it('xchain balance insufficient for GAS returns invalid (lines 200-202)', async function () {
            const config = getTestConfig();
            config['GAS_PRICE'] = '0.00000001';
            const localIndexer = createMockIndexer({ config });
            addDeployStubs(localIndexer.indexerDb);
            localIndexer.indexerDb.isActionAllowed.resolves(true);
            localIndexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 1 });
            // Zero balance — fee check will fail
            localIndexer.indexerDb.getAddressBalances.resolves({ 1: '0' });

            const ctx = { config: localIndexer.config, util: localIndexer.util, mapper: localIndexer.mapper, decoderDb: localIndexer.decoderDb, indexerDb: localIndexer.indexerDb };
            const h = new Deploy(ctx);

            // Ensure xchain mode is used (detectFeePaymentMode returns 'xchain')
            sinon.stub(localIndexer.util, 'detectFeePaymentMode').returns('xchain');

            const data = deployData({ FORMAT: 0 });
            await h.parse(['0', VALID_CODE_HEX, '100000', ''], data, null);
            assert.ok(String(data['STATUS']).includes('insufficient funds') || String(data['STATUS']).includes('GAS'));
        });

    });

    // ─── Constructor state changes + rollback (lines 323-348) ────────────

    describe('constructor state changes and rollback', function () {

        it('constructor with stateChanges calls createContractState for each change (lines 322-330)', async function () {
            const vm = makeVm({
                execute: sinon.stub().resolves({
                    success: true,
                    gasUsed: 50,
                    stateChanges: [{ key: 'foo', value: 'bar' }, { key: 'baz', value: 42 }],
                    stateDeletes: [],
                    emittedActions: [],
                }),
            });
            actionsCtx.vm = vm;
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_HEX, '100000', 'initparam'], data, null);

            // createContractState called twice (once per change)
            assert.ok(indexer.indexerDb.createContractState.callCount >= 2);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('constructor with stateDeletes calls createContractState with null value (lines 332-339)', async function () {
            const vm = makeVm({
                execute: sinon.stub().resolves({
                    success: true,
                    gasUsed: 50,
                    stateChanges: [],
                    stateDeletes: ['oldKey1', 'oldKey2'],
                    emittedActions: [],
                }),
            });
            actionsCtx.vm = vm;
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_HEX, '100000', 'initparam'], data, null);

            const calls = indexer.indexerDb.createContractState.args;
            const nullCalls = calls.filter(a => a[0].STATE_VALUE === null);
            assert.ok(nullCalls.length >= 2, 'should have called createContractState with null for each delete');
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('constructor state write failure rolls back savepoint and marks deploy failed (lines 341-348)', async function () {
            const vm = makeVm({
                execute: sinon.stub().resolves({
                    success: true,
                    gasUsed: 50,
                    stateChanges: [{ key: 'k', value: 'v' }],
                    stateDeletes: [],
                    emittedActions: [],
                }),
            });
            actionsCtx.vm = vm;
            // Cause createContractState to throw
            indexer.indexerDb.createContractState.rejects(new Error('disk full'));
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_HEX, '100000', 'initparam'], data, null);

            sinon.assert.calledOnce(indexer.indexerDb.rollbackToSavepoint);
            // deleteContract called (contract record cleaned up)
            assert.ok(indexer.indexerDb.deleteContract.called);
            assert.ok(String(data['STATUS']).includes('failed') || String(data['STATUS']).startsWith('invalid'));
        });

    });
});
