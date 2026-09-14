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
// NODEPROOF verdict handler: the happy path and the split between the raw
// acceptance plane and the buried PASS-credit plane, the byte-sorted PASS
// preimage pinned on both sides of the hub seam, and the BTC-only scope. The
// challenge and window, quorum and capability-gate blocks live beside it in
// nodeproof.test/; every file opens the same 'NodeProof (NODEPROOF) @regression @tier3'
// describe, so each full test title stays under one suite name.
// nodeproof.test/helpers/nodeproof_context.js holds the keys, epoch geometry,
// wire builders and the mock indexer every block starts from.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');
const {
    PUBKEY_V, PUBKEY_P, PUBKEY_P2, SIG_V, EPOCH, TARGET, SET_BLOCK,
    v0Params, v0Data, validChallengeIdFor, makeNodeProofContext, resetNodeProofConfig,
} = require('./nodeproof.test/helpers/nodeproof_context.js');
// The same cached module the helper stubs; a case steers verify() through it.
const ed25519 = require('../../../src/consensus/ed25519.js');

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

    // ── happy path ───────────────────────────────────────────────────────────
    it('valid verdict → STATUS valid and records each PASS pubkey', async function () {
        const data = v0Data();
        await handler.parse(v0Params({
            challengeId: validChallengeId(), pass: [PUBKEY_P], sigs: [{ pubkey: PUBKEY_V, sig: SIG_V }],
        }), data, null);

        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.createNodeProofVerification.calledOnce);
        const args = indexer.indexerDb.createNodeProofVerification.firstCall.args;
        assert.strictEqual(args[0], PUBKEY_P);            // pubkey
        assert.strictEqual(args[1], validChallengeId());  // challenge_id
        assert.strictEqual(args[2], EPOCH);               // epoch_height
        assert.strictEqual(args[3], TARGET);              // target_height
        assert.strictEqual(args[4], 55);                  // verdict action_index
        assert.strictEqual(args[5], 300);                 // block_index
        assert.strictEqual(args[6], SET_BLOCK);           // source-resolution block
    });

    it('records one row per PASS pubkey', async function () {
        const data = v0Data();
        await handler.parse(v0Params({
            challengeId: validChallengeId(), pass: [PUBKEY_P, PUBKEY_P2], sigs: [{ pubkey: PUBKEY_V, sig: SIG_V }],
        }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(indexer.indexerDb.createNodeProofVerification.callCount, 2);
    });
});

describe('NodeProof (NODEPROOF) @regression @tier3', function () {
    beforeEach(freshNodeProof);
    afterEach(() => resetNodeProofConfig(indexer));

    // The narrowed remedy for the scenario-18 regression: the ORIGINAL fix buried both
    // planes at once and lost an epoch, because burying the eligible-verifier set alone
    // makes an upgraded verifier accept bytes the rest of the fleet rejects (the hub's
    // FullNodeChallengeRound._eligibleVerifiers resolves raw). So acceptance stays raw
    // and only ATTRIBUTION buries: the hub challenged the full_node set CapabilitySnapshot
    // locked at epoch - buffer, so a node whose stake deactivated inside that window was
    // legitimately challenged and quorum-attested, yet a raw credit gate dropped its row.
    it('splits the two planes: eligible set raw, PASS credit and source buried', async function () {
        const data = v0Data();
        await handler.parse(v0Params({
            challengeId: validChallengeId(), pass: [PUBKEY_P], sigs: [{ pubkey: PUBKEY_V, sig: SIG_V }],
        }), data, null);

        assert.strictEqual(data['STATUS'], 'valid');
        assert.notStrictEqual(SET_BLOCK, EPOCH, 'burial must be armed for this suite to mean anything');

        // ACCEPTANCE PLANE: raw, and it must stay raw or this verifier forks off the hub.
        assert.ok(indexer.indexerDb.getVerifiedFullNodeSet.calledWith(EPOCH),
            'the eligible-verifier set must resolve at the raw declared epoch');
        assert.ok(indexer.indexerDb.getValidatorsByCapability.calledWith('full_node', EPOCH),
            'the quorum-divisor capability read must resolve at the raw declared epoch');

        // ATTRIBUTION PLANE: buried, matching the hub's locked claimant universe.
        assert.ok(indexer.indexerDb.getValidatorsByCapability.calledWith('full_node', SET_BLOCK),
            'the PASS credit gate must resolve at the buried height');
        assert.strictEqual(indexer.indexerDb.createNodeProofVerification.firstCall.args[6], SET_BLOCK,
            'the row must resolve its staking source at the buried height');

        // Declared plane untouched: the row still records the heights the wire declared,
        // and the block it actually landed in.
        const args = indexer.indexerDb.createNodeProofVerification.firstCall.args;
        assert.strictEqual(args[2], EPOCH);
        assert.strictEqual(args[3], TARGET);
        assert.strictEqual(args[5], 300);
    });
});

