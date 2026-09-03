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
// Callback-injection infra-fault propagation (halt-vs-swallow, consensus).
//
// The XCALL and ATTEST callback catches used to swallow EVERY error with a
// console.warn. That is correct only for a deterministic contract failure
// (rolled back to the callback savepoint, verdict stands identically on every
// node). An INFRASTRUCTURE fault handled the same way - the VM host executor
// being down (HostFaultError, code EXECUTOR_UNAVAILABLE) or a MariaDB
// driver-level errno (deadlock 1213, lock-wait 1205) - commits a block on THIS
// validator with the callback's state effects silently missing while healthy
// peers apply them, forking contract_hash. These tests pin the faultGuard gate
// (src/actions/faultGuard.js) at every previously-swallowing catch:
//   - xcall.js  v2 expiry callback + processResult callback
//   - attest.js v1 response callback + v2 expiry callback + missed_count stats
// Deterministic callback failures must STILL be swallowed (verdict stands).

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Xcall   = require('../../../src/actions/xcall.js');
const Attest  = require('../../../src/actions/attest.js');
const ed25519 = require('../../../src/ed25519.js');
const swq     = require('../../../src/stake_weighted_quorum.js');

const PUBKEY_A = 'a'.repeat(64);
const SIG_A    = '1'.repeat(128);
const CALL_ID  = 'c'.repeat(64);
const REQ_ID   = 'd'.repeat(64);

// Mirror of xchain-vm HostFaultError (no xchain-vm dependency here).
class HostFaultError extends Error {
    constructor(){ super('executor unavailable'); this.name = 'HostFaultError'; this.code = 'EXECUTOR_UNAVAILABLE'; }
}
// MariaDB driver-level fault (deadlock).
function dbFault(errno){ const e = new Error('driver fault ' + errno); e.errno = errno; return e; }

const isHostFault = (e) => e && e.code === 'EXECUTOR_UNAVAILABLE';
const isErrno     = (n) => (e) => e && e.errno === n;

