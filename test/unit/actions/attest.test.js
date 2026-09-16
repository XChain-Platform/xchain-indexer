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
// THE ATTEST HANDLER SUITE. One handler, split by behaviour across
// test/unit/actions/attest.test.js and its parts in test/unit/actions/attest.test/, every part under
// the same suite title so each full test title is what it was when the suite was
// one file. The shared setup, the wire builders and the fixture constants live in
// test/helpers/attest_fixture.js; the batch-rail fixtures in
// test/helpers/attest_batch_rail_fixture.js.
//
// This part: the v0 request, its deterministic request_id and the field checks.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const srb = require('../../../src/snapshot_reorg_buffer.js');
const { PUBKEY_A, REQ_ID, deriveReqId, GOLDEN_REQUEST_ID, setUpAttestHandler, v0Data, v0Params } = require('../../helpers/attest_fixture.js');

// The handler under test and its mocked indexer, rebuilt before every test.
let indexer, handler;
function setUpHandler() {
    ({ indexer, handler } = setUpAttestHandler());
}

// ───────────────────────────────────────────────────────────────────────
// v0: Request (VM emission only)
// ───────────────────────────────────────────────────────────────────────
describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('v0: request', function () {
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
                'indexer preimage drifted from xchain-vm/src/gateway_emit.js GOLDEN_VECTORS.requestId');
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
            // later one, which is exactly what this case pins.
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
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('v0: request', function () {
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
            // The defect this guards: emitted-action action_index is assigned by a
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
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('v0: request', function () {
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
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('v0: request', function () {
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
    });
});
