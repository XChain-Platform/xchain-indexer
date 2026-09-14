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
// ATTEST v1 response-verification byte vectors: the widening step of the
// responsible set is evaluated at the RESPONSE block.
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

const { RANK3 } = require('./helpers/vectors.js');
const { setupVectors, seatUnweighted, driveSigned } = require('./helpers/vector_harness.js');

// Consecutive sibling blocks under the one suite title, each running the shared
// setup, so every full test title is the one the suite has always reported.

describe('ATTEST v1 response verification: captured byte vectors @regression @tier1', function () {
    beforeEach(function () { setupVectors(); });
    afterEach(function () { sinon.restore(); });

    describe('the widening step is evaluated at the RESPONSE block', function () {

        it('headroom at block 100: the rank-2 validator is admitted before any ladder step, 1/1', async function () {
            // Stage 2 (regtest is above the zero-conf height): headroom 1 from the request
            // block itself, so the second-ranked key may sign inside the first segment.
            seatUnweighted([RANK3[0], RANK3[1], RANK3[2]]);
            const r = await driveSigned([RANK3[1]], { dataOverrides: { BLOCK_INDEX: 100 } });
            assert.strictEqual(r.status, 'valid');
            assert.strictEqual(r.validSigs, 1);
        });

        it('headroom at block 100 does not reach rank 3, 0/1', async function () {
            seatUnweighted([RANK3[0], RANK3[1], RANK3[2]]);
            const r = await driveSigned([RANK3[2]], { dataOverrides: { BLOCK_INDEX: 100 } });
            assert.strictEqual(r.status, 'invalid: insufficient valid signatures (0/1)');
        });

        it('widened at block 150: the same rank-2 validator is admitted, 1/1', async function () {
            seatUnweighted([RANK3[0], RANK3[1], RANK3[2]]);
            const r = await driveSigned([RANK3[1]], { dataOverrides: { BLOCK_INDEX: 150 } });
            assert.strictEqual(r.status, 'valid');
            assert.strictEqual(r.validSigs, 1);
        });

        it('widened at block 150: headroom plus one ladder step reaches rank 3, 1/1', async function () {
            // Span 110 from the request block, segment 36.67: block 150 is one step in, so
            // the set is redundancy + headroom + 1 and the third-ranked key may sign.
            seatUnweighted([RANK3[0], RANK3[1], RANK3[2]]);
            const r = await driveSigned([RANK3[2]], { dataOverrides: { BLOCK_INDEX: 150 } });
            assert.strictEqual(r.status, 'valid');
            assert.strictEqual(r.validSigs, 1);
        });
    });
});
