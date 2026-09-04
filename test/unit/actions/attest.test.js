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
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Attest  = require('../../../src/actions/attest.js');
const swq     = require('../../../src/stake_weighted_quorum.js');
const attestAdmission = require('../../../src/attest_admission_activation.js');
const attestBcastFee  = require('../../../src/attest_broadcast_fee_activation.js');
const arm     = require('../../../src/attest_response_mirror_activation.js');
const abw     = require('../../../src/attest_batch_wire.js');
const srb     = require('../../../src/snapshot_reorg_buffer.js');
// Same module instance Attest holds a reference to (Node module cache); stubbing
// `verify` here controls signature acceptance inside the handler.
const ed25519 = require('../../../src/ed25519.js');

// 64-hex pubkeys / 128-hex sigs (format-valid; verification is stubbed)
const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const SIG_A    = '1'.repeat(128);
const SIG_B    = '2'.repeat(128);
const REQ_ID   = 'd'.repeat(64);

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// Mirror the handler's deterministic request_id derivation:
//   sha256(tx_hash + ':' + root_action_index + ':' + emitter_path + ':' + contract_index + ':' + emitter_position)
// ROOT_ACTION_INDEX (the per-root discriminator = the deterministic root on-chain
// action_index) is inserted immediately after tx_hash. The emitter call-path
// ('>'-joined per-execution emission positions, root = '') disambiguates nested
// cross-contract runs of the same contract within one tx and is content-derived
// (byte-stable across nodes/reorgs). MUST byte-match xchain-vm/src/gateway.js.
// A legitimate VM emission always supplies a REQUEST_ID equal to this digest.
const deriveReqId = (txHash, rootActionIndex, emitterPath, contractIndex, position) =>
    crypto.createHash('sha256')
        .update(String(txHash) + ':' + String(rootActionIndex) + ':' + String(emitterPath) + ':' + String(contractIndex) + ':' + String(position))
        .digest('hex');

// Cross-repo golden pin for the request_id preimage. This is the checked-in
// (input tuple -> expected hex) vector from xchain-vm/src/gateway-emit.js
// (GOLDEN_VECTORS.requestId). It is a LITERAL constant on purpose: asserting the
// REAL attest handler against it (below) catches a lockstep field-reorder that
// would otherwise pass because the local deriveReqId copy was reordered too. Keep
// in sync with xchain-vm/src/gateway-emit.js; a mismatch is a genuine fleet fork.
const GOLDEN_REQUEST_ID = {
    input: { txHash: 'abc123', rootActionIndex: 100, emitterPath: '', contractIndex: 7, emitterPosition: 0 },
    // sha256('abc123:100::7:0')
    expected: 'b770a548716259f767c3eb6e9e1e5eb0e3878c9ec3d6bbd68a7e1ab8221fffb7'
};

