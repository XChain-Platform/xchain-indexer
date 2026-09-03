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
// ---------------------------------------------------------------------------
// ATTEST v1 response-verification byte vectors.
//
// These vectors were CAPTURED by driving the real _parseResponse handler BEFORE
// the verify block was factored out into src/attest_response_verify.js
// (the ATTEST response-mirror design, §4.3 row 7), and they are
// asserted against the refactored path afterwards. That is the whole point of the
// file: the extraction is a pure refactor, so every byte it produces must be the
// byte the chain path produced at the commit before it.
//
// TWO things are pinned, and they are equally consensus-visible:
//
//   1. The CANONICAL BYTES the signature check runs over. A changed canonical
//      rejects every honest signature and expires every request.
//   2. The exact `error` STRING. It is written verbatim to `attests.status` by
//      the caller, so it is hashed into the ledger; a reworded message is a fork,
//      not a cosmetic change.
//
// The canonical is observed rather than re-derived: ed25519.verify is wrapped and
// the payload it is handed IS the capture. Re-deriving the string in the test
// would make the test agree with a rewritten implementation for the same wrong
// reason the implementation was wrong.
//
// Keys are derived from FIXED seeds, not generated: the responsible set is a hash
// ranking over pubkeys, so random keys would reshuffle which validator is
// responsible from run to run and silently turn the responsible-set vectors into
// coin flips.
//
// The capability-read stub answers ONLY at the once-buried height
// (declared 90 - CANONICAL_REORG_BUFFER 6 = 84) and returns an empty set at every
// other height. That is deliberate: it makes a second burial of the snapshot
// height a RED test rather than a silent set change.
// ---------------------------------------------------------------------------

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Attest  = require('../../../src/actions/attest.js');
const avr     = require('../../../src/attest_response_verify.js');
const swq     = require('../../../src/stake_weighted_quorum.js');
const attestAdmission = require('../../../src/attest_admission_activation.js');
const attestBcastFee  = require('../../../src/attest_broadcast_fee_activation.js');
const srb     = require('../../../src/snapshot_reorg_buffer.js');
const eq      = require('../../../src/equivocation_header.js');
// Same module instance the handler (and the extracted verifier) hold: wrapping
// `verify` here observes the exact canonical Buffer both are handed.
const ed25519 = require('../../../src/ed25519.js');

// ---------------------------------------------------------------------------
// Deterministic Ed25519 identities from fixed 32-byte seeds.
// ---------------------------------------------------------------------------
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function keyFromSeed(seedByte) {
    const seed = Buffer.alloc(32, seedByte);
    const priv = crypto.createPrivateKey({
        key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8',
    });
    const spki = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' });
    // SPKI = 12-byte Ed25519 header + the 32 raw pubkey bytes.
    return { priv, pubkey: spki.subarray(12).toString('hex') };
}

const K1 = keyFromSeed(0x11);
const K2 = keyFromSeed(0x22);
const K3 = keyFromSeed(0x33);

// A format-valid signature that no key ever produced.
const JUNK_SIG = 'f'.repeat(128);

// Mixed-case on the wire on purpose: the ATTEST_CANONICAL_LOWERCASE_ID gate picks
// between these two spellings INSIDE the signed bytes, so a single-case id would
// make that vector prove nothing.
const REQ_ID_WIRE  = 'D'.repeat(32) + 'd'.repeat(32);
const REQ_ID_LOWER = REQ_ID_WIRE.toLowerCase();

const DECLARED_BLOCK = 90;                                        // the request's own block
const BURIED_BLOCK   = srb.buriedSnapshotBlock(DECLARED_BLOCK, 'regtest');   // 84
const DEADLINE_BLOCK = 200;

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// Rank the candidate keys the way _computeResponsibleSet does, so a vector can say
// "sign with the validator that is NOT responsible" without hard-coding which of
// the three fixed keys that happens to be.
function rankByResponsibleHash(pubkeys, requestId) {
    return pubkeys
        .map(pk => ({
            pubkey: pk,
            hash: crypto.createHash('sha256').update(String(requestId), 'utf8').update(pk, 'utf8').digest('hex'),
        }))
        .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
        .map(v => v.pubkey);
}

const RANK3 = rankByResponsibleHash([K1.pubkey, K2.pubkey, K3.pubkey], REQ_ID_LOWER);
const KEY_BY_PUBKEY = {};
for (const k of [K1, K2, K3]) KEY_BY_PUBKEY[k.pubkey] = k;