describe('NodeProof (NODEPROOF) @regression @tier3', function () {
    beforeEach(freshNodeProof);
    afterEach(() => resetNodeProofConfig(indexer));

    // The PASS list is joined into the ed25519 preimage, so its order is
    // consensus. Both sides of the seam are pinned to a Buffer byte comparator; the
    // input regex keeps every element lowercase 64-hex today, which is the ONLY reason
    // a bare .sort() was a total order here, and it is not a property the code states.
    it('signs over a BYTE-sorted PASS list, unchanged for lowercase-64-hex input', async function () {
        const data = v0Data();
        await handler.parse(v0Params({
            challengeId: validChallengeId(), pass: [PUBKEY_P2, PUBKEY_P],   // unsorted on the wire
            sigs: [{ pubkey: PUBKEY_V, sig: SIG_V }],
        }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        const canon = String(ed25519.verify.firstCall.args[0]);
        assert.ok(canon.endsWith('|' + [PUBKEY_P, PUBKEY_P2].join(',')),
            'PASS must be byte-sorted in the preimage, got: ' + canon);
    });

    it('the PASS sort is pinned on BOTH sides of the hub seam (cross-repo)', function () {
        // Pinning the VERIFIER alone would be strictly worse than doing nothing: it
        // would diverge from a still-bare PRODUCER on any future non-uniform input.
        // The hub's four PASS sorts and this one move together or not at all.
        const src = fs.readFileSync(path.join(__dirname, '../../../src/actions/nodeproof.js'), 'utf8');
        assert.match(src, /passList\.slice\(\)\.sort\(\s*\n?\s*\(a, b\) => Buffer\.compare\(/,
            'the indexer verdict canonical must sort PASS with the byte comparator');
        // The hub producer must be a trusted sibling, never a lane symlink into a live main checkout.
        const hubVerdict = siblingCheckout(__dirname, '../../../../xchain-hub/src/consensus/full_node_challenge_round.js');
        if (!hubVerdict.usable)
            return skipOrFail(this, hubVerdict, 'the cross-repo PASS sort pin on the hub producer');
        let hubSrc;
        try {
            hubSrc = fs.readFileSync(
                path.join(__dirname, '../../../../xchain-hub/src/consensus/full_node_challenge_round.js'), 'utf8');
        } catch (e) { return this.skip(); }
        assert.match(hubSrc, /const PASS_CMP = \(a, b\) => Buffer\.compare\(/,
            'the hub producer must define the same byte comparator');
        assert.strictEqual(/\bpass\.sort\(\)|passList\.slice\(\)\.sort\(\)|pass\.slice\(\)\.sort\(\)/.test(hubSrc), false,
            'a bare PASS sort survives in the hub producer; all four sites must use PASS_CMP');
        assert.strictEqual((hubSrc.match(/\.sort\(PASS_CMP\)/g) || []).length, 4,
            'the hub has exactly four PASS sort sites feeding the signed preimage');
    });
});

describe('NodeProof (NODEPROOF) @regression @tier3', function () {
    beforeEach(freshNodeProof);
    afterEach(() => resetNodeProofConfig(indexer));

    // ── chain scope ────────────────────────────────────────────────────────────
    it('is BTC-only : rejects on a non-BTC chain', async function () {
        indexer.config.COIN = 'DOGE';
        const data = v0Data();
        await handler.parse(v0Params({
            challengeId: validChallengeId(), pass: [PUBKEY_P], sigs: [{ pubkey: PUBKEY_V, sig: SIG_V }],
        }), data, null);
        assert.ok(String(data['STATUS']).includes('BTC-only'),
            'expected BTC-only rejection, got: ' + data['STATUS']);
    });
});