describe('Attest (ATTEST) @regression @tier3', function () {
    let indexer, actionsCtx, handler, executeStub;

    // Extend the default mock DB with the attestation-specific methods attest.js calls.
    function addAttestationDbStubs(db) {
        db.getContract                       = sinon.stub().resolves({ contract_index: 5 });
        db.createAttestationRequest          = sinon.stub().resolves();
        db.getAttestationAdmissionCounts = sinon.stub().resolves({ total: 0, byContract: 0 });
        db.getAttestationRequestById         = sinon.stub().resolves(null);
        db.hasCapability                     = sinon.stub().resolves(true);
        db.createAttestationResponse         = sinon.stub().resolves();
        db.incrementAttestationValidatorStat = sinon.stub().resolves();
        db.updateAttestationRequestStatus    = sinon.stub().resolves();
        db.setAttestationResponseCallbackIndex = sinon.stub().resolves();
        db.getValidatorsByCapability         = sinon.stub().resolves([{ pubkey: PUBKEY_A }]);
        db.getStakeWeightsByCapability       = sinon.stub().resolves([{ pubkey: PUBKEY_A, source: 'SA', weight: '100' }]);
        db.createValidatorReward             = sinon.stub().resolves(true);
        db.createSavepoint                   = sinon.stub().resolves('sp1');
        db.releaseSavepoint                  = sinon.stub().resolves();
        db.rollbackToSavepoint               = sinon.stub().resolves();
    }

    function makeRequestRow(overrides = {}) {
        return {
            request_id:           REQ_ID,
            provider_id:          'http_get',
            request_status:       'pending',
            deadline_block:       200,
            block_index:          90,        // snapshot block (intentionally < response block)
            redundancy:           1,
            contract_index:       5,
            callback_method:      'onResult',
            callback_params_json: '[]',
            ...overrides,
        };
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        addAttestationDbStubs(indexer.indexerDb);

        executeStub = { parse: sinon.stub().resolves() };

        actionsCtx = {
            config:        indexer.config,
            util:          indexer.util,
            mapper:        indexer.mapper,
            decoderDb:     indexer.decoderDb,
            indexerDb:     indexer.indexerDb,
            actionExecute: executeStub,
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true),
            },
        };
        handler = new Attest(actionsCtx);
        indexer.util.resetLists();
        // Default to the legacy COUNT path (per-key responsible set). The
        // source-deduped weighted path has its own describe below. (regtest
        // activates weighting at genesis, so this must be stubbed off here.)
        sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
        // Default the Pkg 7 admission gate OFF (legacy accept-then-expire) so the
        // fixtures' redundancy-3 requests against a 1-validator snapshot stay
        // 'valid'; the gate's own describe below re-enables it. (regtest arms the
        // gate at genesis, so this must be stubbed off here, mirroring swq above.)
        sinon.stub(attestAdmission, 'isAttestAdmissionActive').returns(false);
        // Same treatment for the §11 broadcast-fee carve-out: regtest arms it at genesis, so
        // the fixtures above would otherwise settle through the carve-out path and every
        // legacy split assertion would move. Its own describe below re-enables it.
        sinon.stub(attestBcastFee, 'isAttestBroadcastFeeActive').returns(false);
        // And the response-mirror flag day, which regtest also arms at genesis. Above it
        // an on-chain v1 is rejected outright and the broadcast-fee carve-out is retired,
        // so leaving it armed would move every legacy v1 and fee fixture in this file at
        // once. Both eras have their own describes below.
        sinon.stub(arm, 'isResponseMirrorActive').returns(false);
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('v0: request', function () {

        function v0Data(overrides = {}) {
            // EMITTER_POSITION and EMITTER_PATH are required fields on every
            // legitimate ATTEST v0 emission (set by execute.processEmission); include
            // them by default so the fixture mirrors production. Tests that probe
            // their absence override them back to undefined. EMITTER_PATH '0' models a
            // first-level nested emission; '' (root) is exercised by its own test.
            return createBaseData({
                ACTION: 'ATTEST', FORMAT: 0, IS_EMISSION: true, EMITTER: 5, EMITTER_POSITION: 0,
                EMITTER_PATH: '0', ROOT_ACTION_INDEX: 100, BLOCK_INDEX: 100,
                ...overrides,
            });
        }
        // VERSION|REQUEST_ID|PROVIDER_ID|REQUEST_PAYLOAD|CALLBACK_METHOD|CALLBACK_PARAMS_JSON|REDUNDANCY|DEADLINE_BLOCKS
        function v0Params(overrides = {}) {
            const p = {
                requestId: REQ_ID, providerId: 'http_get', payload: 'q',
                callback: 'onResult', cbParams: '[]', redundancy: '3', deadline: '50',
                ...overrides,
            };
            return ['0', p.requestId, p.providerId, p.payload, p.callback, p.cbParams, p.redundancy, p.deadline];
        }

        it('valid request → STATUS valid and createAttestationRequest called', async function () {
            const data = v0Data();
            // A legitimate emission carries a REQUEST_ID that matches the deterministic
            // derivation over (tx_hash, contract_index, emitter_position).
            const reqId = deriveReqId(data['TX_HASH'], data['ROOT_ACTION_INDEX'], data['EMITTER_PATH'], data['EMITTER'], data['EMITTER_POSITION']);
            await handler.parse(v0Params({ requestId: reqId }), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createAttestationRequest.calledOnce);
        });

        it('golden vector: the REAL handler derives the checked-in xchain-vm request_id hash', async function () {
            // Drive the real handler with the cross-repo golden-vector input and the
            // LITERAL golden hex as the supplied REQUEST_ID. The handler independently
            // re-derives request_id from these fields and accepts only on a byte match,
            // so a 'valid' STATUS proves the real derivation still produces the pinned
            // hex. Unlike the tests above, this assertion does NOT route through the
            // local deriveReqId lambda, so a lockstep field-reorder of BOTH the real
            // handler and the lambda can no longer pass silently (closes).
            const gv   = GOLDEN_REQUEST_ID.input;
            const data = v0Data({
                TX_HASH: gv.txHash, ROOT_ACTION_INDEX: gv.rootActionIndex,
                EMITTER_PATH: gv.emitterPath, EMITTER: gv.contractIndex,
                EMITTER_POSITION: gv.emitterPosition,
            });
            await handler.parse(v0Params({ requestId: GOLDEN_REQUEST_ID.expected }), data, null);
            assert.strictEqual(data['STATUS'], 'valid',
                'real handler must accept the checked-in golden REQUEST_ID; a rejection means the ' +
                'indexer preimage drifted from xchain-vm/src/gateway-emit.js GOLDEN_VECTORS.requestId');
        });

        it('ATT-RECOMP-1: pins the responsible set AS-OF the request block for a valid request', async function () {
            const data = v0Data();
            const reqId = deriveReqId(data['TX_HASH'], data['ROOT_ACTION_INDEX'], data['EMITTER_PATH'], data['EMITTER'], data['EMITTER_POSITION']);
            await handler.parse(v0Params({ requestId: reqId }), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            // The set is computed as-of the request's OWN block (not a later block), so it
            // captures the historical stake amounts before any future slash. the
            // height it is RESOLVED at is that block BURIED by CANONICAL_REORG_BUFFER,
            // because that is where the hub's CapabilitySnapshot resolved it; regtest arms
            // the burial gate at genesis. The anchor is still the request block, not a
            // later one, which is what ATT-RECOMP-1 is about.
            assert.ok(indexer.indexerDb.getValidatorsByCapability.calledWith(
                    'attestation', srb.buriedSnapshotBlock(data['BLOCK_INDEX'], 'regtest')),
                'responsible set must be computed at the request block, buried by the reorg buffer');
            assert.ok(data['RESPONSIBLE_SET_JSON'], 'responsible_set_json must be set on the persisted data');
            const parsed = JSON.parse(data['RESPONSIBLE_SET_JSON']);
            assert.ok(Array.isArray(parsed) && parsed.includes(PUBKEY_A),
                'persisted set must contain the responsible validator');
            // The persisted value reaches createAttestationRequest for storage.
            assert.strictEqual(
                indexer.indexerDb.createAttestationRequest.firstCall.args[0]['RESPONSIBLE_SET_JSON'],
                data['RESPONSIBLE_SET_JSON']);
        });

        it('ATT-RECOMP-1: does NOT compute a responsible set for a rejected request (no stake query)', async function () {
            const data = v0Data();
            // Unknown provider → structurally rejected → invisible to the expiry sweep, so it
            // never reaches the missed_count recompute; skip the stake query entirely.
            await handler.parse(v0Params({ providerId: 'not_a_provider' }), data, null);
            assert.notStrictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['REQUEST_STATUS'], 'rejected');
            assert.strictEqual(indexer.indexerDb.getValidatorsByCapability.called, false,
                'a rejected request must not compute a responsible set');
            assert.strictEqual(data['RESPONSIBLE_SET_JSON'], undefined);
        });

        it('request_id is independent of ACTION_INDEX (reorg / injection-order stability)', async function () {
            // The defect this guards (#4213): emitted-action action_index is assigned by a
            // global max+1 counter and gets NEW values on reorg replay, so binding it forked
            // the PBFT. The preimage now uses EMITTER_PATH (content-derived) and NO action_index
            // A node that reorged (different ACTION_INDEX) must derive the SAME request_id.
            // ROOT_ACTION_INDEX is the per-root discriminator (fixed at 100); both nodes
            // share it, so request_id depends on the ROOT, not the emission action_index.
            const reqId = deriveReqId('aa', 100, '2>0', 5, 0);   // depends on root/path/position/tx/contract (not action_index)
            const lo = v0Data({ TX_HASH: 'aa', EMITTER: 5, EMITTER_PATH: '2>0', EMITTER_POSITION: 0, ROOT_ACTION_INDEX: 100, ACTION_INDEX: 10 });
            const hi = v0Data({ TX_HASH: 'aa', EMITTER: 5, EMITTER_PATH: '2>0', EMITTER_POSITION: 0, ROOT_ACTION_INDEX: 100, ACTION_INDEX: 99999 });
            await handler.parse(v0Params({ requestId: reqId }), lo, null);
            await handler.parse(v0Params({ requestId: reqId }), hi, null);
            assert.strictEqual(lo['STATUS'], 'valid', 'low action_index node rejected: ' + lo['STATUS']);
            assert.strictEqual(hi['STATUS'], 'valid', 'high action_index node rejected: ' + hi['STATUS']);
        });

        it('rejects a request missing EMITTER_POSITION instead of accepting an unverified REQUEST_ID', async function () {
            // The bug this guards: when EMITTER_POSITION is absent the request_id check used
            // to silently skip, so an arbitrary REQUEST_ID from a compromised/buggy VM was
            // accepted. It must now hard-fail.
            const data = v0Data({ EMITTER_POSITION: undefined });
            await handler.parse(v0Params(), data, null); // arbitrary REQUEST_ID, no position
            assert.notStrictEqual(data['STATUS'], 'valid');
            assert.ok(String(data['STATUS']).includes('EMITTER_POSITION'),
                'expected EMITTER_POSITION rejection, got: ' + data['STATUS']);
        });

        it('rejects a request missing EMITTER_PATH (nested-run disambiguator)', async function () {
            // Cross-contract calls let the same contract run more than once per tx;
            // the emitter call-path is therefore part of the request_id preimage and
            // its absence must hard-fail, never silently bypass.
            const data = v0Data({ EMITTER_PATH: undefined });
            await handler.parse(v0Params(), data, null);
            assert.notStrictEqual(data['STATUS'], 'valid');
            assert.ok(String(data['STATUS']).includes('EMITTER_PATH'),
                'expected EMITTER_PATH rejection, got: ' + data['STATUS']);
        });

        it('rejects a request missing ROOT_ACTION_INDEX (per-root discriminator)', async function () {
            // ROOT_ACTION_INDEX (the deterministic root on-chain action_index) is part of
            // the request_id preimage; its absence must hard-fail, never silently bypass.
            // The guard runs AFTER the EMITTER_PATH check and BEFORE the TX_HASH check.
            const data = v0Data({ ROOT_ACTION_INDEX: undefined });
            await handler.parse(v0Params(), data, null);
            assert.notStrictEqual(data['STATUS'], 'valid');
            assert.ok(String(data['STATUS']).includes('ROOT_ACTION_INDEX'),
                'expected ROOT_ACTION_INDEX rejection, got: ' + data['STATUS']);
        });

        it('accepts a root-level request where EMITTER_PATH is the empty string', async function () {
            // The root on-chain EXECUTE/DEPLOY has call-path '' (a VALID value). The
            // required-field check must test === undefined/null, NOT falsy, or every
            // root-level attestation would be wrongly rejected.
            const data = v0Data({ EMITTER_PATH: '' });
            const reqId = deriveReqId(data['TX_HASH'], data['ROOT_ACTION_INDEX'], '', data['EMITTER'], data['EMITTER_POSITION']);
            await handler.parse(v0Params({ requestId: reqId }), data, null);
            assert.strictEqual(data['STATUS'], 'valid',
                'root-path ("") attestation must be accepted, got: ' + data['STATUS']);
        });

        it('rejects a request when TX_HASH is absent but EMITTER_POSITION is present (line 134)', async function () {
            // EMITTER_POSITION is set (passes the first guard) but TX_HASH is missing
            // → the `else if(!data['TX_HASH'])` branch (line 133-134) fires.
            const data = v0Data({ TX_HASH: null });
            await handler.parse(v0Params(), data, null);
            assert.ok(String(data['STATUS']).includes('TX_HASH'),
                'expected TX_HASH rejection, got: ' + data['STATUS']);
        });

        it('rejects a request whose REQUEST_ID does not match the deterministic derivation', async function () {
            const data = v0Data(); // EMITTER_POSITION present, but REQUEST_ID is arbitrary
            await handler.parse(v0Params({ requestId: REQ_ID }), data, null);
            assert.ok(String(data['STATUS']).includes('deterministic derivation'),
                'expected derivation-mismatch rejection, got: ' + data['STATUS']);
        });

        it('rejects a non-emission (user-broadcast) request', async function () {
            const data = v0Data({ IS_EMISSION: false });
            await handler.parse(v0Params(), data, null);
            assert.ok(String(data['STATUS']).includes('VM emission'));
            assert.ok(indexer.indexerDb.createAttestationRequest.calledOnce, 'invalid request is still recorded');
        });

        it('rejects an unknown PROVIDER_ID', async function () {
            const data = v0Data();
            await handler.parse(v0Params({ providerId: 'not_a_provider' }), data, null);
            assert.ok(String(data['STATUS']).includes('PROVIDER_ID'));
        });

        it('rejects a malformed REQUEST_ID', async function () {
            const data = v0Data();
            await handler.parse(v0Params({ requestId: 'xyz' }), data, null);
            assert.ok(String(data['STATUS']).includes('REQUEST_ID'));
        });

        it('rejects a redundancy value the provider does not allow', async function () {
            const data = v0Data();
            await handler.parse(v0Params({ redundancy: '2' }), data, null); // http_get allows [1,3,5]
            assert.ok(String(data['STATUS']).includes('REDUNDANCY'));
        });

        it('rejects when the contract emitter is missing', async function () {
            const data = v0Data({ EMITTER: undefined });
            await handler.parse(v0Params(), data, null);
            assert.ok(String(data['STATUS']).includes('CONTRACT_INDEX'));
        });

        it('rejects when CONTRACT_INDEX references a non-existent contract (getContract returns null)', async function () {
            // EMITTER is present → CONTRACT_INDEX != null → getContract called → returns null (line 119)
            indexer.indexerDb.getContract.resolves(null);
            const data = v0Data();
            await handler.parse(v0Params(), data, null);
            assert.ok(String(data['STATUS']).includes('CONTRACT_INDEX'),
                'expected CONTRACT_INDEX (unknown) rejection, got: ' + data['STATUS']);
        });

        // Framework spec §11.1 per-block admission caps. Armed at genesis on
        // regtest, which is the network this harness runs as, so these exercise the live
        // path. The counts come from the DB stub, which is what the real query returns
        // for "admitted earlier in this block".
        describe('per-block admission caps (spec §11.1)', function () {

            it('admits a request while both counts are under the caps', async function () {
                indexer.indexerDb.getAttestationAdmissionCounts.resolves({ total: 9, byContract: 1 });
                const data  = v0Data();
                const reqId = deriveReqId(data["TX_HASH"], data["ROOT_ACTION_INDEX"], data["EMITTER_PATH"], data["EMITTER"], data["EMITTER_POSITION"]);
                await handler.parse(v0Params({ requestId: reqId }), data, null);
                assert.strictEqual(data['STATUS'], 'valid',
                    'under both caps must still admit, got: ' + data['STATUS']);
            });

            it('rejects once the emitting contract has filled its per-contract share', async function () {
                indexer.indexerDb.getAttestationAdmissionCounts.resolves({ total: 2, byContract: 2 });
                const data  = v0Data();
                const reqId = deriveReqId(data["TX_HASH"], data["ROOT_ACTION_INDEX"], data["EMITTER_PATH"], data["EMITTER"], data["EMITTER_POSITION"]);
                await handler.parse(v0Params({ requestId: reqId }), data, null);
                assert.ok(String(data['STATUS']).includes('ATTEST cap'),
                    'expected a per-contract cap rejection, got: ' + data['STATUS']);
                assert.strictEqual(data['REQUEST_STATUS'], 'rejected',
                    'an over-cap request must never enter the pending pool');
            });

            it('rejects once the block has filled the global ceiling', async function () {
                // Under its own per-contract share, but the block is full: the network-wide
                // ceiling is the one that bounds aggregate validator spend.
                indexer.indexerDb.getAttestationAdmissionCounts.resolves({ total: 10, byContract: 0 });
                const data  = v0Data();
                const reqId = deriveReqId(data["TX_HASH"], data["ROOT_ACTION_INDEX"], data["EMITTER_PATH"], data["EMITTER"], data["EMITTER_POSITION"]);
                await handler.parse(v0Params({ requestId: reqId }), data, null);
                assert.ok(String(data['STATUS']).includes('ATTEST cap'),
                    'expected a per-block cap rejection, got: ' + data['STATUS']);
                assert.strictEqual(data['REQUEST_STATUS'], 'rejected');
            });

            it('counts only earlier admissions of THIS block, from THIS action', async function () {
                indexer.indexerDb.getAttestationAdmissionCounts.resolves({ total: 0, byContract: 0 });
                const data  = v0Data();
                const reqId = deriveReqId(data["TX_HASH"], data["ROOT_ACTION_INDEX"], data["EMITTER_PATH"], data["EMITTER"], data["EMITTER_POSITION"]);
                await handler.parse(v0Params({ requestId: reqId }), data, null);
                // The (block, action, contract) triple is what makes the count a total order
                // every node replays identically; passing anything else forks the gate.
                assert.ok(indexer.indexerDb.getAttestationAdmissionCounts.calledOnce);
                const args = indexer.indexerDb.getAttestationAdmissionCounts.firstCall.args;
                assert.strictEqual(args[0], data['BLOCK_INDEX']);
                assert.strictEqual(args[1], data['ACTION_INDEX']);
                assert.strictEqual(args[2], data['CONTRACT_INDEX']);
            });

            it('does not spend a capped slot on a structurally invalid request', async function () {
                // The cap is checked last, so a request that was going to be rejected anyway
                // never consults the counts - otherwise malformed spam would burn capacity,
                // turning the anti-abuse rule into an abuse vector.
                indexer.indexerDb.getContract.resolves(null);
                const data  = v0Data();
                const reqId = deriveReqId(data["TX_HASH"], data["ROOT_ACTION_INDEX"], data["EMITTER_PATH"], data["EMITTER"], data["EMITTER_POSITION"]);
                await handler.parse(v0Params({ requestId: reqId }), data, null);
                assert.ok(String(data['STATUS']).includes('CONTRACT_INDEX'));
                assert.strictEqual(indexer.indexerDb.getAttestationAdmissionCounts.called, false);
            });
        });

        it('rejects a deadline outside the provider window', async function () {
            const data = v0Data();
            await handler.parse(v0Params({ deadline: '999' }), data, null); // http_get window = 100
            assert.ok(String(data['STATUS']).includes('DEADLINE'));
        });

        it('rejects when PROVIDER_ID is null in v0 params (line 93)', async function () {
            // Valid emission with null PROVIDER_ID → isNull guard fires (line 92-93)
            const data = v0Data();
            const reqId = deriveReqId(data['TX_HASH'], data['ROOT_ACTION_INDEX'], data['EMITTER_PATH'], data['EMITTER'], data['EMITTER_POSITION']);
            await handler.parse(v0Params({ requestId: reqId, providerId: null }), data, null);
            assert.ok(String(data['STATUS']).includes('PROVIDER_ID'),
                'expected PROVIDER_ID rejection, got: ' + data['STATUS']);
        });

        it('rejects when CALLBACK_METHOD is null in v0 params (line 99)', async function () {
            // Valid emission with null CALLBACK_METHOD → isNull guard fires (line 98-99)
            const data = v0Data();
            const reqId = deriveReqId(data['TX_HASH'], data['ROOT_ACTION_INDEX'], data['EMITTER_PATH'], data['EMITTER'], data['EMITTER_POSITION']);
            await handler.parse(v0Params({ requestId: reqId, callback: null }), data, null);
            assert.ok(String(data['STATUS']).includes('CALLBACK_METHOD'),
                'expected CALLBACK_METHOD rejection, got: ' + data['STATUS']);
        });

        it('rejects when REQUEST_PAYLOAD exceeds provider max size (lines 105-107)', async function () {
            // Pass an oversized payload; providerRegistry.isPayloadSizeAllowed returns false
            const data = v0Data();
            const reqId = deriveReqId(data['TX_HASH'], data['ROOT_ACTION_INDEX'], data['EMITTER_PATH'], data['EMITTER'], data['EMITTER_POSITION']);
            // http_get max payload: check providerRegistry, or pass a 100KB+ payload that exceeds any limit
            const bigPayload = 'x'.repeat(100000);
            await handler.parse(v0Params({ requestId: reqId, payload: bigPayload }), data, null);
            assert.ok(String(data['STATUS']).includes('REQUEST_PAYLOAD') || String(data['STATUS']).includes('invalid'),
                'expected REQUEST_PAYLOAD rejection or an earlier guard, got: ' + data['STATUS']);
        });

        it('a structurally invalid request is persisted as request_status=rejected, not pending', async function () {
            // Regression: the lifecycle column used to be hardcoded to 'pending'
            // before `error` was evaluated, so a protocol-rejected request entered
            // the pending pool and was fully serviceable by the hub poll, the
            // deadline-expiry sweep, and the v1 response path (all pending-only).
            // An oversize http_get payload must now land as 'rejected' so none of
            // those consumers ever pick it up.
            const data = v0Data();
            const reqId = deriveReqId(data['TX_HASH'], data['ROOT_ACTION_INDEX'], data['EMITTER_PATH'], data['EMITTER'], data['EMITTER_POSITION']);
            const bigPayload = 'x'.repeat(100000); // exceeds the http_get per-provider cap
            await handler.parse(v0Params({ requestId: reqId, payload: bigPayload }), data, null);

            assert.notStrictEqual(data['STATUS'], 'valid', 'oversize payload must not validate');
            assert.strictEqual(data['REQUEST_STATUS'], 'rejected',
                'invalid request must carry the terminal rejected status, got: ' + data['REQUEST_STATUS']);
            // The row is still recorded (audit trail), but with the rejected status.
            // the createAttestationRequest call must receive REQUEST_STATUS=rejected.
            assert.ok(indexer.indexerDb.createAttestationRequest.calledOnce, 'invalid request is still recorded');
            const persisted = indexer.indexerDb.createAttestationRequest.firstCall.args[0];
            assert.strictEqual(persisted['REQUEST_STATUS'], 'rejected',
                'persisted row must be rejected so the pending-only pollers skip it');
        });

        it('a valid request is persisted as request_status=pending', async function () {
            const data = v0Data();
            const reqId = deriveReqId(data['TX_HASH'], data['ROOT_ACTION_INDEX'], data['EMITTER_PATH'], data['EMITTER'], data['EMITTER_POSITION']);
            await handler.parse(v0Params({ requestId: reqId }), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['REQUEST_STATUS'], 'pending',
                'a valid request must remain pending so the hub can service it');
            const persisted = indexer.indexerDb.createAttestationRequest.firstCall.args[0];
            assert.strictEqual(persisted['REQUEST_STATUS'], 'pending');
        });

        it('null REQUEST_PAYLOAD uses empty-string fallback for byteLength (line 105)', async function () {
            // A valid-otherwise v0 emission where REQUEST_PAYLOAD is null →
            // `String(data['REQUEST_PAYLOAD'] || '')` → '' → byteLength(0)
            const data = v0Data();
            const reqId = deriveReqId(data['TX_HASH'], data['ROOT_ACTION_INDEX'], data['EMITTER_PATH'], data['EMITTER'], data['EMITTER_POSITION']);
            await handler.parse(v0Params({ requestId: reqId, payload: null }), data, null);
            // null payload is 0 bytes; should not fail the size check
            assert.ok(indexer.indexerDb.createAttestationRequest.calledOnce);
        });

        it('non-finite DEADLINE_BLOCKS falls back to 0 increment (line 110)', async function () {
            // When DEADLINE_BLOCKS is NaN/non-finite → deadlineBlocks=0 → deadlineBlock=BLOCK_INDEX
            // The provider window check should catch this as an invalid deadline.
            const data = v0Data();
            const reqId = deriveReqId(data['TX_HASH'], data['ROOT_ACTION_INDEX'], data['EMITTER_PATH'], data['EMITTER'], data['EMITTER_POSITION']);
            await handler.parse(v0Params({ requestId: reqId, deadline: 'not_a_number' }), data, null);
            // deadlineBlock = BLOCK_INDEX+0 = BLOCK_INDEX; provider window likely fails → invalid
            assert.ok(String(data['STATUS']).includes('invalid'),
                'non-finite deadline should result in invalid status, got: ' + data['STATUS']);
        });
    });

    // v1: Response (validator broadcast). The security-critical path.
    //
    // NOTE on quorum: ATTEST v1 quorum is REDUNDANCY-based; a response is valid
    // when validSigs >= request.redundancy (attest.js _parseResponse). The
    // 2f+1 PBFT formula lives in PRICE v0, not here; see price.test.js.
    describe('v1: response', function () {

        function v1Data(overrides = {}) {
            return createBaseData({
                ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: 100, ACTION_INDEX: 7,
                ...overrides,
            });
        }
        // VERSION|REQUEST_ID|PROVIDER_ID|RESPONSE_PAYLOAD(b64)|STATUS|META|SIG_COUNT|PUBKEY|SIG|...
        function v1Params(sigs, overrides = {}) {
            const p = { requestId: REQ_ID, providerId: 'http_get', payload: b64('hello'), status: 'ok', meta: 'm', ...overrides };
            const head = ['1', p.requestId, p.providerId, p.payload, p.status, p.meta, String(sigs.length)];
            const tail = [];
            for (const s of sigs) { tail.push(s.pubkey, s.sig); }
            return head.concat(tail);
        }

        beforeEach(function () {
            // Default: every signature verifies; capability present.
            sinon.stub(ed25519, 'verify').returns(true);
        });

        it('parses a valid single signature → valid', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['VALID_SIGS'], 1);
        });

        it('parses a valid multi-signature bundle → valid', async function () {
            // Both signers are in the deterministic responsible set: universe = the two
            // signers, redundancy 2 → top-2-of-2 = both (independent of hash order).
            indexer.indexerDb.getValidatorsByCapability.resolves([{ pubkey: PUBKEY_A }, { pubkey: PUBKEY_B }]);
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 2 }));
            const data = v1Data();
            await handler.parse(v1Params([
                { pubkey: PUBKEY_A, sig: SIG_A },
                { pubkey: PUBKEY_B, sig: SIG_B },
            ]), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['VALID_SIGS'], 2);
        });

        // The REQUEST_ID format check accepts either case, but the hub signs the
        // LOWERCASE rid. _parseResponse normalizes once, up front, so the canonical
        // it verifies against is byte-identical to the hub's signed bytes no matter
        // what case a producer puts on the wire (the byte-identity used to rest on
        // AttestationPublisher lowercasing, an invariant outside this handler).
        it('normalizes a mixed-case REQUEST_ID: canonical, lookup, and stored row', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));

            const lowerData = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), lowerData, null);
            const canonicalFromLower = ed25519.verify.firstCall.args[0].toString('utf8');

            ed25519.verify.resetHistory();
            indexer.indexerDb.getAttestationRequestById.resetHistory();

            const upperData = v1Data();
            await handler.parse(
                v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }], { requestId: REQ_ID.toUpperCase() }),
                upperData, null);
            const canonicalFromUpper = ed25519.verify.firstCall.args[0].toString('utf8');

            assert.strictEqual(canonicalFromUpper, canonicalFromLower,
                'signed canonical must not depend on the wire request_id case');
            assert.strictEqual(upperData['STATUS'], 'valid');
            assert.strictEqual(upperData['REQUEST_ID'], REQ_ID, 'row stores the lowercase id');
            assert.strictEqual(indexer.indexerDb.getAttestationRequestById.firstCall.args[0], REQ_ID,
                'request lookup uses the lowercase id');
        });

        // the id case inside the canonical is consensus behaviour, gated on
        // ATTEST_CANONICAL_LOWERCASE_ID. Below the flag-day the canonical uses the
        // RAW wire case (a case-mutated replay keeps failing verification exactly
        // like on a legacy node); at/after it the lowercased id (self-contained
        // byte-identity with the hub). The default mock gate is active, so the
        // normalization test above covers the ON side.
        it('gate INACTIVE: the canonical uses the RAW wire id case (legacy byte-identity)', async function () {
            actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(
                async (name) => name !== 'ATTEST_CANONICAL_LOWERCASE_ID');
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));

            const upperData = v1Data();
            await handler.parse(
                v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }], { requestId: REQ_ID.toUpperCase() }),
                upperData, null);
            const canonical = ed25519.verify.firstCall.args[0].toString('utf8');

            assert.ok(canonical.includes(REQ_ID.toUpperCase()),
                'below the flag-day the canonical must carry the raw (uppercase) wire id');
            assert.ok(!canonical.includes(REQ_ID),
                'and must not carry the lowercased id');
            assert.strictEqual(upperData['REQUEST_ID'], REQ_ID,
                'non-consensus uses (stored row) still lowercase');
        });

        it('gate INACTIVE: a lowercase wire id produces the same canonical as ever (no behavior change for the live producer)', async function () {
            actionsCtx.protocolChanges.isEnabled = sinon.stub().callsFake(
                async (name) => name !== 'ATTEST_CANONICAL_LOWERCASE_ID');
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));

            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            const canonical = ed25519.verify.firstCall.args[0].toString('utf8');

            assert.ok(canonical.includes(REQ_ID), 'lowercase wire id verifies against the same bytes');
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('rejects a malformed SIG_COUNT length prefix', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow());
            const data = v1Data();
            // hand-craft params with non-numeric SIG_COUNT
            const params = ['1', REQ_ID, 'http_get', b64('hi'), 'ok', 'm', 'NOT_A_NUMBER', PUBKEY_A, SIG_A];
            await handler.parse(params, data, null);
            assert.ok(String(data['STATUS']).includes('invalid'));
            assert.ok(indexer.indexerDb.createAttestationResponse.calledOnce, 'invalid response still recorded');
        });

        it('rejects a truncated payload (SIG_COUNT exceeds sigs present)', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow());
            const data = v1Data();
            // claims 2 sigs but provides only 1
            const params = ['1', REQ_ID, 'http_get', b64('hi'), 'ok', 'm', '2', PUBKEY_A, SIG_A];
            await handler.parse(params, data, null);
            assert.ok(String(data['STATUS']).includes('invalid'));
        });

        it('rejects a pubkey that is not 64 hex chars', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow());
            const data = v1Data();
            const params = ['1', REQ_ID, 'http_get', b64('hi'), 'ok', 'm', '1', 'tooshort', SIG_A];
            await handler.parse(params, data, null);
            assert.ok(String(data['STATUS']).includes('invalid'));
        });

        it('does NOT count two signatures from the same pubkey twice toward quorum', async function () {
            // redundancy 2, but both sigs share PUBKEY_A → only 1 distinct valid sig → insufficient
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 2 }));
            const data = v1Data();
            await handler.parse(v1Params([
                { pubkey: PUBKEY_A, sig: SIG_A },
                { pubkey: PUBKEY_A, sig: SIG_B },
            ]), data, null);
            assert.strictEqual(data['VALID_SIGS'], 1, 'duplicate pubkey counted once');
            assert.ok(String(data['STATUS']).includes('insufficient'));
            assert.ok(executeStub.parse.notCalled, 'no callback injected without quorum');
        });

        it('meets quorum when validSigs equals REDUNDANCY → valid', async function () {
            // Universe = the two signers, redundancy 2 → both are responsible.
            indexer.indexerDb.getValidatorsByCapability.resolves([{ pubkey: PUBKEY_A }, { pubkey: PUBKEY_B }]);
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 2 }));
            const data = v1Data();
            await handler.parse(v1Params([
                { pubkey: PUBKEY_A, sig: SIG_A },
                { pubkey: PUBKEY_B, sig: SIG_B },
            ]), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
        });

        it('fails quorum when validSigs is one below REDUNDANCY → invalid', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 3 }));
            const data = v1Data();
            await handler.parse(v1Params([
                { pubkey: PUBKEY_A, sig: SIG_A },
                { pubkey: PUBKEY_B, sig: SIG_B },
            ]), data, null);
            assert.ok(String(data['STATUS']).includes('insufficient'));
        });

        it('counts a signature only when ed25519.verify passes', async function () {
            ed25519.verify.returns(false); // override the beforeEach stub
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.strictEqual(data['VALID_SIGS'], 0);
            assert.ok(String(data['STATUS']).includes('insufficient'));
        });

        it('checks signer capability at the REQUEST snapshot block, not the response block', async function () {
            const request = makeRequestRow({ redundancy: 1, block_index: 90 });
            indexer.indexerDb.getAttestationRequestById.resolves(request);
            const data = v1Data({ BLOCK_INDEX: 100 });
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            // the anchor is the REQUEST's block (90), not the response block (100)
            // and the height actually queried is that anchor buried by CANONICAL_REORG_BUFFER
            // (the height the hub resolved the set at). Regtest arms the burial gate at genesis.
            const expectBlock = srb.buriedSnapshotBlock(90, 'regtest');
            assert.ok(
                indexer.indexerDb.getValidatorsByCapability.calledWith('attestation', expectBlock),
                'the capable set must be read at the request snapshot block (90, buried to ' +
                expectBlock + '), not the response block (100)'
            );
            assert.ok(
                !indexer.indexerDb.getValidatorsByCapability.calledWith('attestation', 100),
                'the capable set must never be read at the response block'
            );
        });

        it('resolves the capable set ONCE, never once per signer', async function () {
            // Pre-fix this ran hasCapability (~5 sequential queries) per signer inside the
            // per-tx consensus path; the batched read now answers every signer (#3872).
            indexer.indexerDb.getValidatorsByCapability.resolves([{ pubkey: PUBKEY_A }, { pubkey: PUBKEY_B }]);
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([
                { pubkey: PUBKEY_A, sig: SIG_A },
                { pubkey: PUBKEY_B, sig: SIG_B },
            ]), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(
                indexer.indexerDb.hasCapability.getCalls().filter(c => c.args[1] === 'attestation').length, 0,
                'no per-signer attestation capability read may survive the batched set');
        });

        it('skips a signer lacking the attestation capability at the snapshot block', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            indexer.indexerDb.getValidatorsByCapability.resolves([]);
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.strictEqual(data['VALID_SIGS'], 0);
            assert.ok(String(data['STATUS']).includes('insufficient'));
        });

        it('a TRUNCATED capable set falls back to the per-signer capability probe', async function () {
            // getValidatorsByCapability caps at VALIDATOR_QUERY_LIMIT and hasCapability
            // does not, so a capped read is not an authoritative membership answer.
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const capped = [{ pubkey: PUBKEY_A }];
            capped.truncated = true;
            indexer.indexerDb.getValidatorsByCapability.resolves(capped);
            indexer.indexerDb.hasCapability.resolves(false);
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.strictEqual(
                indexer.indexerDb.hasCapability.getCalls()
                    .filter(c => c.args[0] === PUBKEY_A && c.args[1] === 'attestation').length, 1,
                'a capped read must be re-probed per signer, not trusted as membership');
            assert.strictEqual(data['VALID_SIGS'], 0);
            assert.ok(String(data['STATUS']).includes('insufficient'));
        });

        // STAKE_WEIGHTED_QUORUM: the v1 eligibility pre-filter must be derived from
        // the SAME query the responsible set is, or a responsible signer is dropped
        // before it is counted. getValidatorsByCapability / hasCapability qualify a
        // PUBKEY on its own aggregate; getStakeWeightsByCapability qualifies a SOURCE
        // on its aggregate and emits all of that source's keys, so a source clearing
        // MIN_STAKE only across sub-threshold keys is responsible yet was ineligible.
        // The responsible set is exactly REDUNDANCY keys, so one dropped member made
        // the request permanently unfulfillable, burning a fee on every retry.
        describe('STAKE_WEIGHTED_QUORUM: v1 signer eligibility follows the responsible-set derivation', function () {

            // The stake-split source: in the weighted (source-aggregate) set, absent
            // from the pubkey-aggregate set, and holding no delegation row.
            function stakeSplitSource() {
                indexer.indexerDb.getValidatorsByCapability.resolves([]);
                indexer.indexerDb.hasCapability.resolves(false);
                indexer.indexerDb.getStakeWeightsByCapability.resolves([
                    { pubkey: PUBKEY_A, source: 'S1', weight: '50000' },
                ]);
            }

            it('counts a responsible signer the pubkey-aggregate set excludes', async function () {
                swq.isStakeWeightedQuorumActive.returns(true);
                stakeSplitSource();
                indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
                const data = v1Data();
                await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
                assert.strictEqual(data['VALID_SIGS'], 1,
                    'a weighted responsible-set member must not be dropped by the eligibility gate: ' + data['STATUS']);
                assert.strictEqual(data['STATUS'], 'valid');
            });

            it('reads eligibility from the weighted query, at the BURIED height', async function () {
                swq.isStakeWeightedQuorumActive.returns(true);
                stakeSplitSource();
                indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1, block_index: 90 }));
                await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), v1Data({ BLOCK_INDEX: 100 }), null);
                // Declared 90 buried once (snapshotBlock is already buried; burying it a
                // second time here would resolve a different set than the hub signed).
                assert.ok(indexer.indexerDb.getStakeWeightsByCapability.calledWith(
                    'attestation', srb.buriedSnapshotBlock(90, 'regtest')));
                assert.ok(indexer.indexerDb.getStakeWeightsByCapability.neverCalledWith('attestation', 90),
                    'the declared height is the flag-day plane only, never the resolve height');
                assert.ok(indexer.indexerDb.getValidatorsByCapability.notCalled,
                    'the pubkey-aggregate query must not gate eligibility above the flag-day');
            });

            it('a TRUNCATED weighted read is used as it stands, never re-probed per signer', async function () {
                // hasCapability sums per signing_pubkey_id, the pubkey aggregate again, so a
                // per-signer fallback would reinstate the bug exactly where the federation is
                // largest. _computeResponsibleSet reads the same truncated set at the same
                // block, so eligibility still covers it.
                swq.isStakeWeightedQuorumActive.returns(true);
                indexer.indexerDb.getValidatorsByCapability.resolves([]);
                indexer.indexerDb.hasCapability.resolves(false);
                const capped = [{ pubkey: PUBKEY_A, source: 'S1', weight: '50000' }];
                capped.truncated = true;
                indexer.indexerDb.getStakeWeightsByCapability.resolves(capped);
                indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
                const data = v1Data();
                await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
                assert.strictEqual(
                    indexer.indexerDb.hasCapability.getCalls().filter(c => c.args[1] === 'attestation').length, 0,
                    'no pubkey-aggregate probe may run on the weighted branch');
                assert.strictEqual(data['STATUS'], 'valid');
            });

            it('below the flag-day the pubkey-aggregate gate is byte-preserved', async function () {
                swq.isStakeWeightedQuorumActive.returns(false);
                stakeSplitSource();
                indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
                const data = v1Data();
                await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
                assert.ok(indexer.indexerDb.getStakeWeightsByCapability.notCalled,
                    'pre-flag-day replay must never consult the weighted query');
                assert.strictEqual(data['VALID_SIGS'], 0);
                assert.ok(String(data['STATUS']).includes('insufficient'));
            });

            it('off BTC the BTC-anchored gate is never evaluated against a local height', async function () {
                // isStakeWeightedQuorumActive compares against a BTC height; an LTC/DOGE
                // local height is already past it, so consulting the gate there resolves
                // TRUE out of band. _computeResponsibleSet returns [] off BTC for the same
                // reason, so the two stay on one plane.
                swq.isStakeWeightedQuorumActive.returns(true);
                indexer.config['COIN'] = 'LTC';
                stakeSplitSource();
                indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
                await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), v1Data(), null);
                assert.ok(indexer.indexerDb.getStakeWeightsByCapability.notCalled,
                    'the weighted eligibility read is BTC-only');
            });
        });

        //
        // Quorum requires signers from the request's deterministic responsible
        // set: top-REDUNDANCY validators ranked by SHA256(request_id || pubkey),
        // the same set _parseExpire charges missed_count to. Capability + a valid
        // sig is necessary but not sufficient: otherwise any capable coalition
        // could assemble a valid v1 (first-lands-wins, non-deterministic) and
        // fulfilled_count would drift from missed_count.

        // Rank a universe of pubkeys exactly as _computeResponsibleSet does, so the
        // tests can pick in-set vs out-of-set coalitions without hard-coding hashes.
        const PUBKEY_OUT1 = 'c'.repeat(64);
        const PUBKEY_OUT2 = 'e'.repeat(64);
        const SIG_C = '3'.repeat(128);
        const SIG_D = '4'.repeat(128);
        function rankResponsible(reqId, pubkeys, redundancy) {
            return pubkeys
                .map(pk => ({ pk, h: crypto.createHash('sha256').update(String(reqId), 'utf8').update(pk, 'utf8').digest('hex') }))
                .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0))
                .slice(0, redundancy)
                .map(x => x.pk);
        }

        it('rejects a v1 signed by a capable-but-not-responsible validator coalition', async function () {
            // Four capable validators, redundancy 2 → 2 are responsible, 2 are not.
            // The non-responsible pair signs a well-formed bundle (valid capability +
            // valid ed25519). Pre-fix this counted toward quorum (capability + sig
            // only) and produced a valid v1; post-fix the out-of-set signers are
            // filtered out and the response is rejected as insufficient.
            const universe = [PUBKEY_A, PUBKEY_B, PUBKEY_OUT1, PUBKEY_OUT2];
            const sigByPub = { [PUBKEY_A]: SIG_A, [PUBKEY_B]: SIG_B, [PUBKEY_OUT1]: SIG_C, [PUBKEY_OUT2]: SIG_D };
            const responsible = rankResponsible(REQ_ID.toLowerCase(), universe, 2);
            const outsiders   = universe.filter(pk => !responsible.includes(pk));
            assert.strictEqual(outsiders.length, 2, 'sanity: a 2-signer coalition outside the responsible set');

            indexer.indexerDb.getValidatorsByCapability.resolves(universe.map(pk => ({ pubkey: pk })));
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 2 }));
            const data = v1Data();
            await handler.parse(v1Params(outsiders.map(pk => ({ pubkey: pk, sig: sigByPub[pk] }))), data, null);

            assert.strictEqual(data['VALID_SIGS'], 0, 'no out-of-set signature counts toward quorum');
            assert.ok(String(data['STATUS']).includes('insufficient valid signatures'),
                'capable-but-not-responsible coalition must be rejected, got: ' + data['STATUS']);
            assert.ok(executeStub.parse.notCalled, 'no callback injected for an out-of-set coalition');
        });

        it('accepts a v1 signed by the deterministic responsible set', async function () {
            // The complement of the test above: the SAME universe, but now the
            // in-set pair signs → quorum is met and the response is valid.
            const universe = [PUBKEY_A, PUBKEY_B, PUBKEY_OUT1, PUBKEY_OUT2];
            const sigByPub = { [PUBKEY_A]: SIG_A, [PUBKEY_B]: SIG_B, [PUBKEY_OUT1]: SIG_C, [PUBKEY_OUT2]: SIG_D };
            const responsible = rankResponsible(REQ_ID.toLowerCase(), universe, 2);

            indexer.indexerDb.getValidatorsByCapability.resolves(universe.map(pk => ({ pubkey: pk })));
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 2 }));
            const data = v1Data();
            await handler.parse(v1Params(responsible.map(pk => ({ pubkey: pk, sig: sigByPub[pk] }))), data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['VALID_SIGS'], 2, 'both responsible signers count');
        });

        it('injects exactly one EXECUTE callback on quorum success', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.ok(executeStub.parse.calledOnce, 'callback EXECUTE injected once');
            assert.ok(indexer.indexerDb.setAttestationResponseCallbackIndex.calledOnce);
        });

        it('bumps fulfilled_count for each signer only when STATUS is ok', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }], { status: 'ok' }), data, null);
            assert.ok(indexer.indexerDb.incrementAttestationValidatorStat.calledOnce);
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.calledWith(REQ_ID.toLowerCase(), 'fulfilled'));
        });

        it('flips request to errored (no fulfilled_count) for a valid terminal non-ok response', async function () {
            // `expired` is the only non-ok status that is genuinely terminal (the
            // deadline passed); it closes the request and still fires the callback.
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }], { status: 'expired' }), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.incrementAttestationValidatorStat.notCalled, 'no fulfilled_count on non-ok');
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.calledWith(REQ_ID.toLowerCase(), 'errored'));
            assert.ok(executeStub.parse.calledOnce, 'callback still injected for a valid terminal non-ok response');
        });

        ['no_quorum', 'timeout', 'provider_error'].forEach(function (retryableStatus) {
            it(`leaves request pending (no status flip, no callback) for a valid '${retryableStatus}' response`, async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
                const data = v1Data();
                await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }], { status: retryableStatus }), data, null);
                assert.strictEqual(data['STATUS'], 'valid', 'response itself is still a valid, recorded row');
                assert.ok(indexer.indexerDb.createAttestationResponse.calledOnce, 'response row recorded for audit');
                assert.ok(indexer.indexerDb.incrementAttestationValidatorStat.notCalled, 'no fulfilled_count on non-ok');
                assert.ok(indexer.indexerDb.updateAttestationRequestStatus.notCalled, 'request_status left untouched (pending)');
                assert.ok(executeStub.parse.notCalled, 'no callback fired while the request can still retry');
            });
        });

        it('records both rounds and fulfills on the ok after an earlier retryable left it pending', async function () {
            // #4373: a retryable no_quorum round leaves the request pending; a later ok round
            // must also persist and fulfill it. This drives the REAL persistence path against a
            // fake `attests` store that models the post-fix schema (UNIQUE(action_index) only,
            // request_id+version NON-unique). The old UNIQUE(request_id, version) would have
            // rejected the second v1 INSERT and stranded the request; here both rounds coexist.
            const rows = [];
            indexer.indexerDb.createAttestationResponse = sinon.stub().callsFake(async (d) => {
                const ai  = d['ACTION_INDEX'];
                let row = rows.find(r => r.action_index === ai);   // UNIQUE(action_index)
                if(!row){ row = { action_index: ai }; rows.push(row); }
                row.version         = 1;
                row.request_id      = String(d['REQUEST_ID'] || '').toLowerCase();
                row.response_status = d['RESPONSE_STATUS'];
            });
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));

            const round1 = v1Data({ ACTION_INDEX: 7 });
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }], { status: 'no_quorum' }), round1, null);
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.notCalled, 'no_quorum must not close the request');

            const round2 = v1Data({ ACTION_INDEX: 8 });
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }], { status: 'ok' }), round2, null);

            // Both v1 rounds coexist as distinct rows under the same request_id.
            const v1Rows = rows.filter(r => r.version === 1 && r.request_id === REQ_ID.toLowerCase());
            assert.strictEqual(v1Rows.length, 2, 'both the no_quorum and ok rounds are recorded');
            assert.deepStrictEqual(v1Rows.map(r => r.response_status).sort(), ['no_quorum', 'ok']);
            assert.notStrictEqual(v1Rows[0].action_index, v1Rows[1].action_index, 'distinct action_index per round');

            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.calledOnceWith(REQ_ID.toLowerCase(), 'fulfilled'),
                'the later ok response fulfills the still-pending request');
            assert.ok(executeStub.parse.calledOnce, 'callback fires exactly once, on the fulfilling response');
        });

        it('stores the response but injects no callback when quorum is not reached', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 5 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.ok(indexer.indexerDb.createAttestationResponse.calledOnce, 'response row recorded');
            assert.ok(executeStub.parse.notCalled, 'no callback without quorum');
        });

        it('rejects a response to an already-resolved request (replay guard)', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'fulfilled', redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.ok(String(data['STATUS']).includes('already fulfilled'));
            assert.ok(executeStub.parse.notCalled, 'no second callback for a resolved request');
        });

        it('rejects a response whose REQUEST_ID matches no request', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(null);
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.ok(String(data['STATUS']).includes('no matching request'));
        });

        it('rejects a response arriving after the deadline block', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ deadline_block: 200, redundancy: 1 }));
            const data = v1Data({ BLOCK_INDEX: 300 });
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.ok(String(data['STATUS']).includes('expired'));
        });

        it('rejects a response whose PROVIDER_ID does not match the request', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ provider_id: 'http_get', redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }], { providerId: 'llm' }), data, null);
            assert.ok(String(data['STATUS']).includes('PROVIDER_ID does not match'));
        });

        it('rejects an unknown response STATUS value', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }], { status: 'bogus' }), data, null);
            assert.ok(String(data['STATUS']).includes('STATUS'));
        });

        it('rejects when PROVIDER_ID is null/empty in v1 params (line 181)', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            // Pass empty string for providerId to trigger isNull guard
            const params = ['1', REQ_ID, '', b64('hi'), 'ok', 'm', '1', PUBKEY_A, SIG_A];
            await handler.parse(params, data, null);
            assert.ok(String(data['STATUS']).includes('PROVIDER_ID'));
        });

        it('null meta in v1 params is handled without crash (canonical uses empty string, line 223)', async function () {
            // meta=null → String(null || '') = '' in canonical; must not throw
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            // Override v1Params to pass null meta
            const params = ['1', REQ_ID, 'http_get', b64('hi'), 'ok', null, '1', PUBKEY_A, SIG_A];
            await handler.parse(params, data, null);
            // No throw: even if it ends invalid, the handler must complete
            assert.ok(indexer.indexerDb.createAttestationResponse.calledOnce);
        });

        it('snapshotBlock falls back to data[BLOCK_INDEX] when request is null at sig-verify time (line 242)', async function () {
            // Set request to null by making getAttestationRequestById return null.
            // After the error is set ('no matching request'), the sig-verify loop does
            // not run (error is already set), but line 226 + 242 have the ternary branches.
            indexer.indexerDb.getAttestationRequestById.resolves(null);
            const data = v1Data({ BLOCK_INDEX: 120 });
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.ok(String(data['STATUS']).includes('no matching request'));
        });

        it('sig with invalid 128-hex format throws and is caught as invalid (line 198)', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            // Valid pubkey but sig is only 64 chars (not 128) → invalid sig format
            const params = ['1', REQ_ID, 'http_get', b64('hi'), 'ok', 'm', '1', PUBKEY_A, 'a'.repeat(64)];
            await handler.parse(params, data, null);
            assert.ok(String(data['STATUS']).includes('invalid'));
        });
    });

    describe('v2: expire', function () {

        function v2Data(overrides = {}) {
            return createBaseData({
                ACTION: 'ATTEST', FORMAT: 2, BLOCK_INDEX: 250, REQUEST_ID: REQ_ID, IS_SYNTHETIC: true,
                ...overrides,
            });
        }

        it('expires a pending request → status flipped to expired and callback injected', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'pending' }));
            const data = v2Data();
            await handler.parse(['2', REQ_ID], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.calledWith(REQ_ID.toLowerCase(), 'expired'));
            assert.ok(executeStub.parse.calledOnce, 'expiry callback injected');
        });

        it('rejects a user-broadcast (non-synthetic) v2', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow());
            const data = v2Data({ IS_SYNTHETIC: false });
            await handler.parse(['2', REQ_ID], data, null);
            assert.ok(String(data['STATUS']).includes('system-synthesized'));
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.notCalled);
        });

        it('no-ops when the request is already resolved', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'fulfilled' }));
            const data = v2Data();
            await handler.parse(['2', REQ_ID], data, null);
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.notCalled);
            assert.ok(executeStub.parse.notCalled);
        });

        it('no-ops when the request no longer exists', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(null);
            const data = v2Data();
            await handler.parse(['2', REQ_ID], data, null);
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.notCalled);
        });
    });

    // E1: request fees (FEE_TICK|FEE_AMOUNT optional trailing fields)
    describe('E1: request fees', function () {

        const FEE_PAYER = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH'; // createBaseData SOURCE
        const POOL      = 'mrewardshQqD1ptkEBZGjPDF77L5uKJQmk'; // config ADDRESS.REWARD (regtest)
        const PUBKEY_C  = 'c'.repeat(64);
        const SIG_C     = '3'.repeat(128);

        function v0FeeData(overrides = {}) {
            return createBaseData({
                ACTION: 'ATTEST', FORMAT: 0, IS_EMISSION: true, EMITTER: 5, EMITTER_POSITION: 0,
                EMITTER_PATH: '0', ROOT_ACTION_INDEX: 100, BLOCK_INDEX: 100, ACTION_INDEX: 40,
                ...overrides,
            });
        }
        // VERSION|...|DEADLINE_BLOCKS|FEE_TICK|FEE_AMOUNT; reqId derived per fixture
        function v0FeeParams(data, feeTick, feeAmount) {
            const reqId = deriveReqId(data['TX_HASH'], data['ROOT_ACTION_INDEX'], data['EMITTER_PATH'], data['EMITTER'], data['EMITTER_POSITION']);
            const base = ['0', reqId, 'http_get', 'q', 'onResult', '[]', '3', '50'];
            if (feeTick !== undefined)   base.push(feeTick);
            if (feeAmount !== undefined) base.push(feeAmount);
            return base;
        }
        function fundFeePayer() {
            indexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 7 });
            indexer.indexerDb.getAddressBalances.resolves({ 7: '100.00000000' });
        }
        function feeRequestRow(overrides = {}) {
            return makeRequestRow({
                action_index: 42, fee_amount: '6.00000000', fee_payer: FEE_PAYER,
                ...overrides,
            });
        }
        function v1FeeData(overrides = {}) {
            return createBaseData({ ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: 100, ACTION_INDEX: 60, ...overrides });
        }
        function v1FeeParams(sigs, status = 'ok') {
            const head = ['1', REQ_ID, 'http_get', b64('hello'), status, 'm', String(sigs.length)];
            const tail = [];
            for (const s of sigs) { tail.push(s.pubkey, s.sig); }
            return head.concat(tail);
        }

        describe('v0: fee validation + escrow', function () {

            it('valid fee → escrows + debits FEE_AMOUNT from FEE_PAYER, STATUS valid', async function () {
                fundFeePayer();
                const data = v0FeeData();
                await handler.parse(v0FeeParams(data, 'XCHAIN', '5'), data, null);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(indexer.indexerDb.createDebit.calledOnce, 'fee debited');
                assert.ok(indexer.indexerDb.createEscrow.calledOnce, 'fee escrowed');
                const [, tick, amount, address] = indexer.indexerDb.createEscrow.firstCall.args;
                assert.strictEqual(tick, 'XCHAIN');
                assert.strictEqual(String(amount), '5');
                assert.strictEqual(address, FEE_PAYER);
                assert.ok(indexer.indexerDb.updateBalances.called, 'balances refreshed after escrow');
            });

            it('rejects a non-XCHAIN FEE_TICK (v1 rule: GAS tick only)', async function () {
                fundFeePayer();
                const data = v0FeeData();
                await handler.parse(v0FeeParams(data, 'MYTOKEN', '5'), data, null);
                assert.ok(String(data['STATUS']).includes('invalid: FEE_TICK (only'));
                assert.ok(indexer.indexerDb.createEscrow.notCalled);
            });

            it('rejects FEE_AMOUNT finer than the GAS tick decimals (9 dp vs production 8)', async function () {
                fundFeePayer();
                // Production XCHAIN genesis is issued with 8 decimals; 8 is also the
                // hard ceiling the equal split floors to.
                indexer.indexerDb.getTokenDecimalPrecision.resolves(8);
                const data = v0FeeData();
                await handler.parse(v0FeeParams(data, 'XCHAIN', '1.123456789'), data, null);
                assert.ok(String(data['STATUS']).includes('invalid: FEE_AMOUNT (precision'));
                assert.ok(indexer.indexerDb.createEscrow.notCalled);
            });

            it('rejects FEE_AMOUNT finer than a low-decimal GAS tick (1.234 vs 2 dp)', async function () {
                fundFeePayer();
                indexer.indexerDb.getTokenDecimalPrecision.resolves(2);
                const data = v0FeeData();
                await handler.parse(v0FeeParams(data, 'XCHAIN', '1.234'), data, null);
                assert.ok(String(data['STATUS']).includes('invalid: FEE_AMOUNT (precision'));
                assert.ok(indexer.indexerDb.createEscrow.notCalled);
            });

            it('accepts FEE_AMOUNT at exactly the GAS tick decimals (2 dp)', async function () {
                fundFeePayer();
                indexer.indexerDb.getTokenDecimalPrecision.resolves(2);
                const data = v0FeeData();
                await handler.parse(v0FeeParams(data, 'XCHAIN', '1.23'), data, null);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(indexer.indexerDb.createEscrow.calledOnce);
            });

            it('rejects a fractional FEE_AMOUNT against the decimals-0 regtest GAS tick', async function () {
                fundFeePayer(); // mock getTokenDecimalPrecision defaults to 0 (regtest GAS)
                const data = v0FeeData();
                await handler.parse(v0FeeParams(data, 'XCHAIN', '1.5'), data, null);
                assert.ok(String(data['STATUS']).includes('invalid: FEE_AMOUNT (precision'));
                assert.ok(indexer.indexerDb.createEscrow.notCalled);
            });

            it('rejects FEE_AMOUNT > 0 without FEE_TICK', async function () {
                fundFeePayer();
                const data = v0FeeData();
                await handler.parse(v0FeeParams(data, '', '5'), data, null);
                assert.ok(String(data['STATUS']).includes('invalid: FEE_TICK (required'));
            });

            it('rejects when FEE_PAYER cannot cover the fee', async function () {
                indexer.indexerDb.getTokenInfo.resolves({ TICK_ID: 7 });
                indexer.indexerDb.getAddressBalances.resolves({ 7: '1.00000000' });
                const data = v0FeeData();
                await handler.parse(v0FeeParams(data, 'XCHAIN', '5'), data, null);
                assert.ok(String(data['STATUS']).includes('invalid: insufficient funds (FEE_AMOUNT)'));
                assert.ok(indexer.indexerDb.createEscrow.notCalled, 'nothing escrowed on an invalid request');
            });

            it('feeless request (8-field wire format) stays valid with zero ledger writes', async function () {
                const data = v0FeeData();
                await handler.parse(v0FeeParams(data), data, null);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(indexer.indexerDb.createDebit.notCalled);
                assert.ok(indexer.indexerDb.createEscrow.notCalled);
            });

            it("FEE_AMOUNT '0' is treated as feeless (no escrow, no balance read)", async function () {
                const data = v0FeeData();
                await handler.parse(v0FeeParams(data, 'XCHAIN', '0'), data, null);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(indexer.indexerDb.createEscrow.notCalled);
                assert.ok(indexer.indexerDb.getAddressBalances.notCalled, 'no funding check for a zero fee');
            });
        });

        describe('v1: fee settlement on the terminal flip', function () {

            beforeEach(function () {
                sinon.stub(ed25519, 'verify').returns(true);
            });

            it('fulfilled → escrow released, REWARD pool credited, validator_rewards written', async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow({ redundancy: 1 }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
                assert.strictEqual(data['STATUS'], 'valid');

                // escrow release: one negative-amount escrow row against FEE_PAYER
                assert.ok(indexer.indexerDb.createEscrow.calledOnce, 'escrow release row written');
                const [, escTick, escAmount, escAddr] = indexer.indexerDb.createEscrow.firstCall.args;
                assert.strictEqual(escTick, 'XCHAIN');
                assert.ok(Number(escAmount) < 0, 'escrow amount is negative (release)');
                assert.strictEqual(escAddr, FEE_PAYER);

                // pool credit for the full fee
                assert.ok(indexer.indexerDb.createCredit.calledOnce);
                const [, crTick, crAmount, crAddr] = indexer.indexerDb.createCredit.firstCall.args;
                assert.strictEqual(crTick, 'XCHAIN');
                assert.strictEqual(String(crAmount), '6.00000000');
                assert.strictEqual(crAddr, POOL);

                // one reward row, keyed on the REQUEST's action_index
                assert.ok(indexer.indexerDb.createValidatorReward.calledOnce);
                const [pk, roundRef, rewardType, perValidator] = indexer.indexerDb.createValidatorReward.firstCall.args;
                assert.strictEqual(pk, PUBKEY_A);
                assert.strictEqual(roundRef, 42);
                assert.strictEqual(rewardType, 'attest_fee');
                assert.strictEqual(String(perValidator), '6');
            });

            it('fulfilled at REDUNDANCY=3 → equal floor split, remainder dust stays in the pool', async function () {
                indexer.indexerDb.getValidatorsByCapability.resolves([
                    { pubkey: PUBKEY_A }, { pubkey: PUBKEY_B }, { pubkey: PUBKEY_C },
                ]);
                indexer.indexerDb.getAttestationRequestById.resolves(
                    feeRequestRow({ redundancy: 3, fee_amount: '1.00000001' }));
                // _settleRequestFee reads gasDecimals to compute feeCap = min(8, gasDecimals).
                // Production XCHAIN genesis is 8 dp; floor each share to 8 dp.
                indexer.indexerDb.getTokenDecimalPrecision.resolves(8);
                const data = v1FeeData();
                await handler.parse(v1FeeParams([
                    { pubkey: PUBKEY_A, sig: SIG_A },
                    { pubkey: PUBKEY_B, sig: SIG_B },
                    { pubkey: PUBKEY_C, sig: SIG_C },
                ]), data, null);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(indexer.indexerDb.createValidatorReward.callCount, 3);
                for (const call of indexer.indexerDb.createValidatorReward.getCalls())
                    assert.strictEqual(String(call.args[3]), '0.33333333', 'floor to GAS decimals');
                // pool was credited the FULL fee; rewards reference 0.99999999 (dust stays)
                assert.strictEqual(String(indexer.indexerDb.createCredit.firstCall.args[2]), '1.00000001');
            });

            it("terminal non-ok ('errored') → fee refunds to FEE_PAYER, no rewards", async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow({ redundancy: 1 }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }], 'expired'), data, null);
                assert.ok(indexer.indexerDb.updateAttestationRequestStatus.calledWith(REQ_ID.toLowerCase(), 'errored'));
                assert.ok(indexer.indexerDb.createCredit.calledOnce);
                const [, , crAmount, crAddr] = indexer.indexerDb.createCredit.firstCall.args;
                assert.strictEqual(String(crAmount), '6.00000000');
                assert.strictEqual(crAddr, FEE_PAYER, 'refund goes to the payer, not the pool');
                assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
            });

            it("retryable status ('no_quorum') → fee stays escrowed, zero ledger movement", async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow({ redundancy: 1 }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }], 'no_quorum'), data, null);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(indexer.indexerDb.createEscrow.notCalled);
                assert.ok(indexer.indexerDb.createCredit.notCalled);
                assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
            });

            it('fulfilled FEELESS request → no fee ledger writes, no rewards', async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(indexer.indexerDb.createEscrow.notCalled);
                assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
            });
        });

        describe('v2: fee refund on expiry', function () {

            function v2FeeData(overrides = {}) {
                return createBaseData({
                    ACTION: 'ATTEST', FORMAT: 2, BLOCK_INDEX: 250, REQUEST_ID: REQ_ID, IS_SYNTHETIC: true,
                    ...overrides,
                });
            }

            it('expiry of a fee-bearing request refunds the escrow to FEE_PAYER', async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow({ request_status: 'pending' }));
                const data = v2FeeData();
                await handler.parse(['2', REQ_ID], data, null);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(indexer.indexerDb.createEscrow.calledOnce, 'escrow release row written');
                assert.ok(Number(indexer.indexerDb.createEscrow.firstCall.args[2]) < 0);
                assert.ok(indexer.indexerDb.createCredit.calledOnce);
                const [, , crAmount, crAddr] = indexer.indexerDb.createCredit.firstCall.args;
                assert.strictEqual(String(crAmount), '6.00000000');
                assert.strictEqual(crAddr, FEE_PAYER);
                assert.ok(indexer.indexerDb.createValidatorReward.notCalled, 'expiry never pays validators');
            });

            it('expiry of a feeless request writes no ledger rows (baseline preserved)', async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'pending' }));
                const data = v2FeeData();
                await handler.parse(['2', REQ_ID], data, null);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(indexer.indexerDb.createEscrow.notCalled);
                assert.ok(indexer.indexerDb.createCredit.notCalled);
            });
        });

        // Spec §11 leader broadcast-fee reimbursement. The escrow now pays the
        // broadcaster its native-coin cost back BEFORE the equal split, converted to XCHAIN
        // at the settle block's oracle price, bounded by a per-provider cap, and gated on a
        // flag-day so replay below the height is byte-identical to the pre-flag ledger.
        describe('§11: leader broadcast-fee reimbursement', function () {

            // cap 0.0001 BTC × (50000 USD/BTC) ÷ (2.5 USD/XCHAIN) = 2 XCHAIN
            const COIN_USD   = '50000';
            const XCHAIN_USD = '2.5';

            // The hash-sorted responsible set the handler derives for REQ_ID over
            // {A,B,C}: element 0 is the broadcaster the carve-out must pay.
            function hashOrder(pubkeys) {
                return pubkeys
                    .map(pk => ({ pk, h: crypto.createHash('sha256').update(REQ_ID, 'utf8').update(pk, 'utf8').digest('hex') }))
                    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0))
                    .map(v => v.pk);
            }

            function rewardsByType(type) {
                return indexer.indexerDb.createValidatorReward.getCalls()
                    .filter(c => c.args[2] === type)
                    .map(c => ({ pubkey: c.args[0], roundRef: c.args[1], amount: String(c.args[3]), block: c.args[4] }));
            }

            beforeEach(function () {
                sinon.stub(ed25519, 'verify').returns(true);
                attestBcastFee.isAttestBroadcastFeeActive.returns(true);
                // Production XCHAIN genesis is 8dp; the carve-out and the split floor to the
                // same grid, so assert on that grid rather than the 0dp regtest default.
                indexer.indexerDb.getTokenDecimalPrecision.resolves(8);
                sinon.stub(indexer.util, 'getFeeOraclePrices').resolves({
                    coinUsdPrice: COIN_USD, xchainUsdPrice: XCHAIN_USD, oracleRound: 7,
                });
            });

            it('pays the lowest-hash responsible member a converted reimbursement, then splits the rest', async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow({ redundancy: 1 }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
                assert.strictEqual(data['STATUS'], 'valid');

                const bcast = rewardsByType('attest_bcast');
                assert.strictEqual(bcast.length, 1, 'one broadcast reimbursement row');
                assert.strictEqual(bcast[0].pubkey, PUBKEY_A, 'paid to the responsible set head');
                assert.strictEqual(bcast[0].amount, '2', '0.0001 BTC at 50000/2.5 = 2 XCHAIN');
                assert.strictEqual(bcast[0].roundRef, 42, 'keyed on the REQUEST action_index');
                assert.strictEqual(bcast[0].block, data['BLOCK_INDEX'], 'stamped at the settle block');

                const split = rewardsByType('attest_fee');
                assert.strictEqual(split.length, 1);
                assert.strictEqual(split[0].amount, '4', 'escrow 6 minus the 2 carved out');

                // The pool credit is still the FULL escrow; the rows only reference it.
                assert.strictEqual(String(indexer.indexerDb.createCredit.firstCall.args[2]), '6.00000000');
            });

            it('the reimbursement is ON TOP of the broadcaster share (REDUNDANCY 3)', async function () {
                indexer.indexerDb.getValidatorsByCapability.resolves([
                    { pubkey: PUBKEY_A }, { pubkey: PUBKEY_B }, { pubkey: PUBKEY_C },
                ]);
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow({ redundancy: 3 }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([
                    { pubkey: PUBKEY_A, sig: SIG_A },
                    { pubkey: PUBKEY_B, sig: SIG_B },
                    { pubkey: PUBKEY_C, sig: SIG_C },
                ]), data, null);
                assert.strictEqual(data['STATUS'], 'valid');

                const leader = hashOrder([PUBKEY_A, PUBKEY_B, PUBKEY_C])[0];
                const bcast  = rewardsByType('attest_bcast');
                assert.strictEqual(bcast.length, 1);
                assert.strictEqual(bcast[0].pubkey, leader, 'lowest SHA256(request_id||pubkey) wins');
                assert.strictEqual(bcast[0].amount, '2');

                const split = rewardsByType('attest_fee');
                assert.strictEqual(split.length, 3, 'every responsible member still gets a share');
                // (6 - 2) / 3 floored to 8dp
                for (const row of split) assert.strictEqual(row.amount, '1.33333333');
                // The leader holds both rows, which is exactly "additionally receives".
                assert.ok(split.some(r => r.pubkey === leader));
            });

            it('a missing/stale oracle price reimburses 0 and never wedges the settle', async function () {
                indexer.util.getFeeOraclePrices.resolves({ error: 'no current oracle price for BTC/USD' });
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow({ redundancy: 1 }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

                assert.strictEqual(data['STATUS'], 'valid', 'settle still completes');
                assert.strictEqual(rewardsByType('attest_bcast').length, 0);
                const split = rewardsByType('attest_fee');
                assert.strictEqual(split.length, 1);
                assert.strictEqual(split[0].amount, '6', 'whole escrow falls through to the split');
            });

            it('an oracle read that THROWS reimburses 0 rather than failing the block', async function () {
                indexer.util.getFeeOraclePrices.rejects(new Error('price table unavailable'));
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow({ redundancy: 1 }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

                assert.strictEqual(data['STATUS'], 'valid');
                assert.strictEqual(rewardsByType('attest_bcast').length, 0);
                assert.strictEqual(rewardsByType('attest_fee')[0].amount, '6');
            });

            it('clamps the reimbursement to the escrow when the escrow is thinner than the allowance', async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(
                    feeRequestRow({ redundancy: 1, fee_amount: '0.50000000' }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

                const bcast = rewardsByType('attest_bcast');
                assert.strictEqual(bcast.length, 1);
                assert.strictEqual(bcast[0].amount, '0.5', 'never pays out more than was escrowed');
                assert.strictEqual(rewardsByType('attest_fee').length, 0, 'nothing left to split');
            });

            it('below the flag-day the whole escrow still goes to the split (replay parity)', async function () {
                attestBcastFee.isAttestBroadcastFeeActive.returns(false);
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow({ redundancy: 1 }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

                assert.strictEqual(rewardsByType('attest_bcast').length, 0);
                assert.strictEqual(rewardsByType('attest_fee')[0].amount, '6');
                assert.ok(indexer.util.getFeeOraclePrices.notCalled, 'no oracle read below the gate');
            });

            it('a feeless request pays no reimbursement (nothing is escrowed to carve from)', async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

                assert.strictEqual(data['STATUS'], 'valid');
                assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
            });

            it('a non-ok terminal status refunds the payer and pays no reimbursement', async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow({ redundancy: 1 }));
                const data = v1FeeData();
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }], 'expired'), data, null);

                assert.strictEqual(rewardsByType('attest_bcast').length, 0);
                assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
                assert.strictEqual(indexer.indexerDb.createCredit.firstCall.args[3], FEE_PAYER);
            });

            it('reads the oracle at the SETTLE block, not the request block', async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow({ redundancy: 1 }));
                const data = v1FeeData({ BLOCK_INDEX: 175, BLOCK_TIME: 1700009999 });
                await handler.parse(v1FeeParams([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

                assert.ok(indexer.util.getFeeOraclePrices.calledOnce);
                const [, coin, blockIndex, refTime] = indexer.util.getFeeOraclePrices.firstCall.args;
                assert.strictEqual(coin, 'BTC');
                assert.strictEqual(blockIndex, 175, 'request row block_index is 90; the settle block is what counts');
                assert.strictEqual(refTime, 1700009999);
            });
        });
    });

    describe('version dispatch', function () {
        it('rejects an unknown VERSION (no phase handler runs, no DB writes)', async function () {
            const data = createBaseData({ ACTION: 'ATTEST', FORMAT: 9 });
            // format 9 is not in this.formats → none of the v0/v1/v2 branches run,
            // so the dispatcher returns without touching the DB.
            await handler.parse(['9'], data, null);
            assert.ok(indexer.indexerDb.createAttestationRequest.notCalled);
            assert.ok(indexer.indexerDb.createAttestationResponse.notCalled);
        });
    });

    describe('_injectCallbackExecute internal branches', function () {

        function v1Data(overrides = {}) {
            return createBaseData({
                ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: 100, ACTION_INDEX: 7,
                ...overrides,
            });
        }
        function v1Params(sigs, overrides = {}) {
            const p = { requestId: REQ_ID, providerId: 'http_get', payload: b64('hi'), status: 'ok', meta: 'm', ...overrides };
            const head = ['1', p.requestId, p.providerId, p.payload, p.status, p.meta, String(sigs.length)];
            const tail = [];
            for (const s of sigs) { tail.push(s.pubkey, s.sig); }
            return head.concat(tail);
        }

        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        it('null actionExecute in actionsCtx → callback injection is silently skipped (line 397)', async function () {
            // Remove actionExecute so _injectCallbackExecute returns null immediately (line 397)
            actionsCtx.actionExecute = null;
            handler = new Attest(actionsCtx);

            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

            // Response still recorded; callback index never set
            assert.ok(indexer.indexerDb.createAttestationResponse.calledOnce, 'response row still recorded');
            assert.ok(indexer.indexerDb.setAttestationResponseCallbackIndex.notCalled,
                'no callback index stored when actionExecute is absent');
        });

        it('callback_params_json with invalid JSON → catch branch fires, callbackParams stays []', async function () {
            // Provide a request with malformed callback_params_json; the JSON.parse try/catch
            // in _injectCallbackExecute (lines 404-406) must fire without throwing.
            indexer.indexerDb.getAttestationRequestById.resolves(
                makeRequestRow({ redundancy: 1, callback_params_json: '<<<invalid json>>>' })
            );
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

            // Callback injection still proceeds (callbackParams=[]); no throw
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(executeStub.parse.calledOnce, 'callback still injected despite bad params JSON');
        });

        it('execute.parse returns non-valid STATUS → warning logged, response still valid (lines 455-456)', async function () {
            // Make the EXECUTE emit a non-valid STATUS by mutating emissionData inside the stub
            executeStub.parse.callsFake(async (params, emissionData, err) => {
                emissionData['STATUS'] = 'invalid: some-execute-error';
            });
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

            // The outer response row must still be 'valid' (the warning path, not a throw)
            assert.strictEqual(data['STATUS'], 'valid');
            // releaseSavepoint must still be called (the happy-path completes after the warning)
            assert.ok(indexer.indexerDb.releaseSavepoint.calledOnce);
        });

        it('execute.parse throws → rollbackToSavepoint called and exception swallowed by caller (lines 460-462)', async function () {
            // _parseResponse wraps _injectCallbackExecute in try/catch and swallows the error
            executeStub.parse.rejects(new Error('callback-exploded'));
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();

            // Must not throw outward (the outer try/catch catches it)
            await assert.doesNotReject(
                () => handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null)
            );
            // rollbackToSavepoint called inside _injectCallbackExecute before re-throw
            assert.ok(indexer.indexerDb.rollbackToSavepoint.calledOnce,
                'rollbackToSavepoint must be called when execute.parse throws');
        });

        it('null RESPONSE_PAYLOAD in callback arg uses empty string fallback (line 414)', async function () {
            // Pass null for the payload param (params[3]) so RESPONSE_PAYLOAD ends up null/empty.
            // The `responseData['RESPONSE_PAYLOAD'] || ''` guard fires inside _injectCallbackExecute.
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            // null payload → responseBodyBytes from Buffer.from('', 'base64') = empty → responsePayload=''
            const params = ['1', REQ_ID, 'http_get', '', 'ok', 'm', '1', PUBKEY_A, SIG_A];
            await handler.parse(params, data, null);
            // The handler must not throw; response row recorded and callback injected
            assert.ok(indexer.indexerDb.createAttestationResponse.calledOnce);
            assert.ok(executeStub.parse.calledOnce, 'callback injected with empty payload');
        });

        it('savepoint name is unique per injected callback (suffixed with emission action_index)', async function () {
            indexer.indexerDb.createActionIndex.resolves(42);
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

            assert.ok(indexer.indexerDb.createSavepoint.calledOnce);
            assert.strictEqual(indexer.indexerDb.createSavepoint.firstCall.args[0], 'attestation_callback_42',
                'savepoint name must embed the emission action_index so repeated callbacks in one tx never collide');
        });

    });

    describe('_injectExpiredCallback internal branches', function () {

        function v2Data(overrides = {}) {
            return createBaseData({
                ACTION: 'ATTEST', FORMAT: 2, BLOCK_INDEX: 250, REQUEST_ID: REQ_ID, IS_SYNTHETIC: true,
                ...overrides,
            });
        }

        it('null actionExecute on v2 expire → expire still valid, no callback (line 467)', async function () {
            actionsCtx.actionExecute = null;
            handler = new Attest(actionsCtx);

            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'pending' }));
            const data = v2Data();
            await handler.parse(['2', REQ_ID], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.calledWith(REQ_ID.toLowerCase(), 'expired'));
        });

        it('callback_params_json with invalid JSON on expire → catch branch, expire still succeeds (lines 474-476)', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(
                makeRequestRow({ request_status: 'pending', callback_params_json: '<<<invalid>>>' })
            );
            const data = v2Data();
            await handler.parse(['2', REQ_ID], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(executeStub.parse.calledOnce, 'expiry callback still injected despite bad params JSON');
        });

        it('expire execute.parse returns non-valid STATUS → warning only, expire still valid (lines 517-518)', async function () {
            executeStub.parse.callsFake(async (params, emissionData, err) => {
                emissionData['STATUS'] = 'invalid: expire-execute-error';
            });
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'pending' }));
            const data = v2Data();
            await handler.parse(['2', REQ_ID], data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.releaseSavepoint.calledOnce);
        });

        it('expire execute.parse throws → rollbackToSavepoint called, swallowed by _parseExpire (lines 522-524)', async function () {
            executeStub.parse.rejects(new Error('expire-callback-exploded'));
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'pending' }));
            const data = v2Data();

            await assert.doesNotReject(
                () => handler.parse(['2', REQ_ID], data, null)
            );
            assert.ok(indexer.indexerDb.rollbackToSavepoint.calledOnce,
                'rollbackToSavepoint must be called when expire execute.parse throws');
        });

        it('expire savepoint name is unique per injected callback (suffixed with emission action_index)', async function () {
            indexer.indexerDb.createActionIndex.resolves(77);
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'pending' }));
            const data = v2Data();
            await handler.parse(['2', REQ_ID], data, null);

            assert.ok(indexer.indexerDb.createSavepoint.calledOnce);
            assert.strictEqual(indexer.indexerDb.createSavepoint.firstCall.args[0], 'attestation_expire_callback_77',
                'expire savepoint name must embed the emission action_index');
        });

        it('getValidatorsByCapability throws → missed_count catch block fires, expire still succeeds (lines 367-368)', async function () {
            // Make getValidatorsByCapability throw so _computeResponsibleSet propagates and
            // the outer try/catch in _parseExpire (lines 357-368) fires the warning path.
            indexer.indexerDb.getValidatorsByCapability.rejects(new Error('db-fault'));
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'pending' }));
            const data = v2Data();

            // The outer catch swallows the error (no re-throw)
            await assert.doesNotReject(
                () => handler.parse(['2', REQ_ID], data, null)
            );
            // The expire itself is still committed (updateAttestationRequestStatus called)
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.calledWith(REQ_ID.toLowerCase(), 'expired'),
                'request should still be flipped to expired despite missed_count failure');
        });

        it('empty validator set → _computeResponsibleSet returns [] without crash (line 385)', async function () {
            // getValidatorsByCapability returns [] → the `length === 0` branch returns []
            indexer.indexerDb.getValidatorsByCapability.resolves([]);
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'pending' }));
            const data = v2Data();
            await handler.parse(['2', REQ_ID], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            // incrementAttestationValidatorStat must NOT be called (no validators)
            assert.ok(indexer.indexerDb.incrementAttestationValidatorStat.notCalled);
        });

        it('v2 with undefined REQUEST_ID falls back to empty string (line 331)', async function () {
            // data['REQUEST_ID'] is undefined → `|| ''` fires; getAttestationRequestById('') returns null → no-op
            indexer.indexerDb.getAttestationRequestById.resolves(null);
            const data = v2Data({ REQUEST_ID: undefined });
            await handler.parse(['2', REQ_ID], data, null);
            // No crash and no DB status update
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.notCalled);
        });

        it('multiple validators → _computeResponsibleSet sorts and picks top redundancy (line 392)', async function () {
            // Provide 3 validators so the sort runs with multiple elements, exercising the
            // comparator including the a.hash < b.hash and a.hash > b.hash branches.
            // (The equal branch is a SHA256 collision, genuinely unreachable in practice.)
            indexer.indexerDb.getValidatorsByCapability.resolves([
                { pubkey: PUBKEY_A },
                { pubkey: PUBKEY_B },
                { pubkey: 'c'.repeat(64) },
            ]);
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'pending', redundancy: 2 }));
            const data = v2Data();
            await handler.parse(['2', REQ_ID], data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            // 2 validators picked for missed_count (redundancy=2)
            assert.strictEqual(indexer.indexerDb.incrementAttestationValidatorStat.callCount, 2);
        });

    });

    // STAKE_WEIGHTED_QUORUM: source-deduped responsible-set selection (WI-1)
    // The within-subset quorum stays count-based; only the SELECTION dedupes by
    // staking source so a source's delegated keys can't occupy multiple slots.
    describe('STAKE_WEIGHTED_QUORUM: source-deduped responsible set', function () {
        beforeEach(function () {
            swq.isStakeWeightedQuorumActive.returns(true);   // already stubbed in outer beforeEach
        });

        it('selects at most one responsible slot per staking source', async function () {
            // S1 delegates THREE keys; S2 and S3 one each. redundancy 3.
            indexer.indexerDb.getStakeWeightsByCapability.resolves([
                { pubkey: 'k1a', source: 'S1', weight: '50000' },
                { pubkey: 'k1b', source: 'S1', weight: '50000' },
                { pubkey: 'k1c', source: 'S1', weight: '50000' },
                { pubkey: 'k2',  source: 'S2', weight: '50000' },
                { pubkey: 'k3',  source: 'S3', weight: '50000' },
            ]);
            const srcOf = { k1a: 'S1', k1b: 'S1', k1c: 'S1', k2: 'S2', k3: 'S3' };
            // Weights clear the http_get provider floor (10000) so this vector isolates the
            // source-dedupe rule; the floor itself is exercised in its own describe below.
            const resp = await handler._computeResponsibleSet('req-1', 3, 90, 'http_get');
            const sources = resp.map(pk => srcOf[pk]);
            assert.strictEqual(new Set(sources).size, sources.length, 'a source occupied >1 responsible slot');
            assert.deepStrictEqual([...new Set(sources)].sort(), ['S1', 'S2', 'S3']);
        });

        it('SECURITY: a source with many delegated keys cannot dominate the responsible set', async function () {
            // S1 delegates 5 keys; only S2 besides. redundancy 3, but just 2 sources.
            indexer.indexerDb.getStakeWeightsByCapability.resolves([
                ...['a', 'b', 'c', 'd', 'e'].map(s => ({ pubkey: 'k1' + s, source: 'S1', weight: '50000' })),
                { pubkey: 'k2', source: 'S2', weight: '50000' },
            ]);
            const resp = await handler._computeResponsibleSet('req-2', 3, 90, 'http_get');
            assert.strictEqual(resp.filter(pk => pk.startsWith('k1')).length, 1, 'S1 took more than one slot');
            assert.strictEqual(resp.length, 2, 'responsible set capped at the number of distinct sources');
        });

        it('uses the source-keyed query (not the count query) when weighted', async function () {
            indexer.indexerDb.getStakeWeightsByCapability.resolves([{ pubkey: 'k1', source: 'S1', weight: '50000' }]);
            await handler._computeResponsibleSet('req-3', 1, 90, 'http_get');
            // the declared block 90 is resolved at its buried height; the
            // stake-weighted flag-day still keys on the declared 90 (see snapshotReorgBuffer.test.js).
            assert.ok(indexer.indexerDb.getStakeWeightsByCapability.calledWith(
                'attestation', srb.buriedSnapshotBlock(90, 'regtest')));
            assert.ok(indexer.indexerDb.getValidatorsByCapability.notCalled);
        });
    });

    // Pkg 7 / 87441a53 admission rejection: at/above ATTEST_ADMISSION_ACTIVATION
    // an ATTEST v0 whose responsible set at the request block is smaller than
    // REDUNDANCY is rejected at admission (immediate, never enters 'pending');
    // below the gate the legacy accept-then-expire behavior is bit-identical.
    describe('ATTEST_ADMISSION flag-day: unservable-redundancy rejection', function () {

        function v0Data(overrides = {}) {
            return createBaseData({
                ACTION: 'ATTEST', FORMAT: 0, IS_EMISSION: true, EMITTER: 5, EMITTER_POSITION: 0,
                EMITTER_PATH: '0', ROOT_ACTION_INDEX: 100, BLOCK_INDEX: 100,
                ...overrides,
            });
        }
        function v0Params(reqId, redundancy) {
            return ['0', reqId, 'http_get', 'q', 'onResult', '[]', String(redundancy), '50'];
        }
        function validReqId(data) {
            return deriveReqId(data['TX_HASH'], data['ROOT_ACTION_INDEX'], data['EMITTER_PATH'], data['EMITTER'], data['EMITTER_POSITION']);
        }

        beforeEach(function () {
            attestAdmission.isAttestAdmissionActive.returns(true);   // stubbed off in outer beforeEach
        });

        it('rejects a request whose responsible set is smaller than REDUNDANCY', async function () {
            // Snapshot has ONE validator (default stub); redundancy 3 is unservable.
            const data = v0Data();
            await handler.parse(v0Params(validReqId(data), 3), data, null);
            assert.ok(String(data['STATUS']).includes('REDUNDANCY'),
                'expected responsible-set rejection, got: ' + data['STATUS']);
            assert.strictEqual(data['REQUEST_STATUS'], 'rejected');
            assert.strictEqual(data['RESPONSIBLE_SET_JSON'], undefined,
                'a rejected request must not pin a responsible set');
        });

        it('accepts a request whose responsible set covers REDUNDANCY, pinning the SAME computed set', async function () {
            const data = v0Data();
            await handler.parse(v0Params(validReqId(data), 1), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['REQUEST_STATUS'], 'pending');
            assert.deepStrictEqual(JSON.parse(data['RESPONSIBLE_SET_JSON']), [PUBKEY_A]);
            // Reuses the admission-gate set: exactly ONE responsible-set query.
            assert.strictEqual(indexer.indexerDb.getValidatorsByCapability.callCount, 1,
                'admission gate + RESPONSIBLE_SET_JSON pin must share one computed set');
        });

        it('SWQ source-dedupe shrink below REDUNDANCY is rejected when the gate is active', async function () {
            // Weighted selection dedupes S1's delegated keys to one slot: 2 distinct
            // sources < redundancy 3, the exact 87441a53 liveness hole.
            swq.isStakeWeightedQuorumActive.returns(true);
            indexer.indexerDb.getStakeWeightsByCapability.resolves([
                { pubkey: 'k1a', source: 'S1', weight: '50000' },
                { pubkey: 'k1b', source: 'S1', weight: '50000' },
                { pubkey: 'k2',  source: 'S2', weight: '50000' },
            ]);
            const data = v0Data();
            await handler.parse(v0Params(validReqId(data), 3), data, null);
            assert.ok(String(data['STATUS']).includes('responsible set 2 < 3'),
                'expected deduped-set rejection, got: ' + data['STATUS']);
            assert.strictEqual(data['REQUEST_STATUS'], 'rejected');
        });

        it('below the gate the legacy accept-then-expire path is preserved (replay bit-identical)', async function () {
            attestAdmission.isAttestAdmissionActive.returns(false);
            const data = v0Data();
            await handler.parse(v0Params(validReqId(data), 3), data, null);
            assert.strictEqual(data['STATUS'], 'valid', 'pre-gate replay must still accept: ' + data['STATUS']);
            assert.strictEqual(data['REQUEST_STATUS'], 'pending');
        });

        it('gate queries the request block and network (real module map sanity)', function () {
            // Un-stubbed module semantics: regtest/testnet armed at genesis,
            // mainnet at the STAKE_WEIGHTED_QUORUM anchor, unknown network off.
            const real = require('../../../src/attest_admission_activation.js');
            const fn   = attestAdmission.isAttestAdmissionActive.wrappedMethod || real.isAttestAdmissionActive;
            assert.strictEqual(real.ATTEST_ADMISSION_ACTIVATION.mainnet, 961000);
            assert.strictEqual(fn.call(real, 0, 'regtest'), true);
            assert.strictEqual(fn.call(real, 960999, 'mainnet'), false);
            assert.strictEqual(fn.call(real, 961000, 'mainnet'), true);
            assert.strictEqual(fn.call(real, 100, 'nonet'), false);
            assert.strictEqual(fn.call(real, 'x', 'regtest'), false);
        });
    });

    // ------------------------------------------------------- the response-mirror flag day

    // Above the height a response reaches every indexer through the hub mirror, so the
    // chain leg of the response is retired: an on-chain v1 is refused, and the
    // broadcast-fee carve-out that reimbursed the leader's miner fee goes with it because
    // nobody broadcasts anything to be reimbursed for.
    describe('ATTEST_RESPONSE_MIRROR flag day: the chain handler and the fee', function () {

        function v1Data(overrides = {}) {
            return createBaseData({ ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: 100, ACTION_INDEX: 60, ...overrides });
        }
        function v1Params(sigs, status = 'ok') {
            const head = ['1', REQ_ID, 'http_get', b64('hello'), status, 'm', String(sigs.length)];
            const tail = [];
            for (const s of sigs) { tail.push(s.pubkey, s.sig); }
            return head.concat(tail);
        }

        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        it('an on-chain v1 for a mirror-era request is invalid, with the pinned status', async function () {
            arm.isResponseMirrorActive.returns(true);
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

            // Consensus state: this exact string is the stored verdict a replay
            // re-derives, so it is pinned rather than matched loosely.
            assert.strictEqual(data['STATUS'], 'invalid: ATTEST v1 after mirror activation');
            assert.ok(indexer.indexerDb.createAttestationResponse.calledOnce,
                'the audit row still records the rejected broadcast, as every other v1 refusal does');
            assert.strictEqual(indexer.indexerDb.updateAttestationRequestStatus.called, false,
                'above all it must not close the request: the mirror row is what closes it');
            assert.strictEqual(executeStub.parse.called, false,
                'and no callback fires, or a stale hub could double-deliver');
        });

        it('the same v1 for a LEGACY-era request is served on chain exactly as before', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 1 }));
            const data = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.updateAttestationRequestStatus.calledWith(REQ_ID, 'fulfilled', 100));
            assert.ok(executeStub.parse.calledOnce);
        });

        it('the era is read from the REQUEST block, through the one shared predicate', function () {
            arm.isResponseMirrorActive.returns(true);
            assert.strictEqual(handler.isMirrorEraRequest(makeRequestRow({ block_index: 90 })), true);
            assert.ok(arm.isResponseMirrorActive.calledWith(90, 'regtest'),
                'the request row block, never the response action block and never a hub-stated one');
            assert.strictEqual(handler.isMirrorEraRequest(null), false);
        });

        it('the gate outranks every other request-derived verdict on the same wire', async function () {
            // Each of these rejects on its own below the height. Above it the era answers
            // first, so one wire cannot record two different reasons depending on the
            // request's incidental state.
            arm.isResponseMirrorActive.returns(true);
            for (const row of [makeRequestRow({ request_status: 'fulfilled' }),
                               makeRequestRow({ provider_id: 'llm' }),
                               makeRequestRow({ deadline_block: 1 })]) {
                indexer.indexerDb.getAttestationRequestById.resolves(row);
                const data = v1Data();
                await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
                assert.strictEqual(data['STATUS'], 'invalid: ATTEST v1 after mirror activation');
            }
            // A wire naming no request at all still reports that, because there is no
            // request row to read an era from.
            indexer.indexerDb.getAttestationRequestById.resolves(null);
            const orphan = v1Data();
            await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), orphan, null);
            assert.strictEqual(orphan['STATUS'], 'invalid: REQUEST_ID (no matching request)');
        });

        describe('broadcast-fee retirement', function () {

            const FEE_PAYER = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
            const COIN_USD   = '50000';
            const XCHAIN_USD = '2.5';

            function rewardsByType(type) {
                return indexer.indexerDb.createValidatorReward.getCalls()
                    .filter(c => c.args[2] === type)
                    .map(c => ({ pubkey: c.args[0], amount: String(c.args[3]) }));
            }
            function feeRequestRow(overrides = {}) {
                return makeRequestRow({
                    action_index: 42, fee_amount: '6.00000000', fee_payer: FEE_PAYER,
                    redundancy: 1, ...overrides,
                });
            }

            beforeEach(function () {
                // The carve-out flag day is ARMED throughout this describe: what is under
                // test is that the mirror era retires it anyway, not that an unarmed gate
                // pays nothing.
                attestBcastFee.isAttestBroadcastFeeActive.returns(true);
                indexer.indexerDb.getTokenDecimalPrecision.resolves(8);
                sinon.stub(indexer.util, 'getFeeOraclePrices').resolves({
                    coinUsdPrice: COIN_USD, xchainUsdPrice: XCHAIN_USD, oracleRound: 7,
                });
            });

            it('LEGACY era: the carve-out still pays 2 and the split gets 4', async function () {
                indexer.indexerDb.getAttestationRequestById.resolves(feeRequestRow());
                const data = v1Data();
                await handler.parse(v1Params([{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
                assert.strictEqual(data['STATUS'], 'valid');
                assert.deepStrictEqual(rewardsByType('attest_bcast'), [{ pubkey: PUBKEY_A, amount: '2' }]);
                assert.deepStrictEqual(rewardsByType('attest_fee'), [{ pubkey: PUBKEY_A, amount: '4' }]);
            });

            it('MIRROR era: no attest_bcast row, and the WHOLE escrow splits', async function () {
                // The exact amounts are the point of the row: retiring the carve-out
                // changes real reward amounts above the height, so 4 must become 6.
                arm.isResponseMirrorActive.returns(true);
                const request = feeRequestRow();
                const data = createBaseData({
                    ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: 100, ACTION_INDEX: 60,
                    BLOCK_TIME: 1700000000,
                });
                // Driven through the settle directly: above the height the chain handler
                // refuses the wire, so the settle is reached by the mirror applier, and the
                // retirement has to live where BOTH callers pass through.
                await handler._settleRequestFee(request, data, 'fulfilled');

                assert.deepStrictEqual(rewardsByType('attest_bcast'), [],
                    'nobody broadcast anything, so there is no miner fee to reimburse');
                assert.deepStrictEqual(rewardsByType('attest_fee'), [{ pubkey: PUBKEY_A, amount: '6' }],
                    'the whole escrow splits, so the per-signer amount RISES by the retired carve-out');
                assert.strictEqual(indexer.util.getFeeOraclePrices.called, false,
                    'and the oracle is never read for a conversion that cannot apply');
                assert.strictEqual(String(indexer.indexerDb.createCredit.firstCall.args[2]), '6.00000000',
                    'the pool credit is the full escrow either way');
            });

            it('MIRROR era at REDUNDANCY 3: every signer gets an equal share of the whole escrow', async function () {
                arm.isResponseMirrorActive.returns(true);
                indexer.indexerDb.getValidatorsByCapability.resolves([
                    { pubkey: PUBKEY_A }, { pubkey: PUBKEY_B }, { pubkey: 'c'.repeat(64) },
                ]);
                const data = createBaseData({
                    ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: 100, ACTION_INDEX: 60, BLOCK_TIME: 1700000000,
                });
                await handler._settleRequestFee(feeRequestRow({ redundancy: 3 }), data, 'fulfilled');
                const split = rewardsByType('attest_fee');
                assert.strictEqual(split.length, 3);
                // 6/3 exactly, where the legacy era would have paid (6-2)/3 = 1.33333333.
                for (const row of split) assert.strictEqual(row.amount, '2');
                assert.deepStrictEqual(rewardsByType('attest_bcast'), []);
            });

            it('the retirement keys on the REQUEST block, not the settling action block', async function () {
                // A request admitted below the height settles under the legacy rules
                // however late its response lands, which is what keeps replay stable.
                arm.isResponseMirrorActive.callsFake((block) => Number(block) >= 95);
                const data = createBaseData({
                    ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: 100, ACTION_INDEX: 60, BLOCK_TIME: 1700000000,
                });
                await handler._settleRequestFee(feeRequestRow({ block_index: 90 }), data, 'fulfilled');
                assert.strictEqual(rewardsByType('attest_bcast').length, 1,
                    'request block 90 is below 95, so the legacy carve-out still applies at settle block 100');
            });
        });
    });

    // ------------------------------------------------- ATTEST v5/v6: the response batch

    describe('ATTEST v5/v6 response batch', function () {

        const ANCHOR = 900000;

        function batchRow(i) {
            return {
                network: 'regtest',
                request_id: crypto.createHash('sha256').update('breq' + i).digest('hex'),
                request_action_index: 100 + i, request_block_index: 90 + i,
                provider_id: 'http_get', status: 'ok',
                response_payload: 'body-' + i,
                response_hash: crypto.createHash('sha256').update('body-' + i).digest('hex'),
                meta: 'm', effective_time: 1700000000 + i,
                signer_pubkeys: JSON.stringify([PUBKEY_A]),
                signatures: JSON.stringify([{ pubkey: PUBKEY_A, sig: SIG_A }]),
                widen: 0,
            };
        }
        function batchWindow(rowCount = 2, overrides = {}) {
            const rows = [];
            for (let i = 0; i < rowCount; i++) rows.push(batchRow(i));
            return {
                network: 'regtest', window_start: 1700000000, window_end: 1700003600,
                row_count: rows.length, btc_block_height: ANCHOR, rows,
                sigs: [{ pubkey: PUBKEY_A, sig: SIG_A }],
                ...overrides,
            };
        }
        // Positional params as the decoder hands them over: params[0] is VERSION.
        function wireParams(wire) { return wire.split('|').slice(1); }

        // A handler on the batch rail. COIN comes from a fresh mock config, so the
        // outer BTC fixtures are untouched.
        function batchHandler(coin = 'DOGE') {
            const ix = createMockIndexer();
            ix.config.COIN    = coin;
            ix.config.NETWORK = 'regtest';
            const db = ix.indexerDb;
            db.createAttestationBatchAction = sinon.stub().resolves();
            db.getAttestBatchChunks         = sinon.stub().resolves([]);
            db.setAttestBatchStatus         = sinon.stub().resolves();
            db.getValidatorsByCapability    = sinon.stub().resolves([{ pubkey: PUBKEY_A }]);
            db.getStakeWeightsByCapability  = sinon.stub().resolves([{ pubkey: PUBKEY_A, source: 'SA', weight: '100' }]);
            db.getActiveCapabilityCount     = sinon.stub().resolves(1);
            db.hasCapability                = sinon.stub().resolves(true);
            const h = new Attest({
                config: ix.config, util: ix.util, mapper: ix.mapper,
                decoderDb: ix.decoderDb, indexerDb: db,
                hubClient: { enabled: true },
                protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) },
            });
            return { handler: h, db, ix };
        }
        function batchData(overrides = {}) {
            return createBaseData({
                ACTION: 'ATTEST', FORMAT: 5, BLOCK_INDEX: 6300000, ACTION_INDEX: 71,
                BLOCK_TIME: 1700004000, COIN: 'DOGE', ...overrides,
            });
        }

        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
        });

        it('registers v5 and v6, taking their layouts from the wire module', function () {
            assert.strictEqual(handler.formats[5], abw.ATTEST_BATCH_HEAD_FORMAT);
            assert.strictEqual(handler.formats[6], abw.ATTEST_BATCH_CONTINUATION_FORMAT);
            assert.ok(handler.formats[5].startsWith('VERSION|BATCH_KEY|'));
        });

        it('a good batch is valid and stages an attest_batch hub push', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            const win = batchWindow(2);
            const enc = abw.encodeAttestBatch(win);
            const data = batchData();
            await h.parse(wireParams(enc.wires[0]), data, null);

            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['REQUEST_ID'], enc.batchKey, 'the action is filed under the batch key');
            assert.ok(db.createAttestationBatchAction.calledOnce);
            assert.ok(db.enqueueHubPushTx.calledOnce);
            assert.strictEqual(db.enqueueHubPushTx.firstCall.args[0], 'attest_batch');

            // The key set IS the interface: the hub destructures exactly these, and a
            // typo fails silently at runtime rather than loudly at build time.
            const payload = db.enqueueHubPushTx.firstCall.args[1];
            assert.deepStrictEqual(Object.keys(payload).sort(), [
                'action_index', 'block_index', 'block_time', 'btc_block_height', 'network',
                'push_generation', 'row_count', 'rows', 'sigs', 'source_chain',
                'window_end', 'window_start',
            ]);
            assert.strictEqual(payload.source_chain, 'DOGE');
            assert.strictEqual(payload.network, 'regtest');
            assert.strictEqual(payload.window_start, win.window_start);
            assert.strictEqual(payload.window_end, win.window_end);
            assert.strictEqual(payload.row_count, 2);
            assert.strictEqual(payload.btc_block_height, ANCHOR);
            assert.strictEqual(payload.action_index, 71);
            assert.strictEqual(payload.block_index, 6300000);
            assert.strictEqual(payload.block_time, 1700004000);
            assert.deepStrictEqual(payload.rows, JSON.parse(abw.buildAttestBatchBody(win)).rows,
                'the reassembled body verbatim, so the hub re-verifies the bytes this node verified');
            assert.deepStrictEqual(payload.sigs, [{ pubkey: PUBKEY_A, sig: SIG_A }]);

            // Staged for live delivery inside the same block transaction that wrote the
            // durable row, exactly as the PRICE batch is.
            assert.ok(db.stageHubPush.calledOnce);
            assert.strictEqual(db.stageHubPush.firstCall.args[0].pushType, 'attest_batch');
        });

        it('an empty window (row_count 0) is a valid batch and still pushes', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            const enc = abw.encodeAttestBatch(batchWindow(0));
            const data = batchData();
            await h.parse(wireParams(enc.wires[0]), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(db.enqueueHubPushTx.firstCall.args[1].row_count, 0,
                'every window publishes, which is what makes coverage provable for a chain-only node');
        });

        it('a bad batch quorum is invalid, with no push and no partial absorb', async function () {
            ed25519.verify.returns(false);
            const { handler: h, db } = batchHandler('DOGE');
            const enc = abw.encodeAttestBatch(batchWindow(2));
            const data = batchData();
            await h.parse(wireParams(enc.wires[0]), data, null);

            assert.strictEqual(data['STATUS'], 'invalid: insufficient PBFT quorum (0/1)');
            assert.ok(db.createAttestationBatchAction.calledOnce, 'the verdict is still recorded');
            assert.strictEqual(db.enqueueHubPushTx.called, false, 'and nothing reaches the hub');
        });

        it('a signer outside the attestation capability snapshot does not count', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            db.getValidatorsByCapability.resolves([{ pubkey: PUBKEY_B }]);
            const enc = abw.encodeAttestBatch(batchWindow(1));
            const data = batchData();
            await h.parse(wireParams(enc.wires[0]), data, null);
            assert.match(data['STATUS'], /^invalid: insufficient PBFT quorum/);
            // Resolved at the batch's signed BTC anchor, never at this DOGE landing
            // height: capability_snapshots.snapshot_block is a BTC height.
            assert.ok(db.getValidatorsByCapability.calledWith('attestation', ANCHOR));
        });

        it('takes the stake-weighted quorum at and above the SWQ anchor', async function () {
            swq.isStakeWeightedQuorumActive.returns(true);
            const { handler: h, db } = batchHandler('DOGE');
            const enc = abw.encodeAttestBatch(batchWindow(1));
            const data = batchData();
            await h.parse(wireParams(enc.wires[0]), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(db.getStakeWeightsByCapability.calledWith('attestation', ANCHOR));
            assert.strictEqual(db.getActiveCapabilityCount.called, false,
                'the count denominator belongs to the unweighted branch only');
        });

        it('NEVER resolves a per-row responsible set on the batch rail', async function () {
            // Structural, not incidental: _computeResponsibleSet returns [] off BTC, so a
            // batch that tried to verify rows here would refuse every honest one. Per-row
            // verification happens on the BTC indexer after the hub re-serves the row.
            const { handler: h } = batchHandler('DOGE');
            const spy = sinon.spy(h, '_computeResponsibleSet');
            const enc = abw.encodeAttestBatch(batchWindow(3));
            await h.parse(wireParams(enc.wires[0]), batchData(), null);
            assert.strictEqual(spy.called, false);
        });

        for (const coin of ['BTC', 'LTC']) {
            it(`is invalid on ${coin}: batches ride the DOGE rail`, async function () {
                const { handler: h, db } = batchHandler(coin);
                const enc = abw.encodeAttestBatch(batchWindow(1));
                const head = batchData({ COIN: coin });
                await h.parse(wireParams(enc.wires[0]), head, null);
                assert.strictEqual(head['STATUS'], 'invalid: ATTEST v5 (batches ride the DOGE rail)');
                assert.strictEqual(db.enqueueHubPushTx.called, false);

                // A well-formed continuation wire, so the refusal is the plane and not
                // the shape: BATCH_KEY|CHUNK_INDEX|TOTAL_CHUNKS|BATCH_CRC32|BODY.
                const cont = batchData({ COIN: coin, FORMAT: 6, ACTION_INDEX: 72 });
                await h.parse(['6', enc.batchKey, '1', '2', enc.batchCrc32, 'QUJD'], cont, null);
                assert.strictEqual(cont['STATUS'], 'invalid: ATTEST v6 (batches ride the DOGE rail)');
            });
        }

        it('refuses a batch declaring another network', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            const enc = abw.encodeAttestBatch(batchWindow(1, { network: 'testnet' }));
            const data = batchData();
            await h.parse(wireParams(enc.wires[0]), data, null);
            assert.strictEqual(data['STATUS'], 'invalid: NETWORK (batch declares testnet)');
            assert.strictEqual(db.enqueueHubPushTx.called, false);
        });

        it('a structurally broken head is recorded invalid and never pushed', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            const data = batchData();
            await h.parse(['5', 'not-a-key'], data, null);
            assert.match(data['STATUS'], /^invalid: ATTEST_BATCH \(/);
            assert.strictEqual(db.createAttestationBatchAction.firstCall.args[0]['REQUEST_ID'], '',
                'no key could be derived, so none is filed');
            assert.strictEqual(db.enqueueHubPushTx.called, false);
        });

        it('a v6 continuation records itself and absorbs nothing', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            // A window big enough to actually chunk, so the continuation is a real wire.
            const rows = [];
            for (let i = 0; i < 40; i++) {
                const r = batchRow(i);
                let noise = '';
                for (let k = 0; k < 8; k++)
                    noise += crypto.createHash('sha512').update('n:' + i + ':' + k).digest('base64');
                r.response_payload = noise;
                rows.push(r);
            }
            const enc = abw.encodeAttestBatch({
                network: 'regtest', window_start: 1, window_end: 2, row_count: 40,
                btc_block_height: ANCHOR, rows, sigs: [{ pubkey: PUBKEY_A, sig: SIG_A }],
            });
            assert.ok(enc.totalChunks > 1, 'the fixture must actually chunk');

            const data = batchData({ FORMAT: 6, ACTION_INDEX: 80 });
            await h.parse(wireParams(enc.wires[1]), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['REQUEST_ID'], enc.batchKey, 'a continuation names its head by the batch key');
            assert.ok(db.createAttestationBatchAction.calledOnce);
            assert.strictEqual(db.enqueueHubPushTx.called, false,
                'the head owns the verdict and the absorption; a chunk carries neither');
        });

        it('pushes nothing when the node has no hub client', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            h.hubClient = null;
            const enc = abw.encodeAttestBatch(batchWindow(1));
            const data = batchData();
            await h.parse(wireParams(enc.wires[0]), data, null);
            assert.strictEqual(data['STATUS'], 'valid', 'a hub-less node judges the batch identically');
            assert.strictEqual(db.enqueueHubPushTx.called, false);
        });

        // --------------------------------------------- multi-chunk: the stored chunk table

        // A window whose encoding lands on exactly `want` wires. The row bodies are
        // deterministic hash noise, which barely deflates, so each added row grows the
        // compressed body by far less than one wire and the search below cannot step over
        // the size it is looking for.
        function chunkedBatch(want) {
            for (let n = 1; n <= 200; n++) {
                const rows = [];
                for (let i = 0; i < n; i++) {
                    const r = batchRow(i);
                    let noise = '';
                    for (let k = 0; k < 8; k++)
                        noise += crypto.createHash('sha512').update('n:' + i + ':' + k).digest('base64');
                    r.response_payload = noise;
                    r.response_hash = crypto.createHash('sha256').update(noise).digest('hex');
                    rows.push(r);
                }
                const win = {
                    network: 'regtest', window_start: 1700000000, window_end: 1700003600,
                    row_count: n, btc_block_height: ANCHOR, rows,
                    sigs: [{ pubkey: PUBKEY_A, sig: SIG_A }],
                };
                const enc = abw.encodeAttestBatch(win);
                if (enc.totalChunks === want) return { win, enc };
            }
            throw new Error('no window of this fixture shape encodes to ' + want + ' chunks');
        }

        // A stand-in for the attests chunk table: the handler's own stamped columns go in,
        // and the read serves back exactly what the real query does (valid rows carrying a
        // slot, ordered by slot then action index).
        function chunkStore(db) {
            const rows = [];
            db.createAttestationBatchAction = sinon.stub().callsFake(async (d) => {
                rows.push({
                    action_index: Number(d['ACTION_INDEX']), version: Number(d['VERSION']),
                    request_id: d['REQUEST_ID'], status: d['STATUS'],
                    window_start: d['WINDOW_START'], window_end: d['WINDOW_END'],
                    row_count: d['ROW_COUNT'], btc_block_height: d['BTC_BLOCK_HEIGHT'],
                    batch_crc32: d['BATCH_CRC32'], total_chunks: d['TOTAL_CHUNKS'],
                    chunk_index: d['CHUNK_INDEX'], chunk_b64: d['CHUNK_B64'],
                });
            });
            db.getAttestBatchChunks = sinon.stub().callsFake(async (key) => rows
                .filter(r => r.request_id === key && r.status === 'valid' && r.chunk_index != null)
                .sort((a, b) => (a.chunk_index - b.chunk_index) || (a.action_index - b.action_index)));
            db.setAttestBatchStatus = sinon.stub().callsFake(async (actionIndex, status) => {
                for (const r of rows) if (r.action_index === Number(actionIndex)) r.status = status;
            });
            return rows;
        }

        // Land one wire of `enc` as its own action. Wire 0 is the v5 head, the rest v6.
        async function land(h, enc, wireIndex, actionIndex) {
            const data = batchData({
                FORMAT: wireIndex === 0 ? 5 : 6,
                ACTION_INDEX: actionIndex,
                BLOCK_INDEX: 6300000 + wireIndex,
            });
            await h.parse(wireParams(enc.wires[wireIndex]), data, null);
            return data;
        }

        it('a two-chunk batch absorbs exactly once, on the continuation that completes it', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            chunkStore(db);
            const { win, enc } = chunkedBatch(2);

            const head = await land(h, enc, 0, 71);
            assert.strictEqual(head['STATUS'], 'valid', 'a head with chunks outstanding is sound, not faulty');
            assert.strictEqual(db.enqueueHubPushTx.called, false, 'and has delivered nothing yet');

            const cont = await land(h, enc, 1, 72);
            assert.strictEqual(cont['STATUS'], 'valid');
            assert.strictEqual(db.enqueueHubPushTx.callCount, 1, 'the completing chunk absorbs, once');
            assert.strictEqual(db.enqueueHubPushTx.firstCall.args[0], 'attest_batch');

            const payload = db.enqueueHubPushTx.firstCall.args[1];
            assert.deepStrictEqual(payload.rows, JSON.parse(abw.buildAttestBatchBody(win)).rows,
                'the reassembled body verbatim, so the hub verifies the bytes the chain carried');
            assert.strictEqual(payload.row_count, win.row_count);
            assert.strictEqual(payload.action_index, 72,
                'the completing action, which is the one whose rollback un-lands the delivery');
            assert.strictEqual(db.stageHubPush.callCount, 1);
        });

        it('a three-chunk batch absorbs once when the head lands LAST, out of order', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            chunkStore(db);
            const { win, enc } = chunkedBatch(3);

            // Chunk 2 before chunk 1 before the head: none of the three can absorb until
            // the set is complete, and only the completing action does.
            const c2 = await land(h, enc, 2, 71);
            const c1 = await land(h, enc, 1, 72);
            assert.strictEqual(c2['STATUS'], 'valid');
            assert.strictEqual(c1['STATUS'], 'valid');
            assert.strictEqual(db.enqueueHubPushTx.called, false,
                'a chunk with no head on chain has nothing to verify against');

            const head = await land(h, enc, 0, 73);
            assert.strictEqual(head['STATUS'], 'valid');
            assert.strictEqual(db.enqueueHubPushTx.callCount, 1, 'the head completes the coverage and absorbs');
            assert.deepStrictEqual(db.enqueueHubPushTx.firstCall.args[1].rows,
                JSON.parse(abw.buildAttestBatchBody(win)).rows);
        });

        it('a missing chunk never absorbs', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            chunkStore(db);
            const { enc } = chunkedBatch(3);

            await land(h, enc, 0, 71);
            const c2 = await land(h, enc, 2, 72);

            assert.strictEqual(c2['STATUS'], 'valid', 'the chunk itself is well formed');
            assert.strictEqual(db.enqueueHubPushTx.called, false,
                'coverage is an index SET: two of three slots is not a batch');
            assert.strictEqual(db.setAttestBatchStatus.called, false,
                'and an incomplete batch is not a failed one, so the head keeps its verdict');
        });

        it('a duplicate continuation is inert: refused, and absorbing nothing a second time', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            chunkStore(db);
            const { enc } = chunkedBatch(2);

            await land(h, enc, 0, 71);
            await land(h, enc, 1, 72);
            assert.strictEqual(db.enqueueHubPushTx.callCount, 1);

            const replay = await land(h, enc, 1, 73);
            assert.strictEqual(replay['STATUS'], 'invalid: CHUNK_INDEX (duplicate)');
            assert.strictEqual(db.enqueueHubPushTx.callCount, 1,
                'a replayed chunk must not push the same window at the hub twice');
        });

        it('a corrupted chunk reds the batch on the HEAD, leaving the honest chunk valid', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            const stored = chunkStore(db);
            const { enc } = chunkedBatch(2);

            await land(h, enc, 0, 71);

            // The same slot and the same declared geometry, with the body bytes mangled:
            // the wire is well formed, the reassembled window is not. Field 0 of a wire is
            // the action name, so the body sits one past its position in the format string.
            const wire = enc.wires[1].split('|');
            const body = wire[6];
            wire[6] = body.slice(0, body.length - 8) + 'AAAAAAAA';
            const cont = batchData({ FORMAT: 6, ACTION_INDEX: 72 });
            await h.parse(wire.slice(1), cont, null);

            assert.strictEqual(cont['STATUS'], 'valid', 'the chunk carried well-formed bytes of its own');
            assert.strictEqual(db.enqueueHubPushTx.called, false, 'nothing reaches the hub');
            assert.strictEqual(db.setAttestBatchStatus.callCount, 1, 'the batch verdict lands on the head');
            assert.strictEqual(db.setAttestBatchStatus.firstCall.args[0], 71);
            assert.match(db.setAttestBatchStatus.firstCall.args[1], /^invalid: ATTEST_BATCH \(/);
            assert.strictEqual(stored.find(r => r.action_index === 72).status, 'valid');
        });

        it('refuses a continuation whose geometry disagrees with its head', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            chunkStore(db);
            const { enc } = chunkedBatch(2);
            await land(h, enc, 0, 71);

            // A different encoding of the same window: same batch key, another chunk count.
            const wire = enc.wires[1].split('|');
            wire[4] = '3';
            const cont = batchData({ FORMAT: 6, ACTION_INDEX: 72 });
            await h.parse(wire.slice(1), cont, null);
            assert.strictEqual(cont['STATUS'], 'invalid: TOTAL_CHUNKS (does not match the batch head)');

            // And one whose CRC names a body this head never declared.
            const other = enc.wires[1].split('|');
            other[5] = 'deadbeef';
            const cont2 = batchData({ FORMAT: 6, ACTION_INDEX: 73 });
            await h.parse(other.slice(1), cont2, null);
            assert.strictEqual(cont2['STATUS'], 'invalid: BATCH_CRC32 (does not match the batch head)');
            assert.strictEqual(db.enqueueHubPushTx.called, false);
        });

        it('the head stores slot 0 and the window header a later chunk rebuilds it from', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            const stored = chunkStore(db);
            const { win, enc } = chunkedBatch(2);
            await land(h, enc, 0, 71);

            const row = stored[0];
            assert.strictEqual(row.chunk_index, 0, 'the head owns slot 0');
            assert.strictEqual(row.total_chunks, 2);
            assert.strictEqual(row.batch_crc32, enc.batchCrc32);
            assert.strictEqual(row.window_start, win.window_start);
            assert.strictEqual(row.window_end, win.window_end);
            assert.strictEqual(row.row_count, win.row_count);
            assert.strictEqual(row.btc_block_height, ANCHOR);
            assert.ok(row.chunk_b64 && row.chunk_b64.length > 0, 'and its own slice of the body');
        });

        it('a bad quorum on a completed batch reds the head and pushes nothing', async function () {
            const { handler: h, db } = batchHandler('DOGE');
            chunkStore(db);
            const { enc } = chunkedBatch(2);
            await land(h, enc, 0, 71);

            ed25519.verify.returns(false);
            await land(h, enc, 1, 72);
            assert.strictEqual(db.enqueueHubPushTx.called, false);
            assert.match(db.setAttestBatchStatus.firstCall.args[1], /^invalid: insufficient PBFT quorum/,
                'the completing chunk is judged on the same quorum a single-wire head is');
        });

        it('the delivery arm knows the attest_batch push type', function () {
            const src = fs.readFileSync(path.join(__dirname, '../../../src/XChainIndexer.js'), 'utf8');
            assert.match(src, /entry\.pushType === 'attest_batch'/,
                'a staged push whose type no arm handles is left undelivered and silent');
            assert.match(src, /pushAttestBatch/);
        });
    });
});

