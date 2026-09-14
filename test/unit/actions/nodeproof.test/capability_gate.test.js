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
// NODEPROOF PASS-pubkey capability gate: a PASS pubkey without full_node is not
// recorded, the full_node set is read in batch once per plane, and a truncated
// batched read is re-probed per pubkey instead of shrinking the divisor.
// Part of the NODEPROOF suite; see ../nodeproof.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const {
    PUBKEY_V, PUBKEY_P, PUBKEY_P2, SIG_V, EPOCH, SET_BLOCK,
    setCapable, v0Params, v0Data, validChallengeIdFor, makeNodeProofContext, resetNodeProofConfig,
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

    // ── PASS-pubkey capability gate ────────────────────────────────────────────
    it('does not record a PASS pubkey that lacks the full_node capability', async function () {
        // Quorum still met, but the PASS pubkey fails the capability check → not recorded.
        setCapable(indexer.indexerDb, (pk, cap) => cap !== 'full_node' || pk !== PUBKEY_P);
        const data = v0Data();
        await handler.parse(v0Params({
            challengeId: validChallengeId(), pass: [PUBKEY_P], sigs: [{ pubkey: PUBKEY_V, sig: SIG_V }],
        }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.createNodeProofVerification.notCalled,
            'a non-staking PASS pubkey must not be recorded');
    });

    it('resolves the full_node capability set in batch, never once per pubkey', async function () {
        // Both loops must not run hasCapability (~5 sequential queries) per element: the
        // verifier intersect that sizes the quorum divisor, and the PASS recording pass
        // Two batched reads answer both, whatever the list length.
        // V is already a genesis verifier, so echoing it back leaves the divisor at 1
        // while still driving the intersect loop.
        indexer.indexerDb.getVerifiedFullNodeSet.resolves([{ pubkey: PUBKEY_V }]);
        const data = v0Data();
        await handler.parse(v0Params({
            challengeId: validChallengeId(), pass: [PUBKEY_P, PUBKEY_P2],
            sigs: [{ pubkey: PUBKEY_V, sig: SIG_V }],
        }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(indexer.indexerDb.createNodeProofVerification.callCount, 2);
        assert.strictEqual(
            indexer.indexerDb.hasCapability.getCalls().filter(c => c.args[1] === 'full_node').length, 0,
            'no per-pubkey full_node read may survive the batched set');
        // Exactly two batched reads, one per plane, and each at its own height: the
        // eligible-verifier intersect raw, the PASS credit gate buried. Asserting the
        // count as well as the heights is what catches a regression that collapses the
        // planes back together, since either height alone still satisfies a calledWith.
        const capCalls = indexer.indexerDb.getValidatorsByCapability.getCalls();
        assert.strictEqual(capCalls.length, 2, 'one batched capability read per plane');
        assert.deepStrictEqual(capCalls[0].args, ['full_node', EPOCH]);
        assert.deepStrictEqual(capCalls[1].args, ['full_node', SET_BLOCK]);
    });
});

describe('NodeProof (NODEPROOF) @regression @tier3', function () {
    beforeEach(freshNodeProof);
    afterEach(() => resetNodeProofConfig(indexer));

    it('a TRUNCATED capability read re-probes per pubkey rather than shrinking the divisor', async function () {
        // getVerifiedFullNodeSet and getValidatorsByCapability carry INDEPENDENT
        // VALIDATOR_QUERY_LIMITs, so intersecting two capped sets could drop a verifier
        // the per-element probe keeps - and eligible.size is the quorum divisor.
        indexer.indexerDb.getVerifiedFullNodeSet.resolves([{ pubkey: PUBKEY_P }]);
        const capped = [];
        capped.truncated = true;
        indexer.indexerDb.getValidatorsByCapability.resolves(capped);
        const data = v0Data();
        await handler.parse(v0Params({
            challengeId: validChallengeId(), pass: [PUBKEY_P], sigs: [{ pubkey: PUBKEY_V, sig: SIG_V }],
        }), data, null);
        assert.ok(indexer.indexerDb.hasCapability.calledWith(PUBKEY_P, 'full_node', EPOCH),
            'a capped read must be re-probed, not trusted as membership');
        // V + P are both eligible → quorum floor(2*2/3)+1 = 2, and only V signed.
        assert.ok(String(data['STATUS']).includes('1/2 of 2'),
            'the truncated read must not shrink the divisor, got: ' + data['STATUS']);
    });
});
