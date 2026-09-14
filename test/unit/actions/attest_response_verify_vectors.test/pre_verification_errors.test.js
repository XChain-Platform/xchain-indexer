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
// ATTEST v1 response-verification byte vectors: the error strings set before
// the verify block pass through untouched, and skip verification entirely.
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

const { K1, JUNK_SIG, DEADLINE_BLOCK, HASH_HELLO } = require('./helpers/vectors.js');
const { makeRequestRow, setupVectors, seatUnweighted, driveOnce } = require('./helpers/vector_harness.js');

// Consecutive sibling blocks under the one suite title, each running the shared
// setup, so every full test title is the one the suite has always reported.

describe('ATTEST v1 response verification: captured byte vectors @regression @tier1', function () {
    let indexer;
    beforeEach(function () { ({ indexer } = setupVectors()); });
    afterEach(function () { sinon.restore(); });

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
});
