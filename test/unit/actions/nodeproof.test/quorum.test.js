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
// NODEPROOF eligibility and quorum: a dormant verifier set, signatures below
// and at quorum, a garbage-then-valid duplicate, outsider signatures and a
// signature that fails ed25519.verify.
// Part of the NODEPROOF suite; see ../nodeproof.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const {
    PUBKEY_V, PUBKEY_V2, PUBKEY_P, PUBKEY_X, SIG_V, SIG_V2, SIG_X,
    v0Params, v0Data, validChallengeIdFor, makeNodeProofContext, resetNodeProofConfig,
} = require('./helpers/nodeproof_context.js');
// The same cached module the helper stubs; a case steers verify() through it.
const ed25519 = require('../../../../src/consensus/ed25519.js');

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

    // ── eligibility / quorum ───────────────────────────────────────────────────
    it('rejects when there are no eligible verifiers (feature dormant)', async function () {
        indexer.config.FULLNODE = Object.assign({}, indexer.config.FULLNODE, { GENESIS_VERIFIERS: [] });
        const data = v0Data();
        await handler.parse(v0Params({
            challengeId: validChallengeId(), pass: [PUBKEY_P], sigs: [{ pubkey: PUBKEY_V, sig: SIG_V }],
        }), data, null);
        assert.ok(String(data['STATUS']).includes('no eligible verifiers'),
            'expected dormant rejection, got: ' + data['STATUS']);
        assert.ok(indexer.indexerDb.createNodeProofVerification.notCalled);
    });

    it('rejects when verifier signatures are below quorum', async function () {
        // Two genesis verifiers → V=2 → quorum floor(4/3)+1 = 2, but only one valid sig.
        indexer.config.FULLNODE = Object.assign({}, indexer.config.FULLNODE, { GENESIS_VERIFIERS: [PUBKEY_V, PUBKEY_V2] });
        const data = v0Data();
        await handler.parse(v0Params({
            challengeId: validChallengeId(), pass: [PUBKEY_P], sigs: [{ pubkey: PUBKEY_V, sig: SIG_V }],
        }), data, null);
        assert.ok(String(data['STATUS']).includes('insufficient verifier signatures'),
            'expected quorum failure, got: ' + data['STATUS']);
    });

    it('reaches quorum with both verifiers signing', async function () {
        indexer.config.FULLNODE = Object.assign({}, indexer.config.FULLNODE, { GENESIS_VERIFIERS: [PUBKEY_V, PUBKEY_V2] });
        const data = v0Data();
        await handler.parse(v0Params({
            challengeId: validChallengeId(), pass: [PUBKEY_P],
            sigs: [{ pubkey: PUBKEY_V, sig: SIG_V }, { pubkey: PUBKEY_V2, sig: SIG_V2 }],
        }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.createNodeProofVerification.calledOnce);
    });
});

describe('NodeProof (NODEPROOF) @regression @tier3', function () {
    beforeEach(freshNodeProof);
    afterEach(() => resetNodeProofConfig(indexer));

    it('a garbage-then-valid duplicate for one verifier still passes (seen marked AFTER verify; hub/SDK parity)', async function () {
        // V=2 -> quorum 2, so BOTH verifiers must count. Prepend an INVALID entry for
        // V2 before its genuine one: marking "seen" on first encounter (the pre-fix
        // order) would suppress V2's real signature and reject a legitimately-quorate
        // verdict (order-dependent quorum under-count).
        indexer.config.FULLNODE = Object.assign({}, indexer.config.FULLNODE, { GENESIS_VERIFIERS: [PUBKEY_V, PUBKEY_V2] });
        const BADSIG = '0'.repeat(128);
        ed25519.verify.callsFake((canon, sig, pk) => sig !== BADSIG);
        const data = v0Data();
        await handler.parse(v0Params({
            challengeId: validChallengeId(), pass: [PUBKEY_P],
            sigs: [{ pubkey: PUBKEY_V, sig: SIG_V }, { pubkey: PUBKEY_V2, sig: BADSIG }, { pubkey: PUBKEY_V2, sig: SIG_V2 }],
        }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('ignores signatures from non-eligible signers', async function () {
        // V=1 (PUBKEY_V), but the only sig is from an outsider → 0 valid → below quorum.
        const data = v0Data();
        await handler.parse(v0Params({
            challengeId: validChallengeId(), pass: [PUBKEY_P], sigs: [{ pubkey: PUBKEY_X, sig: SIG_X }],
        }), data, null);
        assert.ok(String(data['STATUS']).includes('insufficient verifier signatures'),
            'outsider sig must not count, got: ' + data['STATUS']);
    });

    it('counts a signature only when ed25519.verify passes', async function () {
        ed25519.verify.returns(false);
        const data = v0Data();
        await handler.parse(v0Params({
            challengeId: validChallengeId(), pass: [PUBKEY_P], sigs: [{ pubkey: PUBKEY_V, sig: SIG_V }],
        }), data, null);
        assert.ok(String(data['STATUS']).includes('insufficient verifier signatures'));
    });
});
