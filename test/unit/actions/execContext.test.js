// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// shared injected-execution context builder + SYNTH_EXEC_TX_HASH seam.
//
// A contract that emitted ATTEST/XCALL from inside its attestation-expiry or
// poll-finalize callback got a synthesized exec context with no TX_HASH: the
// VM tolerated it and charged gas, then the indexer hard-rejected the emission
// ('invalid: TX_HASH'), stranding the contract on an id that never resolves.
// These tests pin the shared builder (all four injector sites), the flag-day
// gating (legacy hashless context below activation), the byte-parity of the
// pre-existing XCALLCB synthesis, and the execute.js host-side assert.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const { buildInjectedExecContext, synthesizeTxHash, SYNTH_EXEC_TX_HASH, SYNTH_TAGS } =
    require('../../../src/actions/execContext.js');
const { rethrowIfInfraFault } = require('../../../src/actions/faultGuard.js');

const Attest = require('../../../src/actions/attest.js');
const Vote   = require('../../../src/actions/vote.js');
const Xcall  = require('../../../src/actions/xcall.js');

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

describe('execContext (injected-execution TX_HASH seam) @regression @tier2', function () {

    afterEach(function () { sinon.restore(); });

    describe('buildInjectedExecContext', function () {

        const base = {
            chain: 'BTC', network: 'regtest', contractIndex: 7,
            actionIndex: 42, blockIndex: 100, blockTime: 1700000000, emitter: 9,
        };

        it('synthesizes TX_HASH as sha256(TAG:NETWORK:CHAIN:ID)', function () {
            const ctx = buildInjectedExecContext({ ...base, synthTag: 'VOTECB', synthId: 55 });
            assert.strictEqual(ctx.TX_HASH, sha256hex('VOTECB:regtest:BTC:55'));
        });

        it('prefers a real txHash over synthesis and builds the full identity tuple', function () {
            const ctx = buildInjectedExecContext({ ...base, txHash: 'f'.repeat(64), synthTag: 'VOTECB', synthId: 55 });
            assert.strictEqual(ctx.TX_HASH, 'f'.repeat(64));
            assert.strictEqual(ctx.SOURCE, 'C:BTC:7');
            assert.strictEqual(ctx.FEE_PAYER, 'C:BTC:7');
            assert.strictEqual(ctx.ACTION_INDEX, 42);
            assert.strictEqual(ctx.BLOCK_INDEX, 100);
            assert.strictEqual(ctx.BLOCK_TIME, 1700000000);
            assert.strictEqual(ctx.EMITTER, 9);
            assert.strictEqual(ctx.FORMAT, 0);
            assert.strictEqual(ctx.IS_EMISSION, true);
        });

        it('includeTxHash:false reproduces the legacy hashless context (no TX_HASH key)', function () {
            const ctx = buildInjectedExecContext({ ...base, synthTag: 'VOTECB', synthId: 55, includeTxHash: false });
            assert.ok(!('TX_HASH' in ctx), 'legacy context must not carry a TX_HASH key');
        });

        it('throws when TX_HASH is required but underivable (the class assert)', function () {
            assert.throws(() => buildInjectedExecContext({ ...base }), /TX_HASH required/);
        });

        it('throws on a missing identity field', function () {
            const { emitter, ...noEmitter } = { ...base, synthTag: 'VOTECB', synthId: 1 };
            assert.throws(() => buildInjectedExecContext(noEmitter), /missing required field emitter/);
        });

        it('merges site-specific extra fields verbatim', function () {
            const ctx = buildInjectedExecContext({
                ...base, synthTag: 'XCALLCB', synthId: 'cid',
                extra: { CALL_DEPTH: 0, VM_GAS_LIMIT: 20000, CROSS_HOPS: 1 },
            });
            assert.strictEqual(ctx.CALL_DEPTH, 0);
            assert.strictEqual(ctx.VM_GAS_LIMIT, 20000);
            assert.strictEqual(ctx.CROSS_HOPS, 1);
        });
    });

    describe('attest expiry callback (previously-broken site 1)', function () {
        let indexer, handler, executeStub;

        function makeHandler(synthActive) {
            indexer = createMockIndexer();
            indexer.indexerDb.createActionIndex   = sinon.stub().resolves(500);
            indexer.indexerDb.createSavepoint     = sinon.stub().resolves('sp');
            indexer.indexerDb.releaseSavepoint    = sinon.stub().resolves();
            indexer.indexerDb.rollbackToSavepoint = sinon.stub().resolves();
            executeStub = { parse: sinon.stub().resolves() };
            handler = new Attest({
                config: indexer.config, util: indexer.util, mapper: indexer.mapper,
                decoderDb: indexer.decoderDb, indexerDb: indexer.indexerDb,
                actionExecute: executeStub,
                protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(synthActive) },
            });
        }

        const request = {
            request_id: 'd'.repeat(64), provider_id: 'http_get', contract_index: 5,
            callback_method: 'onResult', callback_params_json: '[]',
        };
        const expireData = { BLOCK_INDEX: 120, BLOCK_TIME: 1700000500, ACTION_INDEX: 77 };

        it('post-flag-day the injected context carries the ATTESTEXPCB synthetic TX_HASH', async function () {
            makeHandler(true);
            await handler._injectExpiredCallback(request, expireData);
            const ctx = executeStub.parse.firstCall.args[1];
            assert.strictEqual(ctx.TX_HASH,
                sha256hex('ATTESTEXPCB:' + indexer.config['NETWORK'] + ':' + indexer.config['CHAIN'] + ':' + request.request_id));
            assert.strictEqual(ctx.IS_EMISSION, true);
            assert.strictEqual(ctx.EMITTER, 77);
            assert.strictEqual(ctx.SOURCE, 'C:' + indexer.config['CHAIN'] + ':5');
        });

        it('pre-flag-day the legacy hashless context is preserved byte-identically', async function () {
            makeHandler(false);
            await handler._injectExpiredCallback(request, expireData);
            const ctx = executeStub.parse.firstCall.args[1];
            assert.ok(!('TX_HASH' in ctx), 'pre-activation context must stay hashless (replay safety)');
        });
    });

    describe('vote finalize callback (previously-broken site 2)', function () {
        let indexer, handler, executeStub;

        function makeHandler(synthActive) {
            indexer = createMockIndexer();
            indexer.indexerDb.createActionIndex   = sinon.stub().resolves(600);
            indexer.indexerDb.createSavepoint     = sinon.stub().resolves('sp');
            indexer.indexerDb.releaseSavepoint    = sinon.stub().resolves();
            indexer.indexerDb.rollbackToSavepoint = sinon.stub().resolves();
            indexer.indexerDb.getTicker           = sinon.stub().resolves('GOV');
            executeStub = { parse: sinon.stub().resolves() };
            handler = new Vote({
                config: indexer.config, util: indexer.util, mapper: indexer.mapper,
                decoderDb: indexer.decoderDb, indexerDb: indexer.indexerDb,
                actionExecute: executeStub,
                protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(synthActive) },
            });
        }

        const poll = {
            action_index: 33, callback_contract_index: 8, callback_method: 'onPoll',
            callback_params: '[]', tick_id: null,
        };
        const data = { BLOCK_INDEX: 130, BLOCK_TIME: 1700000600, ACTION_INDEX: 88 };
        const result = {
            poll_status: 'decided', winning_option: 1, total_counted_weight: '10',
            total_voters: 3, quorum_met: true, min_voters_met: true,
        };

        it('post-flag-day the injected context carries the VOTECB synthetic TX_HASH', async function () {
            makeHandler(true);
            await handler._injectCallbackExecute(poll, data, result);
            const ctx = executeStub.parse.firstCall.args[1];
            assert.strictEqual(ctx.TX_HASH,
                sha256hex('VOTECB:' + indexer.config['NETWORK'] + ':' + indexer.config['CHAIN'] + ':' + poll.action_index));
            assert.strictEqual(ctx.IS_EMISSION, true);
            assert.strictEqual(ctx.EMITTER, 88);
            assert.strictEqual(ctx.SOURCE, 'C:' + indexer.config['CHAIN'] + ':8');
        });

        it('pre-flag-day the legacy hashless context is preserved byte-identically', async function () {
            makeHandler(false);
            await handler._injectCallbackExecute(poll, data, result);
            const ctx = executeStub.parse.firstCall.args[1];
            assert.ok(!('TX_HASH' in ctx), 'pre-activation context must stay hashless (replay safety)');
        });
    });

    describe('xcall result callback (live-consensus byte parity)', function () {
        it('the builder-produced TX_HASH is byte-identical to the pre- inline XCALLCB synthesis', async function () {
            const indexer = createMockIndexer();
            indexer.indexerDb.createActionIndex   = sinon.stub().resolves(700);
            indexer.indexerDb.createSavepoint     = sinon.stub().resolves('sp');
            indexer.indexerDb.releaseSavepoint    = sinon.stub().resolves();
            indexer.indexerDb.rollbackToSavepoint = sinon.stub().resolves();
            const executeStub = { parse: sinon.stub().resolves() };
            const handler = new Xcall({
                config: indexer.config, util: indexer.util, mapper: indexer.mapper,
                decoderDb: indexer.decoderDb, indexerDb: indexer.indexerDb,
                actionExecute: executeStub,
                protocolChanges: indexer.protocolChanges,
            });
            const request = {
                call_id: 'c'.repeat(64), contract_index: 4, callback_method: 'onXcall',
                callback_params_json: '[]', target_chain: 'LTC', cross_hops: 1,
            };
            const contextData = { BLOCK_INDEX: 140, BLOCK_TIME: 1700000700, ACTION_INDEX: 99 };
            await handler._injectCallback(request, contextData, 'ok', 'payload');
            const ctx = executeStub.parse.firstCall.args[1];
            // The exact legacy inline expression, char for char: a drift here forks live chains.
            const legacy = crypto.createHash('sha256').update(
                'XCALLCB:' + String(indexer.config['NETWORK']) + ':' + indexer.config['CHAIN'] + ':' + request.call_id
            ).digest('hex');
            assert.strictEqual(ctx.TX_HASH, legacy);
            assert.strictEqual(ctx.CROSS_HOPS, 1);
            assert.strictEqual(ctx.CALL_DEPTH, 0);
        });
    });

    describe('execute.js host-side assert', function () {
        const Execute = require('../../../src/actions/execute.js');

        function makeExecute(synthActive) {
            const indexer = createMockIndexer();
            indexer.indexerDb.createContractExecution = sinon.stub().resolves();
            const handler = new Execute({
                config: indexer.config, util: indexer.util, mapper: indexer.mapper,
                decoderDb: indexer.decoderDb, indexerDb: indexer.indexerDb,
                protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(synthActive) },
            });
            return { indexer, handler };
        }

        it('post-flag-day a hashless injected context throws the EXEC_CONTEXT_TX_HASH_MISSING fault', async function () {
            const { handler } = makeExecute(true);
            const data = createBaseData({ ACTION: 'EXECUTE', IS_EMISSION: true, TX_HASH: undefined });
            await assert.rejects(
                () => handler.parse(['0', '5', 'm'], data, null),
                (e) => e.code === 'EXEC_CONTEXT_TX_HASH_MISSING');
        });

        it('pre-flag-day a hashless injected context does not trip the assert', async function () {
            const { indexer, handler } = makeExecute(false);
            indexer.indexerDb.getContract = sinon.stub().resolves(null); // stop early with a normal verdict
            const data = createBaseData({ ACTION: 'EXECUTE', IS_EMISSION: true, TX_HASH: undefined });
            await handler.parse(['0', '5', 'm'], data, null);
            assert.ok(String(data['STATUS'] || '').indexOf('EXEC_CONTEXT') === -1);
        });

        it('a context with TX_HASH never trips the assert', async function () {
            const { indexer, handler } = makeExecute(true);
            indexer.indexerDb.getContract = sinon.stub().resolves(null);
            const data = createBaseData({ ACTION: 'EXECUTE', IS_EMISSION: true });
            await handler.parse(['0', '5', 'm'], data, null);
        });

        it('faultGuard classifies the assert as an infra fault (rethrows)', function () {
            const e = new Error('regressed injector');
            e.code = 'EXEC_CONTEXT_TX_HASH_MISSING';
            assert.throws(() => rethrowIfInfraFault(e), /regressed injector/);
            // and still swallows a plain deterministic contract failure
            rethrowIfInfraFault(new Error('contract reverted'));
        });
    });

    describe('protocol_changes registration', function () {
        it('SYNTH_EXEC_TX_HASH is registered on the ratified 2026-08-07 anchor, regtest/testnet genesis', function () {
            const fs = require('fs');
            const path = require('path');
            const src = fs.readFileSync(path.join(__dirname, '../../../src/protocol_changes.js'), 'utf8');
            const m = src.match(/this\.addChange\('SYNTH_EXEC_TX_HASH', '2\.0\.0',(\d+),(\d+),(\d+)/);
            assert.ok(m, 'SYNTH_EXEC_TX_HASH must be registered as a 2.0.0 time-gated change');
            assert.strictEqual(parseInt(m[1]), 1786060800, 'mainnet timestamp must be the ratified anchor');
            assert.strictEqual(parseInt(m[2]), 0, 'testnet activates at genesis');
            assert.strictEqual(parseInt(m[3]), 0, 'regtest activates at genesis');
        });

        it('the exported gate name and tags are stable consensus identifiers', function () {
            assert.strictEqual(SYNTH_EXEC_TX_HASH, 'SYNTH_EXEC_TX_HASH');
            assert.deepStrictEqual(SYNTH_TAGS, {
                ATTEST_EXPIRE_CALLBACK: 'ATTESTEXPCB',
                VOTE_CALLBACK:          'VOTECB',
                XCALL_CALLBACK:         'XCALLCB',
            });
            assert.strictEqual(synthesizeTxHash('XCALLCB', 'regtest', 'BTC', 'x'),
                sha256hex('XCALLCB:regtest:BTC:x'));
        });
    });
});