describe('ATTEST v1 response verification: captured byte vectors @regression @tier1', function () {

    let indexer, handler, capturedCanonical;

    function makeRequestRow(overrides = {}) {
        return {
            request_id:           REQ_ID_LOWER,
            provider_id:          'http_get',
            request_status:       'pending',
            deadline_block:       DEADLINE_BLOCK,
            block_index:          DECLARED_BLOCK,
            redundancy:           1,
            contract_index:       5,
            callback_method:      'onResult',
            callback_params_json: '[]',
            ...overrides,
        };
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        const db = indexer.indexerDb;

        db.getContract                       = sinon.stub().resolves({ contract_index: 5 });
        db.createAttestationRequest          = sinon.stub().resolves();
        db.getAttestationAdmissionCounts     = sinon.stub().resolves({ total: 0, byContract: 0 });
        db.getAttestationRequestById         = sinon.stub().resolves(makeRequestRow());
        db.hasCapability                     = sinon.stub().resolves(true);
        db.createAttestationResponse         = sinon.stub().resolves();
        db.incrementAttestationValidatorStat = sinon.stub().resolves();
        db.updateAttestationRequestStatus    = sinon.stub().resolves();
        db.setAttestationResponseCallbackIndex = sinon.stub().resolves();
        db.createValidatorReward             = sinon.stub().resolves(true);
        db.createSavepoint                   = sinon.stub().resolves('sp1');
        db.releaseSavepoint                  = sinon.stub().resolves();
        db.rollbackToSavepoint               = sinon.stub().resolves();

        // Height-sensitive by design (see the header): the set exists at the ONCE-buried
        // height and nowhere else.
        db.getValidatorsByCapability   = sinon.stub().resolves([]);
        db.getStakeWeightsByCapability = sinon.stub().resolves([]);

        handler = new Attest({
            config:        indexer.config,
            util:          indexer.util,
            mapper:        indexer.mapper,
            decoderDb:     indexer.decoderDb,
            indexerDb:     db,
            actionExecute: { parse: sinon.stub().resolves() },
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true),
            },
        });
        indexer.util.resetLists();

        // regtest arms every flag-day at genesis; pin the two that would otherwise move
        // a vector's branch out from under it. Each vector re-arms what it needs.
        sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
        sinon.stub(attestAdmission, 'isAttestAdmissionActive').returns(false);
        sinon.stub(attestBcastFee, 'isAttestBroadcastFeeActive').returns(false);
    });

    afterEach(function () {
        sinon.restore();
    });

    // Seat the unweighted capability set at the once-buried height only.
    function seatUnweighted(pubkeys, { truncated = false } = {}) {
        const rows = pubkeys.map(pk => ({ pubkey: pk }));
        if (truncated) rows.truncated = true;
        indexer.indexerDb.getValidatorsByCapability = sinon.stub()
            .callsFake(async (cap, block) => (block === BURIED_BLOCK ? rows : []));
    }

    // Seat the weighted (source-aggregate) set at the once-buried height only. The
    // weight clears the http_get provider stake floor; below it the floor filter
    // empties the set and the vector would be measuring the floor, not the branch.
    function seatWeighted(pubkeys, { truncated = false } = {}) {
        const rows = pubkeys.map((pk, i) => ({ pubkey: pk, source: 'S' + i, weight: '50000' }));
        if (truncated) rows.truncated = true;
        indexer.indexerDb.getStakeWeightsByCapability = sinon.stub()
            .callsFake(async (cap, block) => (block === BURIED_BLOCK ? rows : []));
    }

    function v1Data(overrides = {}) {
        return createBaseData({
            ACTION: 'ATTEST', FORMAT: 1, BLOCK_INDEX: 100, ACTION_INDEX: 7, ...overrides,
        });
    }

    function v1Params(sigs, overrides = {}) {
        const p = {
            requestId: REQ_ID_WIRE, providerId: 'http_get', payload: b64('hello'),
            status: 'ok', meta: 'm', ...overrides,
        };
        const head = ['1', p.requestId, p.providerId, p.payload, p.status, p.meta, String(sigs.length)];
        const tail = [];
        for (const s of sigs) tail.push(s.pubkey, s.sig);
        return head.concat(tail);
    }

    // Drive the real handler once, wrapping ed25519.verify so the canonical the
    // implementation actually built is observed rather than reconstructed.
    async function driveOnce(sigs, { dataOverrides = {}, paramOverrides = {} } = {}) {
        capturedCanonical = null;
        const realVerify = ed25519.verify;
        const wrapped = sinon.stub(ed25519, 'verify').callsFake((payload, sig, pubkey) => {
            capturedCanonical = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
            return realVerify(payload, sig, pubkey);
        });
        try {
            const data = v1Data(dataOverrides);
            await handler.parse(v1Params(sigs, paramOverrides), data, null);
            return {
                status:       data['STATUS'],
                validSigs:    data['VALID_SIGS'],
                responseHash: data['RESPONSE_HASH'],
                canonical:    capturedCanonical,
                signerJson:   data['VALIDATOR_SIGNATURES'],
            };
        } finally {
            wrapped.restore();
        }
    }

    // Two passes. Pass 1 learns the canonical from the implementation itself using
    // throwaway signatures; pass 2 signs THAT string with the real keys and drives
    // again. Nothing in the test ever spells the canonical out, so a test that
    // agrees with the implementation cannot be agreeing with a shared mistake in a
    // duplicated formula.
    async function driveSigned(signerPubkeys, opts = {}) {
        const probe = signerPubkeys.map(pk => ({ pubkey: pk, sig: JUNK_SIG }));
        await driveOnce(probe, opts);
        assert.ok(capturedCanonical,
            'capture pass produced no canonical: no signature reached the verifier, so this vector proves nothing');
        const learned = capturedCanonical;
        const signed = signerPubkeys.map(pk => ({
            pubkey: pk,
            sig: crypto.sign(null, Buffer.from(learned, 'utf8'), KEY_BY_PUBKEY[pk].priv).toString('hex'),
        }));
        return driveOnce(signed, opts);
    }

    // -----------------------------------------------------------------------
    // CAPTURED LITERALS. Every string below was printed by this file's own
    // capture run against the PRE-refactor handler. Do not "fix" one to make a
    // test pass: a mismatch means the extracted verifier moved a consensus byte.
    // -----------------------------------------------------------------------

    // sha256 of the decoded body bytes ('hello'), the field the canonical signs.
    const HASH_HELLO = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    // The EQUIV-wrapped canonical for the default vector (lower-case id gate ON,
    // provider http_get, status ok, meta 'm'). The empty field between VIEW and the
    // wrapped body is the header's own, captured verbatim rather than reasoned about.
    const CANON_EQUIV_LOWER =
        'EQUIV|XATTEST|' + REQ_ID_LOWER + '|0||' + REQ_ID_LOWER + 'http_get' + HASH_HELLO + 'okm';
    // The same round with the lower-case id gate OFF: the RAW wire spelling rides
    // both the EQUIV ROUND_ID and the body.
    const CANON_EQUIV_RAW =
        'EQUIV|XATTEST|' + REQ_ID_WIRE + '|0||' + REQ_ID_WIRE + 'http_get' + HASH_HELLO + 'okm';
    // Below the EQUIV flag-day: the bare five-field concatenation, no header.
    const CANON_BARE_LOWER = REQ_ID_LOWER + 'http_get' + HASH_HELLO + 'okm';

    describe('canonical bytes', function () {

        it('EQUIV header active, lower-case id gate active (today on regtest)', async function () {
            seatUnweighted([K1.pubkey]);
            const r = await driveSigned([K1.pubkey]);
            assert.strictEqual(r.canonical, CANON_EQUIV_LOWER);
            assert.strictEqual(r.responseHash, HASH_HELLO);
            assert.strictEqual(r.status, 'valid');
            assert.strictEqual(r.validSigs, 1);
        });

        it('EQUIV header INACTIVE: the bare legacy concatenation, byte for byte', async function () {
            sinon.stub(eq, 'isEquivHeaderActive').returns(false);
            seatUnweighted([K1.pubkey]);
            const r = await driveSigned([K1.pubkey]);
            assert.strictEqual(r.canonical, CANON_BARE_LOWER);
            assert.strictEqual(r.status, 'valid');
        });

        it('ATTEST_CANONICAL_LOWERCASE_ID off: the RAW wire id spelling signs', async function () {
            handler.actions.protocolChanges.isEnabled = sinon.stub().resolves(false);
            seatUnweighted([K1.pubkey]);
            const r = await driveSigned([K1.pubkey]);
            assert.strictEqual(r.canonical, CANON_EQUIV_RAW);
            assert.strictEqual(r.status, 'valid');
        });

        it('the lower-case gate is evaluated at the ACTION block, not the request block', async function () {
            // D57: today the gate reads data['BLOCK_INDEX'] and is block-TIME keyed. The
            // extraction exposes that block as a parameter and must not re-key it.
            const isEnabled = sinon.stub().resolves(true);
            handler.actions.protocolChanges.isEnabled = isEnabled;
            seatUnweighted([K1.pubkey]);
            await driveSigned([K1.pubkey], { dataOverrides: { BLOCK_INDEX: 111 } });
            const call = isEnabled.getCalls().find(c => c.args[0] === 'ATTEST_CANONICAL_LOWERCASE_ID');
            assert.ok(call, 'the gate was never consulted');
            assert.strictEqual(call.args[1], 111,
                'the gate must be evaluated at the ACTION block; the request block is 90');
        });
    });

    describe('signature counting and the exact error strings', function () {

        it('valid quorum: sigs inlined, error string absent', async function () {
            seatUnweighted([K1.pubkey]);
            const r = await driveSigned([K1.pubkey]);
            assert.strictEqual(r.status, 'valid');
            assert.strictEqual(r.validSigs, 1);
            assert.deepStrictEqual(JSON.parse(r.signerJson).map(s => s.pubkey), [K1.pubkey]);
        });

        it('one bad signature: 0/1', async function () {
            seatUnweighted([K1.pubkey]);
            const r = await driveOnce([{ pubkey: K1.pubkey, sig: JUNK_SIG }]);
            assert.strictEqual(r.status, 'invalid: insufficient valid signatures (0/1)');
            assert.strictEqual(r.validSigs, 0);
            assert.strictEqual(r.signerJson, null);
        });

        it('a capable, correctly-signing NON-responsible signer is filtered out: 0/1', async function () {
            // Both keys hold the capability; only the top-ranked one is responsible.
            seatUnweighted([RANK3[0], RANK3[1]]);
            const r = await driveSigned([RANK3[1]]);
            assert.strictEqual(r.status, 'invalid: insufficient valid signatures (0/1)');
            assert.strictEqual(r.validSigs, 0);
        });

        it('the responsible signer of that same pair is accepted: 1/1', async function () {
            seatUnweighted([RANK3[0], RANK3[1]]);
            const r = await driveSigned([RANK3[0]]);
            assert.strictEqual(r.status, 'valid');
            assert.strictEqual(r.validSigs, 1);
        });

        it('dedupe runs BEFORE the verify: a bad first sig burns the pubkey slot, 0/1', async function () {
            // The second entry carries a GOOD signature for the same pubkey. Deduping
            // before the verify drops it unseen; deduping after would count it and turn
            // this into 1/1, which is the behaviour difference this vector pins.
            seatUnweighted([K1.pubkey]);
            const probe = [{ pubkey: K1.pubkey, sig: JUNK_SIG }];
            await driveOnce(probe);
            const good = crypto.sign(null, Buffer.from(capturedCanonical, 'utf8'), K1.priv).toString('hex');
            const r = await driveOnce([
                { pubkey: K1.pubkey, sig: JUNK_SIG },
                { pubkey: K1.pubkey, sig: good },
            ]);
            assert.strictEqual(r.status, 'invalid: insufficient valid signatures (0/1)');
            assert.strictEqual(r.validSigs, 0);
        });

        it('a duplicated GOOD signature counts once: 1/2', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 2 }));
            seatUnweighted([RANK3[0], RANK3[1]]);
            const r = await driveSigned([RANK3[0], RANK3[0]]);
            assert.strictEqual(r.status, 'invalid: insufficient valid signatures (1/2)');
            assert.strictEqual(r.validSigs, 1);
        });

        it('insufficient signatures against redundancy 3: 1/3', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 3 }));
            seatUnweighted([RANK3[0], RANK3[1], RANK3[2]]);
            const r = await driveSigned([RANK3[0]]);
            assert.strictEqual(r.status, 'invalid: insufficient valid signatures (1/3)');
            assert.strictEqual(r.validSigs, 1);
        });
    });

    describe('the capability read: which query, at which height', function () {

        it('unweighted branch resolves at the ONCE-buried height', async function () {
            seatUnweighted([K1.pubkey]);
            const r = await driveSigned([K1.pubkey]);
            assert.strictEqual(r.status, 'valid');
            const blocks = indexer.indexerDb.getValidatorsByCapability.getCalls().map(c => c.args[1]);
            assert.ok(blocks.length > 0);
            assert.ok(blocks.every(b => b === BURIED_BLOCK),
                'every capability read must land on ' + BURIED_BLOCK + ', saw ' + JSON.stringify(blocks));
        });

        it('a TRUNCATED unweighted read falls back per signer to hasCapability', async function () {
            // The signature is GOOD here: the only thing that can reject it is the
            // per-signer probe, which is exactly what this vector is measuring. The
            // canonical is learned from a permissive first drive, because a rejected
            // signer never reaches the verifier and so never reveals it.
            seatUnweighted([K1.pubkey], { truncated: true });
            indexer.indexerDb.hasCapability = sinon.stub().resolves(true);
            const learn = await driveSigned([K1.pubkey]);
            assert.strictEqual(learn.status, 'valid');
            const good = crypto.sign(null, Buffer.from(learn.canonical, 'utf8'), K1.priv).toString('hex');

            indexer.indexerDb.hasCapability = sinon.stub().resolves(false);
            const r = await driveOnce([{ pubkey: K1.pubkey, sig: good }]);
            assert.strictEqual(r.status, 'invalid: insufficient valid signatures (0/1)',
                'the per-signer probe must be the gate on the unweighted truncated branch');
            assert.ok(indexer.indexerDb.hasCapability.calledWith(K1.pubkey, 'attestation', BURIED_BLOCK));
        });

        it('the same truncated read with hasCapability true is valid', async function () {
            seatUnweighted([K1.pubkey], { truncated: true });
            indexer.indexerDb.hasCapability = sinon.stub().resolves(true);
            const r = await driveSigned([K1.pubkey]);
            assert.strictEqual(r.status, 'valid');
        });

        it('weighted branch reads the stake-weight query and never the pubkey-aggregate one', async function () {
            swq.isStakeWeightedQuorumActive.returns(true);
            seatWeighted([K1.pubkey]);
            const r = await driveSigned([K1.pubkey]);
            assert.strictEqual(r.status, 'valid');
            assert.strictEqual(r.validSigs, 1);
            assert.strictEqual(indexer.indexerDb.getValidatorsByCapability.callCount, 0);
            const blocks = indexer.indexerDb.getStakeWeightsByCapability.getCalls().map(c => c.args[1]);
            assert.ok(blocks.every(b => b === BURIED_BLOCK), JSON.stringify(blocks));
        });

        it('a TRUNCATED weighted read is taken as it stands, never re-probed per signer', async function () {
            // The fixed bug: hasCapability is the pubkey aggregate, so a per-signer
            // fallback here drops the very source-split signers the weighted query
            // exists to admit. hasCapability answers FALSE; the row must still count.
            swq.isStakeWeightedQuorumActive.returns(true);
            seatWeighted([K1.pubkey], { truncated: true });
            indexer.indexerDb.hasCapability = sinon.stub().resolves(false);
            const r = await driveSigned([K1.pubkey]);
            assert.strictEqual(r.status, 'valid');
            assert.strictEqual(
                indexer.indexerDb.hasCapability.getCalls().filter(c => c.args[1] === 'attestation').length, 0,
                'no pubkey-aggregate probe may run on the weighted branch');
        });

        it('the weighted branch is gated on COIN === BTC as well as the height', async function () {
            swq.isStakeWeightedQuorumActive.returns(true);
            handler.config['COIN'] = 'LTC';
            seatWeighted([K1.pubkey]);
            seatUnweighted([K1.pubkey]);
            const r = await driveSigned([K1.pubkey]);
            // Off BTC the eligibility read stays the pubkey-aggregate query, and
            // _computeResponsibleSet returns [] by plane, so nothing is responsible.
            assert.strictEqual(indexer.indexerDb.getStakeWeightsByCapability.callCount, 0);
            assert.strictEqual(r.status, 'invalid: insufficient valid signatures (0/1)');
        });
    });

    describe('the widening step is evaluated at the RESPONSE block', function () {

        it('unwidened at block 100: the rank-2 validator is not responsible, 0/1', async function () {
            seatUnweighted([RANK3[0], RANK3[1], RANK3[2]]);
            const r = await driveSigned([RANK3[1]], { dataOverrides: { BLOCK_INDEX: 100 } });
            assert.strictEqual(r.status, 'invalid: insufficient valid signatures (0/1)');
        });

        it('widened at block 150: the same rank-2 validator is admitted, 1/1', async function () {
            seatUnweighted([RANK3[0], RANK3[1], RANK3[2]]);
            const r = await driveSigned([RANK3[1]], { dataOverrides: { BLOCK_INDEX: 150 } });
            assert.strictEqual(r.status, 'valid');
            assert.strictEqual(r.validSigs, 1);
        });

        it('the widening ladder never reaches rank 3 inside this window', async function () {
            seatUnweighted([RANK3[0], RANK3[1], RANK3[2]]);
            const r = await driveSigned([RANK3[2]], { dataOverrides: { BLOCK_INDEX: 150 } });
            assert.strictEqual(r.status, 'invalid: insufficient valid signatures (0/1)');
        });
    });

    describe('pre-verification error strings pass through untouched', function () {

        it('no matching request', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(null);
            const r = await driveOnce([{ pubkey: K1.pubkey, sig: JUNK_SIG }]);
            assert.strictEqual(r.status, 'invalid: REQUEST_ID (no matching request)');
            assert.strictEqual(r.validSigs, 0);
            assert.strictEqual(r.responseHash, HASH_HELLO);
        });

        it('request already terminal', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ request_status: 'fulfilled' }));
            const r = await driveOnce([{ pubkey: K1.pubkey, sig: JUNK_SIG }]);
            assert.strictEqual(r.status, 'invalid: REQUEST already fulfilled');
        });

        it('provider mismatch', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ provider_id: 'llm' }));
            const r = await driveOnce([{ pubkey: K1.pubkey, sig: JUNK_SIG }]);
            assert.strictEqual(r.status, 'invalid: PROVIDER_ID does not match request');
        });

        it('past the deadline block', async function () {
            const r = await driveOnce([{ pubkey: K1.pubkey, sig: JUNK_SIG }],
                { dataOverrides: { BLOCK_INDEX: DEADLINE_BLOCK + 1 } });
            assert.strictEqual(r.status,
                'invalid: REQUEST expired (deadline_block=' + DEADLINE_BLOCK + ')');
        });

        it('an error set before the verify block skips verification entirely', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(null);
            seatUnweighted([K1.pubkey]);
            await driveOnce([{ pubkey: K1.pubkey, sig: JUNK_SIG }]);
            assert.strictEqual(indexer.indexerDb.getValidatorsByCapability.callCount, 0,
                'no capability read may run once an error is already set');
        });
    });

    // -----------------------------------------------------------------------
    // MIRROR-ERA CANONICAL (row 33, spec §3.1/§4.3). The chain path above never
    // sets `effectiveTime` at all, so it stays on the legacy canonical (proved by
    // every vector above staying green, unchanged). These vectors call the shared
    // module directly, the way the mirror applier (`_applyMirroredResponse`, row 17)
    // does, since the applier's own wiring is another builder's row and out of this
    // file's jail; what is in scope is that the module itself selects the era it is
    // told to, and never crashes on a row that cannot spell its own effective time.
    // -----------------------------------------------------------------------

    describe('mirror-era canonical: the caller-selected effectiveTime', function () {

        // Same shape as v1Data/v1Params above, but calling the module directly:
        // atBlock === declaredBlock (90) keeps the widening ladder at its unwidened
        // floor, where RANK3[0] is the sole responsible signer, matching the
        // "unwidened" vector in the widening-step block above.
        function mirrorInput(effectiveTime, sigs, overrides = {}) {
            return {
                request:           makeRequestRow(),
                sigs,
                requestId:         REQ_ID_LOWER,
                requestIdRaw:      REQ_ID_LOWER,
                providerId:        'http_get',
                responseStatus:    'ok',
                meta:              'm',
                responseBodyBytes: Buffer.from('hello', 'utf8'),
                effectiveTime,
                atBlock:           DECLARED_BLOCK,
                gateBlock:         DECLARED_BLOCK,
                error:             null,
                coin:              'BTC',
                network:           'regtest',
                indexerDb:         indexer.indexerDb,
                protocolChanges:   handler.actions.protocolChanges,
                computeResponsibleSet: handler._computeResponsibleSet.bind(handler),
                ...overrides,
            };
        }

        // Capture the canonical the module actually builds for a given effectiveTime
        // (via a throwaway signature; the canonical does not depend on the sigs
        // list), then sign THAT string with the real key. Same two-pass technique
        // driveSigned uses above, so this vector cannot be agreeing with a
        // hand-derived formula that shares the implementation's own mistake.
        async function learnCanonical(effectiveTime) {
            const probe = await avr.verifyAttestationResponse(
                mirrorInput(effectiveTime, [{ pubkey: RANK3[0], sig: JUNK_SIG }]));
            assert.ok(probe.canonical, 'probe produced no canonical: nothing to sign');
            return probe.canonical;
        }

        it('a mirror-era vector signed WITH the effective time verifies', async function () {
            seatUnweighted([RANK3[0]]);
            const learned = await learnCanonical(1234567890);
            assert.ok(learned.toString('utf8').endsWith('|1234567890'),
                'the signed effective time must ride the canonical bytes, not sit outside them');
            const sig = crypto.sign(null, learned, KEY_BY_PUBKEY[RANK3[0]].priv).toString('hex');
            const r = await avr.verifyAttestationResponse(
                mirrorInput(1234567890, [{ pubkey: RANK3[0], sig }]));
            assert.strictEqual(r.ok, true);
            assert.strictEqual(r.error, null);
            assert.strictEqual(r.validSigs, 1);
        });

        it('the same signature fails verification when effectiveTime is null (legacy) at verify time', async function () {
            seatUnweighted([RANK3[0]]);
            const learned = await learnCanonical(1234567890);
            const sig = crypto.sign(null, learned, KEY_BY_PUBKEY[RANK3[0]].priv).toString('hex');
            const r = await avr.verifyAttestationResponse(
                mirrorInput(null, [{ pubkey: RANK3[0], sig }]));
            assert.strictEqual(r.ok, false);
            assert.strictEqual(r.validSigs, 0);
            assert.strictEqual(r.error, 'invalid: insufficient valid signatures (0/1)');
        });

        it('the same signature fails verification against a DIFFERENT effective time', async function () {
            seatUnweighted([RANK3[0]]);
            const learned = await learnCanonical(1234567890);
            const sig = crypto.sign(null, learned, KEY_BY_PUBKEY[RANK3[0]].priv).toString('hex');
            const r = await avr.verifyAttestationResponse(
                mirrorInput(1234567891, [{ pubkey: RANK3[0], sig }]));
            assert.strictEqual(r.ok, false);
            assert.strictEqual(r.validSigs, 0);
            assert.strictEqual(r.error, 'invalid: insufficient valid signatures (0/1)');
        });

        it('a non-canonical spelling yields the pinned error verdict, never a throw', async function () {
            seatUnweighted([RANK3[0]]);
            const r = await avr.verifyAttestationResponse(
                mirrorInput('0120', [{ pubkey: RANK3[0], sig: JUNK_SIG }]));
            assert.strictEqual(r.ok, false);
            assert.strictEqual(r.error, 'invalid: EFFECTIVE_TIME is not a canonical integer spelling');
            assert.strictEqual(r.canonical, null);
            assert.strictEqual(r.validSigs, 0);
        });

        it('an unspellable effectiveTime never throws out of the module (a bad row is skipped, not a crash)', async function () {
            seatUnweighted([RANK3[0]]);
            await assert.doesNotReject(avr.verifyAttestationResponse(
                mirrorInput(-1, [{ pubkey: RANK3[0], sig: JUNK_SIG }])));
            const r = await avr.verifyAttestationResponse(
                mirrorInput(-1, [{ pubkey: RANK3[0], sig: JUNK_SIG }]));
            assert.strictEqual(r.error, 'invalid: EFFECTIVE_TIME is not a canonical integer spelling');
        });

        it('an upstream error set before the call wins over the canonical-build failure', async function () {
            seatUnweighted([RANK3[0]]);
            const r = await avr.verifyAttestationResponse(
                mirrorInput('0120', [{ pubkey: RANK3[0], sig: JUNK_SIG }],
                    { error: 'invalid: REQUEST already fulfilled' }));
            assert.strictEqual(r.error, 'invalid: REQUEST already fulfilled');
        });
    });
});
