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
// These vectors were CAPTURED by driving the real parseResponse handler BEFORE
// the verify block was factored out into src/actions/attest/attest_response_verify.js
// (for the ATTEST response mirror), and they are
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
//
// The vectors are split by behaviour into consecutive sibling blocks under this
// one suite title. The fixed-seed keys and the CAPTURED LITERALS live, byte for
// byte as captured, in attest_response_verify_vectors.test/helpers/vectors.js,
// and the drive harness (the capability-read seats, the capture drives, the
// mirror-era input) in helpers/vector_harness.js beside it. This file holds the
// canonical bytes and the signature-counting error strings; the directory
// holds the capability read (capability_read.test.js), the widening step
// (widening_step.test.js), the pre-verification error strings
// (pre_verification_errors.test.js) and the mirror-era canonical
// (mirror_era_canonical.test.js).
// ---------------------------------------------------------------------------

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

const eq      = require('../../../../src/consensus/equivocation_header.js');

const { K1, JUNK_SIG, RANK3, HASH_HELLO, CANON_EQUIV_LOWER, CANON_EQUIV_RAW, CANON_BARE_LOWER } = require('./attest_response_verify_vectors.test/helpers/vectors.js');
const { state, makeRequestRow, setupVectors, seatUnweighted, driveOnce, driveSigned } = require('./attest_response_verify_vectors.test/helpers/vector_harness.js');

// Consecutive sibling blocks under the one suite title, each running the shared
// setup, so every full test title is the one the suite has always reported.

describe('ATTEST v1 response verification: captured byte vectors @regression @tier1', function () {
    let handler;
    beforeEach(function () { ({ handler } = setupVectors()); });
    afterEach(function () { sinon.restore(); });

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
            // Keying rule: the gate reads data['BLOCK_INDEX'] and is block-TIME keyed. The
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
});

describe('ATTEST v1 response verification: captured byte vectors @regression @tier1', function () {
    beforeEach(function () { setupVectors(); });
    afterEach(function () { sinon.restore(); });

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
            // All three keys hold the capability. Regtest is above ATTEST_ZERO_CONF_ACTIVATION
            // (armed at 0), so the stage-2 ladder admits redundancy + 1 (headroom) inside the
            // first segment: ranks 0 and 1. Rank 2 is capable and signs correctly, and is
            // still outside the set.
            seatUnweighted([RANK3[0], RANK3[1], RANK3[2]]);
            const r = await driveSigned([RANK3[2]]);
            assert.strictEqual(r.status, 'invalid: insufficient valid signatures (0/1)');
            assert.strictEqual(r.validSigs, 0);
        });

        it('the responsible signer of that same pair is accepted: 1/1', async function () {
            seatUnweighted([RANK3[0], RANK3[1]]);
            const r = await driveSigned([RANK3[0]]);
            assert.strictEqual(r.status, 'valid');
            assert.strictEqual(r.validSigs, 1);
        });
    });
});

describe('ATTEST v1 response verification: captured byte vectors @regression @tier1', function () {
    let indexer;
    beforeEach(function () { ({ indexer } = setupVectors()); });
    afterEach(function () { sinon.restore(); });

    describe('signature counting and the exact error strings', function () {
        it('dedupe runs BEFORE the verify: a bad first sig burns the pubkey slot, 0/1', async function () {
            // The second entry carries a GOOD signature for the same pubkey. Deduping
            // before the verify drops it unseen; deduping after would count it and turn
            // this into 1/1, which is the behaviour difference this vector pins.
            seatUnweighted([K1.pubkey]);
            const probe = [{ pubkey: K1.pubkey, sig: JUNK_SIG }];
            await driveOnce(probe);
            const good = crypto.sign(null, Buffer.from(state.capturedCanonical, 'utf8'), K1.priv).toString('hex');
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
    });

    describe('signature counting and the exact error strings', function () {
        it('insufficient signatures against redundancy 3: 1/3', async function () {
            indexer.indexerDb.getAttestationRequestById.resolves(makeRequestRow({ redundancy: 3 }));
            seatUnweighted([RANK3[0], RANK3[1], RANK3[2]]);
            const r = await driveSigned([RANK3[0]]);
            assert.strictEqual(r.status, 'invalid: insufficient valid signatures (1/3)');
            assert.strictEqual(r.validSigs, 1);
        });
    });
});
