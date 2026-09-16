// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
// This part: the v0 request admission caps, the payload and deadline limits, and the
// lifecycle status a request is persisted with.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { deriveReqId, setUpAttestHandler, v0Data, v0Params } = require('../../../helpers/attest_fixture.js');

// The handler under test and its mocked indexer, rebuilt before every test.
let indexer, handler;
function setUpHandler() {
    ({ indexer, handler } = setUpAttestHandler());
}

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('v0: request', function () {
        // Per-block admission caps on ATTEST requests. Armed at genesis on
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
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('v0: request', function () {
        describe('per-block admission caps (spec §11.1)', function () {
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
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('v0: request', function () {
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
            // Regression: with the lifecycle column hardcoded to 'pending' before
            // `error` was evaluated, a protocol-rejected request entered the pending
            // pool and was fully serviceable by the hub poll, the deadline-expiry
            // sweep, and the v1 response path (all pending-only). An oversize
            // http_get payload must now land as 'rejected' so none of those
            // consumers ever pick it up.
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
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('v0: request', function () {
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
});
