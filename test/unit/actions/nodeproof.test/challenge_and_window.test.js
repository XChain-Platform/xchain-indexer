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
// NODEPROOF challenge binding and timing: a CHALLENGE_ID that does not match
// the derivation, an epoch block with no ledger hash, an EPOCH_HEIGHT off the
// challenge interval and a verdict landing past the accept window.
// Part of the NODEPROOF suite; see ../nodeproof.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const {
    PUBKEY_V, PUBKEY_P, SIG_V, SEED,
    deriveChallengeId, v0Params, v0Data, validChallengeIdFor, makeNodeProofContext, resetNodeProofConfig,
} = require('./helpers/nodeproof_context.js');

let indexer, handler, NETWORK;

// Each test starts from its own mock indexer and NODEPROOF handler, with one
// genesis verifier seeded and every verifier signature verifying.
function freshNodeProof() {
    ({ indexer, handler, NETWORK } = makeNodeProofContext());
}

const validChallengeId = () => validChallengeIdFor(NETWORK);

describe('NodeProof (NODEPROOF) @regression @tier3', function () {
    beforeEach(freshNodeProof);
    afterEach(() => resetNodeProofConfig(indexer));

    // ── derived-challenge binding ──────────────────────────────────────────────
    it('rejects a CHALLENGE_ID that does not match the derivation', async function () {
        const data = v0Data();
        await handler.parse(v0Params({
            challengeId: '0'.repeat(64), pass: [PUBKEY_P], sigs: [{ pubkey: PUBKEY_V, sig: SIG_V }],
        }), data, null);
        assert.ok(String(data['STATUS']).includes('CHALLENGE_ID'),
            'expected derivation-mismatch rejection, got: ' + data['STATUS']);
        assert.ok(indexer.indexerDb.createNodeProofVerification.notCalled);
    });

    it('rejects when the epoch block has no ledger hash', async function () {
        indexer.indexerDb.getStoredBlockHashes.resolves(null);
        const data = v0Data();
        await handler.parse(v0Params({
            challengeId: validChallengeId(), pass: [PUBKEY_P], sigs: [{ pubkey: PUBKEY_V, sig: SIG_V }],
        }), data, null);
        assert.ok(String(data['STATUS']).includes('EPOCH_HEIGHT'),
            'expected no-ledger-hash rejection, got: ' + data['STATUS']);
    });

    // ── epoch / window validation ──────────────────────────────────────────────
    it('rejects an EPOCH_HEIGHT that is not a challenge epoch (not a multiple of the interval)', async function () {
        const epoch = 290; // not a multiple of 144
        const cid = deriveChallengeId(NETWORK, epoch, SEED, epoch - 100);
        const data = v0Data();
        await handler.parse(v0Params({ challengeId: cid, epoch, pass: [PUBKEY_P], sigs: [{ pubkey: PUBKEY_V, sig: SIG_V }] }), data, null);
        assert.ok(String(data['STATUS']).includes('EPOCH_HEIGHT'),
            'expected non-epoch rejection, got: ' + data['STATUS']);
    });

    it('rejects a verdict that lands later than the accept window', async function () {
        const data = v0Data({ BLOCK_INDEX: 400 }); // 400 - 288 = 112 > 24
        await handler.parse(v0Params({
            challengeId: validChallengeId(), pass: [PUBKEY_P], sigs: [{ pubkey: PUBKEY_V, sig: SIG_V }],
        }), data, null);
        assert.ok(String(data['STATUS']).includes('too late'),
            'expected late-verdict rejection, got: ' + data['STATUS']);
    });
});
