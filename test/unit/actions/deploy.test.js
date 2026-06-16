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

const Deploy = require('../../../src/actions/deploy.js');

// Minimal valid JS contract code — base64-encoded
const VALID_CODE    = 'module.exports = { run: function() { return 1; } };';
const VALID_CODE_B64 = Buffer.from(VALID_CODE, 'utf8').toString('base64');

describe('Deploy (DEPLOY) @regression @tier2', function () {
    let indexer, actionsCtx, handler;

    const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

    function addDeployStubs(db) {
        db.createContract          = sinon.stub().resolves();
        db.createContractPermission = sinon.stub().resolves();   // Phase E manifest persistence
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
            // Phase E: by default a contract declares no permissions manifest
            // (manifest null → unrestricted), so deploy behaves as pre-Phase-E.
            readManifest:      sinon.stub().resolves({ success: true, manifest: null, error: null }),
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
            // Inline DEPLOY decode is gated on DEPLOY_BASE64_CODE — base64 at/after the
            // activation, hex before. Default the stub to enabled (base64) so the existing
            // base64-fixture tests below behave as on a post-activation node; the gate
            // describe block flips it to false to exercise the pre-activation hex path.
            protocolChanges: { isEnabled: sinon.stub().resolves(true) },
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
            await handler.parse(['9', VALID_CODE_B64, '100000', ''], data, null);
            assert.ok(String(data['STATUS']).includes('VERSION'));
        });

        it('accepts FORMAT 0', async function () {
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
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
            const bigB64  = Buffer.from(bigCode, 'utf8').toString('base64');
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', bigB64, '100000', ''], data, null);
            assert.ok(String(data['STATUS']).includes('CODE_ENCODING'));
        });

        it('rejects missing GAS_LIMIT', async function () {
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '', ''], data, null);
            assert.ok(String(data['STATUS']).includes('GAS_LIMIT'));
        });

        it('rejects non-numeric GAS_LIMIT', async function () {
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, 'abc', ''], data, null);
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
            await handler.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
            assert.ok(String(data['STATUS']).includes('CODE_ENCODING'));
        });

        it('accepts code that passes syntax validation', async function () {
            actionsCtx.vm = makeVm();
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

    });

    // ─── SOURCE sleeping ──────────────────────────────────────────────────

    describe('source sleeping', function () {

        it('rejects when SOURCE is sleeping', async function () {
            indexer.indexerDb.isActionAllowed.resolves(false);
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
            assert.ok(String(data['STATUS']).includes('sleeping'));
        });

    });

    // ─── DB record writes ─────────────────────────────────────────────────

    describe('record creation', function () {

        it('createContract called on valid deploy', async function () {
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
            assert.ok(indexer.indexerDb.createContract.calledOnce);
        });

        it('createContractExecution always called', async function () {
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
            assert.ok(indexer.indexerDb.createContractExecution.calledOnce);
        });

        it('updateBalances and updateTokens called after parse', async function () {
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
            assert.ok(indexer.indexerDb.updateBalances.calledOnce);
            assert.ok(indexer.indexerDb.updateTokens.calledOnce);
        });

        it('mapper.createMappings called after parse', async function () {
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
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
            await handler.parse(['0', VALID_CODE_B64, '100000', 'initparam'], data, null);
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
            await handler.parse(['0', VALID_CODE_B64, '100000', 'initparam'], data, null);
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
            await handler.parse(['0', VALID_CODE_B64, '100000', 'initparam'], data, null);
            assert.ok(indexer.indexerDb.deleteContract.calledOnce);
        });

    });

    // ─── FORMAT 1 — staking config (COOLDOWN_BLOCKS + SLASH_DESTINATION) ──

    describe('FORMAT 1 — staking config', function () {

        it('valid v1 with COOLDOWN_BLOCKS sets STATUS valid', async function () {
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_B64, '100000', '', '100', 'BURN'], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('rejects SLASH_DESTINATION without COOLDOWN_BLOCKS', async function () {
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_B64, '100000', '', '', '1SomeAddress'], data, null);
            assert.ok(String(data['STATUS']).includes('SLASH_DESTINATION'));
        });

        it('rejects non-numeric COOLDOWN_BLOCKS', async function () {
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_B64, '100000', '', 'abc', ''], data, null);
            assert.ok(String(data['STATUS']).includes('COOLDOWN_BLOCKS'));
        });

        it('rejects COOLDOWN_BLOCKS of 0 (out of range)', async function () {
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_B64, '100000', '', '0', ''], data, null);
            assert.ok(String(data['STATUS']).includes('COOLDOWN_BLOCKS'));
        });

        it('rejects COOLDOWN_BLOCKS exceeding max', async function () {
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_B64, '100000', '', '999999', ''], data, null);
            assert.ok(String(data['STATUS']).includes('COOLDOWN_BLOCKS'));
        });

        it('COOLDOWN_BLOCKS without SLASH_DESTINATION defaults to BURN address (line 107-109)', async function () {
            // hasCooldown=true, hasDest=false → SLASH_DESTINATION set to BURN address from config
            const data = deployData({ FORMAT: 1 });
            await handler.parse(['1', VALID_CODE_B64, '100000', '', '100', ''], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            // createContract should have been called (deploy succeeded)
            sinon.assert.calledOnce(indexer.indexerDb.createContract);
        });

    });

    // ─── Hex decode failure (line 141-142) ───────────────────────────────

    describe('base64 decode failure', function () {

        it('rejects CODE_ENCODING that is not canonical base64', async function () {
            // Buffer.from(...,'base64') is lenient (silently drops chars outside the
            // alphabet), so the handler round-trips: decode then re-encode and compare.
            // A non-canonical string fails that check without needing a stub.
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', 'not-valid-base64!!', '100000', ''], data, null);

            assert.ok(String(data['STATUS']).includes('CODE_ENCODING'));
        });

    });

    // ─── CODE_ENCODING activation gate (hex below, base64 at/above) ──────
    //
    // Inline DEPLOY decodes CODE_ENCODING as base64 at/after the
    // DEPLOY_BASE64_CODE activation and as hex before it. The gate exists so a
    // heterogeneous fleet and any from-genesis replay decode every historical
    // inline DEPLOY identically — an ungated flip silently re-reads every hex-era
    // DEPLOY as base64, changing its code_hash and forking the ledger. These tests
    // drive both sides of the gate by flipping the protocolChanges stub.

    describe('CODE_ENCODING activation gate', function () {

        const crypto = require('crypto');
        const SOURCE_HASH = crypto.createHash('sha256').update(VALID_CODE).digest('hex');
        const VALID_CODE_HEX = Buffer.from(VALID_CODE, 'utf8').toString('hex');

        // Run one inline DEPLOY with the gate forced on/off and return what was
        // recorded: the final STATUS and the code_hash written to `contracts`.
        async function runDeploy({ enabled, codeEncoding }) {
            actionsCtx.protocolChanges.isEnabled = sinon.stub().resolves(enabled);
            // Reset so this run's createContract is always firstCall, even when the
            // helper is invoked twice in one test (both-sides-of-the-gate cases).
            indexer.indexerDb.createContract.resetHistory();
            const data = deployData({ FORMAT: 0 });
            await handler.parse(['0', codeEncoding, '100000', ''], data, null);
            const codeHash = indexer.indexerDb.createContract.calledOnce
                ? indexer.indexerDb.createContract.firstCall.args[0].CODE_HASH
                : null;
            return { status: data['STATUS'], codeHash };
        }

        it('at/above the gate decodes base64 → valid, code_hash = sha256(source)', async function () {
            const { status, codeHash } = await runDeploy({ enabled: true, codeEncoding: VALID_CODE_B64 });
            assert.strictEqual(status, 'valid');
            assert.strictEqual(codeHash, SOURCE_HASH);
        });

        it('below the gate decodes hex → valid, code_hash = sha256(source)', async function () {
            const { status, codeHash } = await runDeploy({ enabled: false, codeEncoding: VALID_CODE_HEX });
            assert.strictEqual(status, 'valid');
            assert.strictEqual(codeHash, SOURCE_HASH);
        });

        it('both correct encodings of the SAME source converge on one code_hash', async function () {
            const above = await runDeploy({ enabled: true,  codeEncoding: VALID_CODE_B64 });
            const below = await runDeploy({ enabled: false, codeEncoding: VALID_CODE_HEX });
            assert.strictEqual(above.codeHash, below.codeHash,
                'a hex-era and a base64-era DEPLOY of identical source must hash identically');
        });

        it('the SAME on-chain field forks across the gate (the bug the gate prevents)', async function () {
            // One byte-identical CODE_ENCODING value decoded on each side of the gate
            // must NOT yield the same contract — that divergence is precisely the
            // ledger fork. Feed the hex string: below the gate it decodes to the real
            // source; at/above it is (mis)read as base64 and yields a different result.
            const below = await runDeploy({ enabled: false, codeEncoding: VALID_CODE_HEX });
            const above = await runDeploy({ enabled: true,  codeEncoding: VALID_CODE_HEX });
            assert.strictEqual(below.status, 'valid');
            assert.strictEqual(below.codeHash, SOURCE_HASH);
            // Above the gate the same field is rejected or hashes to something else —
            // either way it does not reproduce the hex-era contract.
            const forked = (above.status !== 'valid') || (above.codeHash !== SOURCE_HASH);
            assert.ok(forked, 'reading the hex field as base64 must not reproduce the hex-era contract');
        });

        it('a base64 field below the gate (read as hex) does not yield the base64-era contract', async function () {
            // Symmetric guard: the base64 string read as hex below the gate must not
            // silently reproduce the base64-era contract.
            const below = await runDeploy({ enabled: false, codeEncoding: VALID_CODE_B64 });
            const diverged = (below.status !== 'valid') || (below.codeHash !== SOURCE_HASH);
            assert.ok(diverged, 'reading the base64 field as hex must not reproduce the base64-era contract');
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

            const ctx = { config: localIndexer.config, util: localIndexer.util, mapper: localIndexer.mapper, decoderDb: localIndexer.decoderDb, indexerDb: localIndexer.indexerDb, protocolChanges: { isEnabled: sinon.stub().resolves(true) } };
            const h = new Deploy(ctx);

            sinon.stub(localIndexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(localIndexer.util, 'validateNativeCoinFee').resolves({ valid: true, nativeCoinAmount: '0.0001', nativeCoin: 'BTC', oracleRound: 1 });

            const data = deployData({ FORMAT: 0 });
            await h.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
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

            const ctx = { config: localIndexer.config, util: localIndexer.util, mapper: localIndexer.mapper, decoderDb: localIndexer.decoderDb, indexerDb: localIndexer.indexerDb, protocolChanges: { isEnabled: sinon.stub().resolves(true) } };
            const h = new Deploy(ctx);

            sinon.stub(localIndexer.util, 'detectFeePaymentMode').returns('native');
            sinon.stub(localIndexer.util, 'validateNativeCoinFee').resolves({ valid: false, error: 'fee too small' });

            const data = deployData({ FORMAT: 0 });
            await h.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
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

            const ctx = { config: localIndexer.config, util: localIndexer.util, mapper: localIndexer.mapper, decoderDb: localIndexer.decoderDb, indexerDb: localIndexer.indexerDb, protocolChanges: { isEnabled: sinon.stub().resolves(true) } };
            const h = new Deploy(ctx);

            sinon.stub(localIndexer.util, 'detectFeePaymentMode').returns('rejected');

            const data = deployData({ FORMAT: 0 });
            await h.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
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

            const ctx = { config: localIndexer.config, util: localIndexer.util, mapper: localIndexer.mapper, decoderDb: localIndexer.decoderDb, indexerDb: localIndexer.indexerDb, protocolChanges: { isEnabled: sinon.stub().resolves(true) } };
            const h = new Deploy(ctx);

            // Ensure xchain mode is used (detectFeePaymentMode returns 'xchain')
            sinon.stub(localIndexer.util, 'detectFeePaymentMode').returns('xchain');

            const data = deployData({ FORMAT: 0 });
            await h.parse(['0', VALID_CODE_B64, '100000', ''], data, null);
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
            await handler.parse(['0', VALID_CODE_B64, '100000', 'initparam'], data, null);

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
            await handler.parse(['0', VALID_CODE_B64, '100000', 'initparam'], data, null);

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
            await handler.parse(['0', VALID_CODE_B64, '100000', 'initparam'], data, null);

            sinon.assert.calledOnce(indexer.indexerDb.rollbackToSavepoint);
            // deleteContract called (contract record cleaned up)
            assert.ok(indexer.indexerDb.deleteContract.called);
            assert.ok(String(data['STATUS']).includes('failed') || String(data['STATUS']).startsWith('invalid'));
        });

    });

    // ─── Constructor emissions (processed through the EXECUTE pipeline) ────

    describe('constructor emissions', function () {

        function wireEmissionDeps(emittedActions, vmGas = 1000) {
            indexer.indexerDb.createContractEmission = sinon.stub().resolves();
            actionsCtx.vm = makeVm({
                execute: sinon.stub().resolves({
                    success: true, gasUsed: vmGas,
                    stateChanges: [], stateDeletes: [],
                    emittedActions,
                }),
            });
            actionsCtx.actionExecute = {
                processEmission:       sinon.stub().callsFake(async (emission) => { emission.resultActionIndex = 999; }),
                _processSlashEmission: sinon.stub().resolves(),
            };
            handler = new Deploy(actionsCtx);
            return actionsCtx;
        }

        it('routes constructor emissions through Execute.processEmission with a root context', async function () {
            const ctx = wireEmissionDeps([{ action: 'SEND', params: { tick: 'T', quantity: '1', destination: SOURCE } }]);

            const data = deployData({ FORMAT: 0, ACTION_INDEX: 42 });
            await handler.parse(['0', VALID_CODE_B64, '100000', 'init'], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            sinon.assert.calledOnce(ctx.actionExecute.processEmission);
            const [emission, execCtx, position] = ctx.actionExecute.processEmission.firstCall.args;
            assert.strictEqual(emission.action, 'SEND');
            assert.strictEqual(position, 0);
            assert.strictEqual(execCtx['CONTRACT_ACTION_INDEX'], 42); // the new contract emits
            assert.strictEqual(execCtx['ACTION_INDEX'], 42);          // DEPLOY is the executing action
            assert.strictEqual(execCtx['CALL_DEPTH'], 0);             // constructor = root execution
            assert.strictEqual(execCtx['SOURCE'], SOURCE);            // deployer pays fees
            // Emission link recorded against the deployment
            sinon.assert.calledOnce(indexer.indexerDb.createContractEmission);
            const link = indexer.indexerDb.createContractEmission.firstCall.args[0];
            assert.strictEqual(link['EXECUTION_INDEX'], 42);
            assert.strictEqual(link['ACTION_INDEX'], 999);
        });

        it('passes txHash / actionIndex / callDepth=0 to the constructor VM run', async function () {
            const ctx = wireEmissionDeps([]);
            const data = deployData({ FORMAT: 0, ACTION_INDEX: 7 });
            await handler.parse(['0', VALID_CODE_B64, '100000', 'init'], data, null);
            const vmArgs = ctx.vm.execute.firstCall.args[0];
            assert.strictEqual(vmArgs.txHash, data['TX_HASH']);
            assert.strictEqual(vmArgs.actionIndex, 7);
            assert.strictEqual(vmArgs.callDepth, 0);
        });

        it('nets a cross-contract callee refund out of the deployment gas', async function () {
            const ctx = wireEmissionDeps(
                [{ action: 'EXECUTE', params: { contractIndex: 9, method: 'm', gasLimit: 50000 } }],
                60000 // constructor metered gas (includes the 500+50000 reservation)
            );
            ctx.actionExecute.processEmission = sinon.stub().callsFake(async (emission) => {
                emission.resultActionIndex = 999;
                emission.gasUnusedSubtree = 30000;
            });
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0, ACTION_INDEX: 8 });
            await handler.parse(['0', VALID_CODE_B64, '100000', 'init'], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            const schedule = indexer.config['GAS_SCHEDULE'];
            const deployGas = schedule.VM_DEPLOY_BASE + Buffer.byteLength(VALID_CODE, 'utf8') * schedule.VM_DEPLOY_PER_BYTE;
            const row = indexer.indexerDb.createContractExecution.firstCall.args[0];
            assert.strictEqual(row['GAS_USED'], deployGas + 60000 - 30000,
                'deployment gas must net the callee refund');
        });

        it('a failed constructor emission rolls back and fails the deployment', async function () {
            const ctx = wireEmissionDeps([{ action: 'SEND', params: {} }]);
            ctx.actionExecute.processEmission = sinon.stub().rejects(new Error('SEND: invalid: insufficient funds'));
            handler = new Deploy(actionsCtx);

            const data = deployData({ FORMAT: 0, ACTION_INDEX: 9 });
            await handler.parse(['0', VALID_CODE_B64, '100000', 'init'], data, null);

            sinon.assert.calledOnce(indexer.indexerDb.rollbackToSavepoint);
            assert.ok(indexer.indexerDb.deleteContract.called);
            assert.ok(String(data['STATUS']).startsWith('invalid'));
        });

        it('routes SLASH emissions to the inline handler (never the generic router)', async function () {
            const ctx = wireEmissionDeps([{ action: 'SLASH', params: { contractIndex: 10, pubkey: 'a'.repeat(64), token: 'T', amount: '1' } }]);
            const data = deployData({ FORMAT: 0, ACTION_INDEX: 10 });
            await handler.parse(['0', VALID_CODE_B64, '100000', 'init'], data, null);
            sinon.assert.calledOnce(ctx.actionExecute._processSlashEmission);
            sinon.assert.notCalled(ctx.actionExecute.processEmission);
        });

        it('uses a deployment-unique savepoint name (emitted EXECUTEs nest their own)', async function () {
            wireEmissionDeps([]);
            const data = deployData({ FORMAT: 0, ACTION_INDEX: 11 });
            await handler.parse(['0', VALID_CODE_B64, '100000', 'init'], data, null);
            assert.ok(indexer.indexerDb.createSavepoint.calledWith('vm_constructor_11'),
                'got: ' + JSON.stringify(indexer.indexerDb.createSavepoint.firstCall && indexer.indexerDb.createSavepoint.firstCall.args));
        });

    });
});
