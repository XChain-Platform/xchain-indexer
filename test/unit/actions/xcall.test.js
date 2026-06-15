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
const crypto = require('crypto');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Xcall   = require('../../../src/actions/xcall.js');
// Same module instance Xcall holds a reference to — stubbing `verify` here
// controls signature acceptance inside processResult.
const ed25519 = require('../../../src/ed25519.js');
const eq      = require('../../../src/equivocation_header.js');

const PUBKEY_A = 'a'.repeat(64);
const SIG_A    = '1'.repeat(128);

// Mirror the handler's deterministic call_id derivation — MUST byte-match
// xchain-vm/src/gateway-emit.js (crossExecute).
const deriveCallId = (network, chain, txHash, contractIndex, position, targetChain) =>
    crypto.createHash('sha256')
        .update([network, chain, txHash, contractIndex, position, targetChain].map(String).join(':'))
        .digest('hex');

describe('Xcall (XCALL) @regression @tier3', function () {
    let indexer, actionsCtx, handler, executeStub;

    function addXcallDbStubs(db) {
        db.getContract                        = sinon.stub().resolves({ contract_index: 5 });
        db.createCrossChainCallRequest        = sinon.stub().resolves();
        db.getCrossChainCallRequestById       = sinon.stub().resolves(null);
        db.updateCrossChainCallRequestStatus  = sinon.stub().resolves();
        db.setCrossChainCallCallbackIndex     = sinon.stub().resolves();
        db.recordCrossChainCallCallback       = sinon.stub().resolves();
        db.hasCapability                      = sinon.stub().resolves(true);
        db.getValidatorsByCapability          = sinon.stub().resolves([{ pubkey: PUBKEY_A }]);
        // regtest activates STAKE_WEIGHTED_QUORUM at genesis, so processResult takes the
        // stake-weighted branch (getStakeWeightsByCapability + meetsStakeThreshold). One
        // validator = one source: 3·tally(100) > 2·S(100) iff that signer is valid, so the
        // weighted rule reproduces the single-validator legacy outcome these tests assert.
        db.getStakeWeightsByCapability        = sinon.stub().resolves([{ pubkey: PUBKEY_A, source: 'S1', weight: '100' }]);
        db.createSavepoint                    = sinon.stub().resolves('sp1');
        db.releaseSavepoint                   = sinon.stub().resolves();
        db.rollbackToSavepoint                = sinon.stub().resolves();
    }

    function makeRequestRow(overrides = {}) {
        return {
            call_id:               'c'.repeat(64),
            contract_index:        5,
            target_chain:          'DOGE',
            target_contract_index: 99,
            method:                'onArrival',
            params_json:           '["x"]',
            gas_limit:             50000,
            cross_hops:            1,
            callback_method:       'onResult',
            callback_params_json:  '["ctx"]',
            deadline_block:        300,
            request_status:        'pending',
            block_index:           100,
            ...overrides,
        };
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        addXcallDbStubs(indexer.indexerDb);
        executeStub = { parse: sinon.stub().resolves() };
        actionsCtx = {
            config:        indexer.config,
            util:          indexer.util,
            mapper:        indexer.mapper,
            decoderDb:     indexer.decoderDb,
            indexerDb:     indexer.indexerDb,
            actionExecute: executeStub,
        };
        handler = new Xcall(actionsCtx);
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    // ───────────────────────────────────────────────────────────────────────
    // v0 — Request (VM emission only)
    // ───────────────────────────────────────────────────────────────────────
    describe('v0 — request', function () {

        function v0Data(overrides = {}) {
            return createBaseData({
                ACTION: 'XCALL', FORMAT: 0, IS_EMISSION: true, EMITTER: 5,
                EMITTER_POSITION: 0, BLOCK_INDEX: 100,
                ...overrides,
            });
        }
        // VERSION|CALL_ID|TARGET_CHAIN|TARGET_CONTRACT_INDEX|METHOD|PARAMS_JSON|GAS_LIMIT|CALLBACK_METHOD|CALLBACK_PARAMS_JSON|DEADLINE_BLOCKS|CROSS_HOPS
        function v0Params(callId, overrides = {}) {
            const p = {
                targetChain: 'DOGE', targetIdx: '99', method: 'onArrival',
                paramsJson: '["x"]', gasLimit: '50000', cb: 'onResult',
                cbParams: '["ctx"]', deadline: '200', hops: '1',
                ...overrides,
            };
            return ['0', callId, p.targetChain, p.targetIdx, p.method, p.paramsJson,
                    p.gasLimit, p.cb, p.cbParams, p.deadline, p.hops];
        }
        const goodCallId = (data) =>
            deriveCallId('regtest', 'BTC', data['TX_HASH'],
                         data['EMITTER'], data['EMITTER_POSITION'], 'DOGE');

        it('valid request → STATUS valid, createCrossChainCallRequest called with the derived deadline', async function () {
            const data = v0Data();
            await handler.parse(v0Params(goodCallId(data)), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['DEADLINE_BLOCK'], 300);          // 100 + 200
            assert.ok(indexer.indexerDb.createCrossChainCallRequest.calledOnce);
        });

        it('rejects a user-initiated (non-emission) request', async function () {
            const data = v0Data({ IS_EMISSION: undefined });
            await handler.parse(v0Params(goodCallId(data)), data, null);
            assert.match(data['STATUS'], /must originate from VM emission/);
        });

        it('rejects a CALL_ID that does not match the deterministic derivation', async function () {
            const data = v0Data();
            await handler.parse(v0Params('e'.repeat(64)), data, null);
            assert.match(data['STATUS'], /CALL_ID \(does not match/);
        });

        it('the derivation binds network + source chain + target chain', async function () {
            const data = v0Data();
            // Same inputs but derived for LTC target — must be rejected for a DOGE call.
            const wrongTarget = deriveCallId('regtest', 'BTC', data['TX_HASH'],
                data['EMITTER'], data['EMITTER_POSITION'], 'LTC');
            await handler.parse(v0Params(wrongTarget), data, null);
            assert.match(data['STATUS'], /CALL_ID \(does not match/);
        });

        it('hard-fails when EMITTER_POSITION is missing (no silent derivation bypass)', async function () {
            const data = v0Data({ EMITTER_POSITION: undefined });
            await handler.parse(v0Params('e'.repeat(64)), data, null);
            assert.match(data['STATUS'], /EMITTER_POSITION/);
        });

        it('rejects targeting this indexer\'s own chain', async function () {
            const data = v0Data();
            const id = deriveCallId('regtest', 'BTC', data['TX_HASH'],
                data['EMITTER'], data['EMITTER_POSITION'], 'BTC');
            await handler.parse(v0Params(id, { targetChain: 'BTC' }), data, null);
            assert.match(data['STATUS'], /TARGET_CHAIN \(must differ/);
        });

        it('re-validates gasLimit, hops, deadline and params host-side', async function () {
            for (const [overrides, re] of [
                [{ gasLimit: '4999' },   /GAS_LIMIT/],
                [{ gasLimit: '200001' }, /GAS_LIMIT/],
                [{ hops: '3' },          /CROSS_HOPS/],
                [{ hops: '0' },          /CROSS_HOPS/],
                [{ deadline: '5' },      /DEADLINE_BLOCKS/],
                [{ deadline: '4001' },   /DEADLINE_BLOCKS/],
                [{ paramsJson: 'nope' }, /PARAMS_JSON/],
            ]) {
                const data = v0Data();
                await handler.parse(v0Params(goodCallId(data), overrides), data, null);
                assert.match(data['STATUS'], re, JSON.stringify(overrides));
            }
        });

        it('rejects an unknown emitter contract', async function () {
            indexer.indexerDb.getContract.resolves(null);
            const data = v0Data();
            await handler.parse(v0Params(goodCallId(data)), data, null);
            assert.match(data['STATUS'], /CONTRACT_INDEX \(unknown\)/);
        });

        // ── Input-validation rejection paths (pre-quorum; no stake-weighted branch) ──
        // Validation is sequential (first error wins), so each case keeps every earlier
        // field valid and trips exactly one rule. A valid-format CALL_ID ('a'×64) is used
        // where the rejection fires before the derivation check (which never runs then).

        it('rejects a CALL_ID that is not 64-hex (format)', async function () {
            const data = v0Data();
            await handler.parse(v0Params('not-a-valid-call-id'), data, null);
            assert.match(data['STATUS'], /CALL_ID \(format\)/);
        });

        it('rejects a TARGET_CHAIN outside the allow-list', async function () {
            const data = v0Data();
            await handler.parse(v0Params('a'.repeat(64), { targetChain: 'ETH' }), data, null);
            assert.match(data['STATUS'], /TARGET_CHAIN \(unknown\)/);
        });

        it('rejects a non-positive TARGET_CONTRACT_INDEX', async function () {
            for (const idx of ['0', '-1']) {
                const data = v0Data();
                await handler.parse(v0Params('a'.repeat(64), { targetIdx: idx }), data, null);
                assert.match(data['STATUS'], /TARGET_CONTRACT_INDEX/, 'idx=' + idx);
            }
        });

        it('rejects a missing METHOD', async function () {
            const data = v0Data();
            await handler.parse(v0Params(goodCallId(data), { method: null }), data, null);
            assert.match(data['STATUS'], /METHOD \(required\)/);
        });

        it('rejects a METHOD longer than 64 bytes', async function () {
            const data = v0Data();
            await handler.parse(v0Params(goodCallId(data), { method: 'm'.repeat(65) }), data, null);
            assert.match(data['STATUS'], /METHOD \(too long\)/);
        });

        it('rejects a missing CALLBACK_METHOD', async function () {
            const data = v0Data();
            await handler.parse(v0Params(goodCallId(data), { cb: null }), data, null);
            assert.match(data['STATUS'], /CALLBACK_METHOD \(required\)/);
        });

        it('rejects a CALLBACK_METHOD longer than 64 bytes', async function () {
            const data = v0Data();
            await handler.parse(v0Params(goodCallId(data), { cb: 'c'.repeat(65) }), data, null);
            assert.match(data['STATUS'], /CALLBACK_METHOD \(too long\)/);
        });

        it('rejects PARAMS_JSON with more than 32 entries', async function () {
            const data = v0Data();
            await handler.parse(v0Params('a'.repeat(64), { paramsJson: JSON.stringify(Array(33).fill('x')) }), data, null);
            assert.match(data['STATUS'], /PARAMS_JSON/);
        });

        it('rejects a PARAMS_JSON entry larger than 1024 bytes', async function () {
            const data = v0Data();
            await handler.parse(v0Params('a'.repeat(64), { paramsJson: JSON.stringify(['x'.repeat(1025)]) }), data, null);
            assert.match(data['STATUS'], /PARAMS_JSON/);
        });

        it('hard-fails when the emitter (CONTRACT_INDEX) is absent', async function () {
            const data = v0Data({ EMITTER: undefined });
            await handler.parse(v0Params('a'.repeat(64)), data, null);
            assert.match(data['STATUS'], /CONTRACT_INDEX \(missing emitter\)/);
        });

        it('hard-fails when TX_HASH is missing (no silent derivation bypass)', async function () {
            const data = v0Data({ TX_HASH: undefined });
            await handler.parse(v0Params('a'.repeat(64)), data, null);
            assert.match(data['STATUS'], /TX_HASH/);
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // v2 — Expire (system-synthesized) + exactly-once interlock
    // ───────────────────────────────────────────────────────────────────────
    describe('v2 — expire', function () {

        function v2Data(overrides = {}) {
            return createBaseData({
                ACTION: 'XCALL', FORMAT: 2, IS_SYNTHETIC: true,
                CALL_ID: 'c'.repeat(64), BLOCK_INDEX: 301,
                ...overrides,
            });
        }

        it('flips a pending request to expired BEFORE injecting the callback (interlock order)', async function () {
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow());
            const data = v2Data();
            await handler.parse(['2', 'c'.repeat(64)], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            const flip = indexer.indexerDb.updateCrossChainCallRequestStatus;
            assert.ok(flip.calledOnceWith('c'.repeat(64), 'expired', 'expired', '', 301));
            assert.ok(flip.calledBefore(executeStub.parse));
            // Callback delivered with status='expired', empty payload, echoed params.
            const cbParams = executeStub.parse.firstCall.args[0];
            assert.deepStrictEqual(cbParams.slice(0, 3), [0, 5, 'onResult']);
            assert.deepStrictEqual(cbParams.slice(3), ['c'.repeat(64), 'DOGE', 'expired', '', 'ctx']);
        });

        it('the callback runs under the fixed XCALL callback ceiling at depth 0 with the call\'s hops', async function () {
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow());
            await handler.parse(['2', 'c'.repeat(64)], v2Data(), null);
            const emissionData = executeStub.parse.firstCall.args[1];
            assert.strictEqual(emissionData['VM_GAS_LIMIT'], 20000);
            assert.strictEqual(emissionData['CALL_DEPTH'], 0);
            assert.strictEqual(emissionData['CROSS_HOPS'], 1);
            assert.ok(emissionData['IS_EMISSION']);
            assert.match(emissionData['TX_HASH'], /^[0-9a-f]{64}$/); // synthetic, namespaced
        });

        it('is a no-op when the request is already terminal (race-protected)', async function () {
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow({ request_status: 'completed' }));
            const data = v2Data();
            await handler.parse(['2', 'c'.repeat(64)], data, null);
            assert.ok(indexer.indexerDb.updateCrossChainCallRequestStatus.notCalled);
            assert.ok(executeStub.parse.notCalled);
        });

        it('rejects user-broadcast v2 (must be system-synthesized)', async function () {
            const data = v2Data({ IS_SYNTHETIC: undefined });
            await handler.parse(['2', 'c'.repeat(64)], data, null);
            assert.match(data['STATUS'], /must be system-synthesized/);
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // processResult — mirror-driven result delivery
    // ───────────────────────────────────────────────────────────────────────
    describe('processResult', function () {

        function makeResultRow(overrides = {}) {
            return {
                call_id:              'c'.repeat(64),
                phase:                'result',
                snapshot_block:       150,
                network:              'regtest',
                source_chain:         'BTC',
                target_chain:         'DOGE',
                result_status:        'ok',
                return_payload_b64:   Buffer.from('"42"', 'utf8').toString('base64'),
                effective_time:       1700000000,
                validator_signatures: JSON.stringify([{ pubkey: PUBKEY_A, sig: SIG_A }]),
                ...overrides,
            };
        }
        const ctx = () => ({ BLOCK_INDEX: 200, BLOCK_TIME: 1700000100 });

        it('verifies sigs, flips to completed, injects the callback with the decoded payload', async function () {
            sinon.stub(ed25519, 'verify').returns(true);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow());
            const data = ctx();
            await handler.processResult(makeResultRow(), data);
            const flip = indexer.indexerDb.updateCrossChainCallRequestStatus;
            assert.ok(flip.calledOnceWith('c'.repeat(64), 'completed', 'ok', '"42"', 200));
            assert.ok(flip.calledBefore(executeStub.parse));
            const cbParams = executeStub.parse.firstCall.args[0];
            assert.deepStrictEqual(cbParams.slice(3), ['c'.repeat(64), 'DOGE', 'ok', '"42"', 'ctx']);
            assert.ok(indexer.indexerDb.recordCrossChainCallCallback.calledOnceWith(
                sinon.match.any, 'c'.repeat(64), 'ok', 200));
        });

        it('the signed canonical binds result_status + payload hash (sig verified over the exact string)', async function () {
            const stub = sinon.stub(ed25519, 'verify').returns(true);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow());
            const row = makeResultRow();
            await handler.processResult(row, ctx());
            const expectedRaw = [
                'XCALL', 'RESULT', row.call_id, '150', 'regtest', 'DOGE', 'ok',
                crypto.createHash('sha256').update(row.return_payload_b64, 'utf8').digest('hex'),
                '1700000000'
            ].join('|');
            // EQUIV active in regtest: TAG=XCALL, ROUND_ID=sha256('XCALLROUND|result|'+call_id), VIEW=0.
            const expected = eq.buildEquivCanonical(eq.ENGINE_TAGS.XCALL,
                crypto.createHash('sha256').update('XCALLROUND|result|' + row.call_id, 'utf8').digest('hex'), 0, expectedRaw);
            assert.strictEqual(stub.firstCall.args[0], expected);
        });

        it('refuses insufficient signatures (nothing flips, nothing injects, NO idempotency row)', async function () {
            sinon.stub(ed25519, 'verify').returns(false);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow());
            await handler.processResult(makeResultRow(), ctx());
            assert.ok(indexer.indexerDb.updateCrossChainCallRequestStatus.notCalled);
            assert.ok(executeStub.parse.notCalled);
            assert.ok(indexer.indexerDb.recordCrossChainCallCallback.notCalled);
        });

        it('defers (no idempotency row) when the capability snapshot is not mirrored yet', async function () {
            // Empty BOTH sets — the stake-weighted branch (active on regtest) reads
            // getStakeWeightsByCapability; clearing only the legacy set would not defer.
            indexer.indexerDb.getValidatorsByCapability.resolves([]);
            indexer.indexerDb.getStakeWeightsByCapability.resolves([]);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow());
            await handler.processResult(makeResultRow(), ctx());
            assert.ok(indexer.indexerDb.recordCrossChainCallCallback.notCalled);
        });

        it('records a skip (exactly-once interlock) when the request already expired', async function () {
            sinon.stub(ed25519, 'verify').returns(true);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow({ request_status: 'expired' }));
            await handler.processResult(makeResultRow(), ctx());
            assert.ok(executeStub.parse.notCalled);
            assert.ok(indexer.indexerDb.updateCrossChainCallRequestStatus.notCalled);
            assert.ok(indexer.indexerDb.recordCrossChainCallCallback.calledOnceWith(
                sinon.match.any, 'c'.repeat(64), 'skipped:expired', 200));
        });

        it('skips a result whose target_chain does not match the local request (forged routing)', async function () {
            sinon.stub(ed25519, 'verify').returns(true);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow({ target_chain: 'LTC' }));
            await handler.processResult(makeResultRow(), ctx());
            assert.ok(executeStub.parse.notCalled);
            assert.ok(indexer.indexerDb.recordCrossChainCallCallback.notCalled);
        });

        it('skips a result for an unknown call_id', async function () {
            sinon.stub(ed25519, 'verify').returns(true);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(null);
            await handler.processResult(makeResultRow(), ctx());
            assert.ok(executeStub.parse.notCalled);
        });

        it('skips a result for another network (belt-and-suspenders)', async function () {
            sinon.stub(ed25519, 'verify').returns(true);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow());
            await handler.processResult(makeResultRow({ network: 'mainnet' }), ctx());
            assert.ok(executeStub.parse.notCalled);
        });

        it('a failing callback does not undo the flip or the idempotency row', async function () {
            sinon.stub(ed25519, 'verify').returns(true);
            indexer.indexerDb.getCrossChainCallRequestById.resolves(makeRequestRow());
            executeStub.parse.rejects(new Error('callback exploded'));
            await handler.processResult(makeResultRow(), ctx());
            assert.ok(indexer.indexerDb.updateCrossChainCallRequestStatus.calledOnce);
            assert.ok(indexer.indexerDb.rollbackToSavepoint.calledOnce);   // callback savepoint only
            assert.ok(indexer.indexerDb.recordCrossChainCallCallback.calledOnce);
        });
    });
});
