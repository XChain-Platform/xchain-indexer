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

    const SOURCE = '1SourceAddressXXXXXXXXXXXXXXXYs6gYt';

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

    });
});