/*********************************************************************
 * the responsible-set SWQ gate is BTC-ANCHORED.
 *
 * isStakeWeightedQuorumActive() compares against 961000, a BTC height. But
 * _computeResponsibleSet was handed the ATTEST action's LOCAL height, and ATTEST
 * is registered on all three chains. LTC and DOGE sit at ~3.16M and ~6.3M local,
 * so a non-BTC indexer resolved `weighted` TRUE out of band, long before the
 * anchor, while xchain-hub's AttestationRound resolved it FALSE from a real BTC
 * height (it polls the BTC indexer). The function's own header demands
 * byte-for-byte agreement with that hub routine "or validation forks".
 *
 * The disagreement is LATENT at HEAD, not exploitable: capability staking is
 * BTC-only and LTC/DOGE declare no STAKING.CAPABILITIES, so both lookups return
 * [] and the set is empty either way. These tests pin the plane so it stays
 * fixed if attestation is ever configured or mirrored off BTC, which is the
 * moment it would otherwise become a live fork.
 ********************************************************************/
describe('ATTEST responsible-set is BTC-anchored (#3233) @regression @tier1', function () {

    // A local height comfortably past the 961000 BTC anchor, which is where every
    // LTC/DOGE indexer already sits.
    const PAST_ANCHOR = 3160000;

    function handlerForCoin(coin) {
        const ix = createMockIndexer();
        ix.config.COIN    = coin;
        ix.config.NETWORK = 'mainnet';
        const db = ix.indexerDb;
        // Both lookups return a NON-empty set, so the test can observe which branch
        // ran. At HEAD these are empty off BTC, which is exactly what hides the bug.
        db.getStakeWeightsByCapability = sinon.stub().resolves([
            { pubkey: 'a'.repeat(64), source: 'src1', weight: '50000' },
            { pubkey: 'b'.repeat(64), source: 'src2', weight: '50000' }
        ]);
        db.getValidatorsByCapability = sinon.stub().resolves([
            { pubkey: 'a'.repeat(64) },
            { pubkey: 'b'.repeat(64) }
        ]);
        return { handler: new Attest({
            config: ix.config, util: ix.util, mapper: ix.mapper,
            decoderDb: ix.decoderDb, indexerDb: db,
            protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) }
        }), db };
    }

    afterEach(() => sinon.restore());

    for (const coin of ['LTC', 'DOGE']) {
        it(`${coin}: returns an empty set without consulting the BTC-anchored gate`, async function () {
            const { handler, db } = handlerForCoin(coin);
            const out = await handler._computeResponsibleSet('req-1', 2, PAST_ANCHOR, 'http_get');
            assert.deepStrictEqual(out, [],
                'capability staking is BTC-only; a non-BTC indexer has no responsible set');
            assert.strictEqual(db.getStakeWeightsByCapability.called, false,
                'the weighted branch must not be reached off BTC: resolving it from a local ' +
                'height already past 961000 is the out-of-band selection this fixes');
            assert.strictEqual(db.getValidatorsByCapability.called, false);
        });
    }

    it('BTC: still evaluates the gate, because there the local height IS a BTC height', async function () {
        const { handler, db } = handlerForCoin('BTC');
        const out = await handler._computeResponsibleSet('req-1', 2, PAST_ANCHOR, 'http_get');
        assert.strictEqual(out.length, 2, 'BTC must still resolve a responsible set');
        assert.strictEqual(db.getStakeWeightsByCapability.called, true,
            'past the anchor on BTC the weighted branch is correct and must still run');
    });

    it('BTC below the anchor takes the legacy unweighted branch', async function () {
        const { handler, db } = handlerForCoin('BTC');
        await handler._computeResponsibleSet('req-1', 2, 900000, 'http_get');
        assert.strictEqual(db.getValidatorsByCapability.called, true);
        assert.strictEqual(db.getStakeWeightsByCapability.called, false,
            'below 961000 the gate is off, so replay of pre-anchor history is unchanged');
    });

    // The two implementations are required to agree byte-for-byte; agreeing only by
    // both reaching [] via different routes is how they drift apart later.
    it('rollback.js short-circuits on the SAME condition, not just to the same answer', function () {
        const src = fs.readFileSync(path.join(__dirname, '../../../src/rollback.js'), 'utf8');
        assert.match(src, /if\(this\.config\['COIN'\] === 'BTC'\)/,
            'the reorg recompute must gate on COIN the way attest.js does, or ' +
            'reorg-recomputed missed_count diverges from the live expiry path');
        assert.match(src, /#3233/, 'and say why, so it is not "simplified" back');
    });
});
