// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const NodeProof = require('../../../src/actions/nodeproof.js');
// Same cached module NodeProof references — stubbing verify() controls which
// verifier signatures the handler accepts toward quorum.
const ed25519   = require('../../../src/ed25519.js');

// 64-hex pubkeys / 128-hex sigs (format-valid; verification is stubbed)
const PUBKEY_V  = 'a'.repeat(64);   // genesis verifier (signs the verdict)
const PUBKEY_V2 = 'b'.repeat(64);   // second genesis verifier
const PUBKEY_P  = 'c'.repeat(64);   // claimant full node (being verified)
const PUBKEY_P2 = 'd'.repeat(64);   // second claimant
const PUBKEY_X  = 'e'.repeat(64);   // outsider (not eligible)
const SIG_V     = '1'.repeat(128);
const SIG_V2    = '2'.repeat(128);
const SIG_X     = '3'.repeat(128);

// Epoch geometry consistent with the regtest FULLNODE config
// (interval 144, confirm-depth 100, accept-window 24).
const EPOCH  = 288;          // multiple of 144
const TARGET = EPOCH - 100;  // 188
const SEED   = 'f'.repeat(64);

describe('NodeProof (NODEPROOF) @regression @tier3', function () {
    let indexer, actionsCtx, handler, NETWORK;

    function addNodeProofDbStubs(db) {
        db.getStoredBlockHashes        = sinon.stub().resolves({ ledger_hash: SEED });
        db.getVerifiedFullNodeSet      = sinon.stub().resolves([]);   // genesis-only universe by default
        db.hasCapability               = sinon.stub().resolves(true); // PASS pubkeys hold full_node
        db.createNodeProofVerification = sinon.stub().resolves(true);
    }

    // Mirror the handler's deterministic challenge derivation.
    function deriveChallengeId(network, epoch, ledger, target) {
        return crypto.createHash('sha256')
            .update(String(network) + ':' + epoch + ':' + String(ledger) + ':' + target)
            .digest('hex');
    }

    // NODEPROOF|0|CHALLENGE_ID|EPOCH_HEIGHT|PASS_COUNT|PASS_PK...|SIG_COUNT|PUBKEY|SIG|...
    function v0Params({ challengeId, epoch = EPOCH, pass = [], sigs = [] }) {
        const out = ['0', challengeId, String(epoch), String(pass.length)];
        for (const pk of pass) out.push(pk);
        out.push(String(sigs.length));
        for (const s of sigs) out.push(s.pubkey, s.sig);
        return out;
    }
    function v0Data(overrides = {}) {
        return createBaseData({ ACTION: 'NODEPROOF', FORMAT: 0, BLOCK_INDEX: 300, ACTION_INDEX: 55, ...overrides });
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        addNodeProofDbStubs(indexer.indexerDb);
        NETWORK = indexer.config['NETWORK'];

        // Seed a single genesis verifier so a one-sig verdict reaches quorum
        // (V=1 → floor(2·1/3)+1 = 1). Assign a fresh FULLNODE object so per-test
        // mutations never leak into other suites sharing the cached config.
        indexer.config.FULLNODE = Object.assign({}, indexer.config.FULLNODE, {
            GENESIS_VERIFIERS: [PUBKEY_V],
        });

        actionsCtx = {
            config:    indexer.config,
            util:      indexer.util,
            mapper:    indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
        };
        handler = new NodeProof(actionsCtx);
        indexer.util.resetLists();

        // Default: every verifier signature verifies.
        sinon.stub(ed25519, 'verify').returns(true);
    });

    afterEach(function () {
        sinon.restore();
        indexer.config.COIN = 'BTC';
        indexer.config.FULLNODE = Object.assign({}, indexer.config.FULLNODE, { GENESIS_VERIFIERS: [] });
    });

    function validChallengeId() {
        return deriveChallengeId(NETWORK, EPOCH, SEED, TARGET);
    }

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
    });

    it('records one row per PASS pubkey', async function () {
        const data = v0Data();
        await handler.parse(v0Params({
            challengeId: validChallengeId(), pass: [PUBKEY_P, PUBKEY_P2], sigs: [{ pubkey: PUBKEY_V, sig: SIG_V }],
        }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(indexer.indexerDb.createNodeProofVerification.callCount, 2);
    });

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

    // ── PASS-pubkey capability gate ────────────────────────────────────────────
    it('does not record a PASS pubkey that lacks the full_node capability', async function () {
        // Quorum still met, but the PASS pubkey fails the capability check → not recorded.
        indexer.indexerDb.hasCapability.callsFake(async (pk, cap) => cap !== 'full_node' || pk !== PUBKEY_P);
        const data = v0Data();
        await handler.parse(v0Params({
            challengeId: validChallengeId(), pass: [PUBKEY_P], sigs: [{ pubkey: PUBKEY_V, sig: SIG_V }],
        }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.createNodeProofVerification.notCalled,
            'a non-staking PASS pubkey must not be recorded');
    });

    // ── chain scope ────────────────────────────────────────────────────────────
    it('is BTC-only — rejects on a non-BTC chain', async function () {
        indexer.config.COIN = 'DOGE';
        const data = v0Data();
        await handler.parse(v0Params({
            challengeId: validChallengeId(), pass: [PUBKEY_P], sigs: [{ pubkey: PUBKEY_V, sig: SIG_V }],
        }), data, null);
        assert.ok(String(data['STATUS']).includes('BTC-only'),
            'expected BTC-only rejection, got: ' + data['STATUS']);
    });
});
