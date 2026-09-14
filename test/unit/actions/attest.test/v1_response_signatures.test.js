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
// This part: the v1 response signature list, the request-id case, duplicate signers,
// the redundancy quorum and the snapshot the capable set is read at.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const srb = require('../../../../src/snapshot_reorg_buffer.js');
// Same module instance Attest holds a reference to (Node module cache); stubbing
// `verify` here controls signature acceptance inside the handler.
const ed25519 = require('../../../../src/consensus/ed25519.js');
const { PUBKEY_A, PUBKEY_B, SIG_A, SIG_B, REQ_ID, b64, makeRequestRow, setUpAttestHandler, v1Data, v1Params, verifyAllSignatures } = require('../../../helpers/attest_fixture.js');

// The handler under test and its mocked indexer, rebuilt before every test.
let indexer, actionsCtx, handler, executeStub;
function setUpHandler() {
    ({ indexer, actionsCtx, handler, executeStub } = setUpAttestHandler());
}

// ───────────────────────────────────────────────────────────────────────
// v1: Response (validator broadcast). The security-critical path.
//
// NOTE on quorum: ATTEST v1 quorum is REDUNDANCY-based; a response is valid
// when validSigs >= request.redundancy (attest.js parseResponse). The
// 2f+1 PBFT formula lives in PRICE v0, not here; see price.test.js.
// ───────────────────────────────────────────────────────────────────────
describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('v1: response', function () {
        beforeEach(verifyAllSignatures);
        // ── sig-list parser ──────────────────────────────────────────────

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
        // LOWERCASE rid. parseResponse normalizes once, up front, so the canonical
        // it verifies against is byte-identical to the hub's signed bytes no matter
        // what case a producer puts on the wire (the byte-identity does not rest on
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
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('v1: response', function () {
        beforeEach(verifyAllSignatures);
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
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('v1: response', function () {
        beforeEach(verifyAllSignatures);
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

        // ── duplicate-pubkey deduplication ───────────────────────────────

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
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('v1: response', function () {
        beforeEach(verifyAllSignatures);
        // ── quorum threshold (REDUNDANCY-based) ──────────────────────────

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
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('v1: response', function () {
        beforeEach(verifyAllSignatures);
        // ── snapshot block selection ─────────────────────────────────────

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
            // per-tx consensus path; the batched read now answers every signer.
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
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('v1: response', function () {
        beforeEach(verifyAllSignatures);
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
    });
});