describe('Callback injection infra-fault propagation @regression @tier2', function () {

    afterEach(function () { sinon.restore(); });

    // ---------------- XCALL ----------------
    describe('XCALL (xcall.js)', function () {
        let indexer, handler, executeStub;

        function makeRequestRow(overrides = {}) {
            return {
                call_id: CALL_ID, contract_index: 5, target_chain: 'DOGE',
                target_contract_index: 99, method: 'onArrival', params_json: '["x"]',
                gas_limit: 50000, cross_hops: 1, callback_method: 'onResult',
                callback_params_json: '["ctx"]', deadline_block: 300,
                request_status: 'pending', block_index: 100, ...overrides,
            };
        }
        function makeResultRow(overrides = {}) {
            return {
                call_id: CALL_ID, phase: 'result', snapshot_block: 150,
                network: 'regtest', source_chain: 'BTC', target_chain: 'DOGE',
                result_status: 'ok',
                return_payload_b64: Buffer.from('"42"', 'utf8').toString('base64'),
                effective_time: 1700000000,
                validator_signatures: JSON.stringify([{ pubkey: PUBKEY_A, sig: SIG_A }]),
                ...overrides,
            };
        }

        beforeEach(function () {
            indexer = createMockIndexer();
            const db = indexer.indexerDb;
            db.getContract                       = sinon.stub().resolves({ contract_index: 5 });
            db.getCrossChainCallRequestById      = sinon.stub().resolves(makeRequestRow());
            db.updateCrossChainCallRequestStatus = sinon.stub().resolves();
            db.setCrossChainCallCallbackIndex    = sinon.stub().resolves();
            db.recordCrossChainCallCallback      = sinon.stub().resolves();
            db.getValidatorsByCapability         = sinon.stub().resolves([{ pubkey: PUBKEY_A }]);
            db.getStakeWeightsByCapability       = sinon.stub().resolves([{ pubkey: PUBKEY_A, source: 'S1', weight: '100' }]);
            db.createSavepoint                   = sinon.stub().resolves('sp1');
            db.releaseSavepoint                  = sinon.stub().resolves();
            db.rollbackToSavepoint               = sinon.stub().resolves();
            executeStub = { parse: sinon.stub().resolves() };
            handler = new Xcall({
                config: indexer.config, util: indexer.util, mapper: indexer.mapper,
                decoderDb: indexer.decoderDb, indexerDb: indexer.indexerDb,
                actionExecute: executeStub,
            });
            indexer.util.resetLists();
        });

        const v2Data = () => createBaseData({
            ACTION: 'XCALL', FORMAT: 2, IS_SYNTHETIC: true, CALL_ID, BLOCK_INDEX: 301,
        });
        const resultCtx = () => ({ BLOCK_INDEX: 200, BLOCK_TIME: 1700000100 });

        it('v2 expiry: a VM host fault in the callback PROPAGATES (block halts)', async function () {
            executeStub.parse.rejects(new HostFaultError());
            await assert.rejects(handler.parse(['2', CALL_ID], v2Data(), null), isHostFault);
        });

        it('v2 expiry: a DB driver fault (deadlock 1213) in the callback PROPAGATES', async function () {
            executeStub.parse.rejects(dbFault(1213));
            await assert.rejects(handler.parse(['2', CALL_ID], v2Data(), null), isErrno(1213));
        });

        it('v2 expiry: a deterministic callback failure is still swallowed (verdict stands)', async function () {
            executeStub.parse.rejects(new Error('contract reverted'));
            const data = v2Data();
            await handler.parse(['2', CALL_ID], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.rollbackToSavepoint.calledOnce);
        });

        it('processResult: a VM host fault in the callback PROPAGATES (block halts)', async function () {
            sinon.stub(ed25519, 'verify').returns(true);
            executeStub.parse.rejects(new HostFaultError());
            await assert.rejects(handler.processResult(makeResultRow(), resultCtx()), isHostFault);
        });

        it('processResult: a DB driver fault (lock-wait 1205) in the callback PROPAGATES', async function () {
            sinon.stub(ed25519, 'verify').returns(true);
            executeStub.parse.rejects(dbFault(1205));
            await assert.rejects(handler.processResult(makeResultRow(), resultCtx()), isErrno(1205));
        });

        it('processResult: a deterministic callback failure is still swallowed (flip + idempotency stand)', async function () {
            sinon.stub(ed25519, 'verify').returns(true);
            executeStub.parse.rejects(new Error('contract reverted'));
            await handler.processResult(makeResultRow(), resultCtx());
            assert.ok(indexer.indexerDb.updateCrossChainCallRequestStatus.calledOnce);
            assert.ok(indexer.indexerDb.recordCrossChainCallCallback.calledOnce);
        });
    });

    // ---------------- ATTEST ----------------
    describe('ATTEST (attest.js)', function () {
        let indexer, handler, executeStub;

        function makeRequestRow(overrides = {}) {
            return {
                request_id: REQ_ID, provider_id: 'http_get', request_status: 'pending',
                deadline_block: 200, block_index: 90, redundancy: 1, contract_index: 5,
                callback_method: 'onResult', callback_params_json: '[]', ...overrides,
            };
        }

        beforeEach(function () {
            indexer = createMockIndexer();
            const db = indexer.indexerDb;
            db.getContract                         = sinon.stub().resolves({ contract_index: 5 });
            db.getAttestationAdmissionCounts = sinon.stub().resolves({ total: 0, byContract: 0 });
            db.getAttestationRequestById           = sinon.stub().resolves(makeRequestRow());
            db.hasCapability                       = sinon.stub().resolves(true);
            db.createAttestationResponse           = sinon.stub().resolves();
            db.incrementAttestationValidatorStat   = sinon.stub().resolves();
            db.updateAttestationRequestStatus      = sinon.stub().resolves();
            db.setAttestationResponseCallbackIndex = sinon.stub().resolves();
            db.getValidatorsByCapability           = sinon.stub().resolves([{ pubkey: PUBKEY_A }]);
            db.getStakeWeightsByCapability         = sinon.stub().resolves([{ pubkey: PUBKEY_A, source: 'SA', weight: '100' }]);
            db.createValidatorReward               = sinon.stub().resolves(true);
            db.createSavepoint                     = sinon.stub().resolves('sp1');
            db.releaseSavepoint                    = sinon.stub().resolves();
            db.rollbackToSavepoint                 = sinon.stub().resolves();
            executeStub = { parse: sinon.stub().resolves() };
            handler = new Attest({
                config: indexer.config, util: indexer.util, mapper: indexer.mapper,
                decoderDb: indexer.decoderDb, indexerDb: indexer.indexerDb,
                actionExecute: executeStub,
                protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
            });
            indexer.util.resetLists();
            // Legacy COUNT path for the responsible set (matches attest.test.js default).
            sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
            // And the response-mirror flag day, armed on regtest at genesis: above it the
            // chain handler refuses an on-chain v1 outright, so a callback is never
            // injected and there is no fault to propagate. These cases are the legacy
            // era's (matches attest.test.js default).
            sinon.stub(require('../../../src/attest_response_mirror_activation.js'),
                       'isResponseMirrorActive').returns(false);
        });

        const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
        const v1Data   = () => createBaseData({ ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: 100, ACTION_INDEX: 7 });
        const v1Params = () => ['1', REQ_ID, 'http_get', b64('hello'), 'ok', 'm', '1', PUBKEY_A, SIG_A];
        const v2Data   = () => createBaseData({ ACTION: 'ATTEST', FORMAT: 2, BLOCK_INDEX: 250, REQUEST_ID: REQ_ID, IS_SYNTHETIC: true });

        it('v1 response: a VM host fault in the callback PROPAGATES (block halts)', async function () {
            sinon.stub(ed25519, 'verify').returns(true);
            executeStub.parse.rejects(new HostFaultError());
            await assert.rejects(handler.parse(v1Params(), v1Data(), null), isHostFault);
        });

        it('v1 response: a DB driver fault (deadlock 1213) in the callback PROPAGATES', async function () {
            sinon.stub(ed25519, 'verify').returns(true);
            executeStub.parse.rejects(dbFault(1213));
            await assert.rejects(handler.parse(v1Params(), v1Data(), null), isErrno(1213));
        });

        it('v1 response: a deterministic callback failure is still swallowed (response stands)', async function () {
            sinon.stub(ed25519, 'verify').returns(true);
            executeStub.parse.rejects(new Error('contract reverted'));
            const data = v1Data();
            await handler.parse(v1Params(), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.rollbackToSavepoint.calledOnce);
        });

        it('v2 expiry: a VM host fault in the expiry callback PROPAGATES (block halts)', async function () {
            executeStub.parse.rejects(new HostFaultError());
            await assert.rejects(handler.parse(['2', REQ_ID], v2Data(), null), isHostFault);
        });

        it('v2 expiry: a DB driver fault in the expiry callback PROPAGATES', async function () {
            executeStub.parse.rejects(dbFault(1205));
            await assert.rejects(handler.parse(['2', REQ_ID], v2Data(), null), isErrno(1205));
        });

        it('v2 expiry: a deterministic expiry-callback failure is still swallowed (expiry stands)', async function () {
            executeStub.parse.rejects(new Error('contract reverted'));
            const data = v2Data();
            await handler.parse(['2', REQ_ID], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.calledOnce);
        });

        it('v2 expiry: a DB driver fault updating missed_count PROPAGATES', async function () {
            indexer.indexerDb.incrementAttestationValidatorStat.rejects(dbFault(1213));
            await assert.rejects(handler.parse(['2', REQ_ID], v2Data(), null), isErrno(1213));
        });

        it('v2 expiry: an older-schema gap (errno 1146) in missed_count is still absorbed', async function () {
            indexer.indexerDb.incrementAttestationValidatorStat.rejects(dbFault(1146));
            const data = v2Data();
            await handler.parse(['2', REQ_ID], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(executeStub.parse.calledOnce, 'expiry callback still injected');
        });
    });
});
