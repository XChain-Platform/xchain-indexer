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
// ATTEST v1 response-verification byte vectors: the mirror-era canonical, with
// the effectiveTime the caller selects riding the signed bytes.
//
// How the vectors were captured, why the keys come from fixed seeds and why the
// capability read answers at one height only are described in
// ../attest_response_verify_vectors.test.js. The keys and captured literals are
// in ./helpers/vectors.js; the drive harness is ./helpers/vector_harness.js.
// ---------------------------------------------------------------------------

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

const avr     = require('../../../../src/actions/attest/attest_response_verify.js');

const { JUNK_SIG, RANK3, KEY_BY_PUBKEY } = require('./helpers/vectors.js');
const { setupVectors, seatUnweighted, mirrorInput, learnCanonical } = require('./helpers/vector_harness.js');

// Consecutive sibling blocks under the one suite title, each running the shared
// setup, so every full test title is the one the suite has always reported.

// -----------------------------------------------------------------------
// MIRROR-ERA CANONICAL. The chain path above never
// sets `effectiveTime` at all, so it stays on the legacy canonical (proved by
// every vector above staying green, unchanged). These vectors call the shared
// module directly, the way the mirror applier (`applyMirroredResponse`)
// does, since the applier's own wiring is a separate concern outside this
// file's scope; what is covered is that the module itself selects the era it is
// told to, and never crashes on a row that cannot spell its own effective time.
// -----------------------------------------------------------------------
// (The chain-path vectors this banner calls "above" are in
// ../attest_response_verify_vectors.test.js and its sibling parts.)

describe('ATTEST v1 response verification: captured byte vectors @regression @tier1', function () {
    beforeEach(function () { setupVectors(); });
    afterEach(function () { sinon.restore(); });

    describe('mirror-era canonical: the caller-selected effectiveTime', function () {
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
    });
});

describe('ATTEST v1 response verification: captured byte vectors @regression @tier1', function () {
    beforeEach(function () { setupVectors(); });
    afterEach(function () { sinon.restore(); });

    describe('mirror-era canonical: the caller-selected effectiveTime', function () {
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
    });

    describe('mirror-era canonical: the caller-selected effectiveTime', function () {
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
