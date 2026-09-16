'use strict';

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
// The keys, epoch geometry, wire builders and per-test context the NODEPROOF
// suite shares (nodeproof.test.js plus the files in nodeproof.test/).
// makeNodeProofContext builds a fresh mock indexer and handler with the
// NODEPROOF db stubs; resetNodeProofConfig undoes what a test may mutate. Each
// block calls them from its own hooks.

const sinon  = require('sinon');
const crypto = require('crypto');

const { createMockIndexer, createBaseData } = require('../../../../fixtures/mocks');

const NodeProof = require('../../../../../src/actions/nodeproof/index.js');
// Same cached module NodeProof references; stubbing verify() controls which
// verifier signatures the handler accepts toward quorum.
const ed25519   = require('../../../../../src/consensus/ed25519.js');
const srb       = require('../../../../../src/consensus/snapshot_reorg_buffer.js');

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
// The height the PASS-credit plane resolves at. EPOCH is the DECLARED height and it
// stays raw everywhere acceptance is decided (signed preimage, eligible-verifier set,
// quorum divisor, EQUIV flag-day plane), because the producing hub also resolves its
// eligible verifiers raw. Only the credit gate and the row's staking source bury, to
// match the claimant universe CapabilitySnapshot locked below the tip. Regtest arms
// snapshot burial from genesis, so the split is live in this suite.
const SET_BLOCK = EPOCH - srb.CANONICAL_REORG_BUFFER;   // 282

// Every pubkey this suite uses. The mock resolves the BATCHED capability set over
// it, mirroring db.js where getValidatorsByCapability and hasCapability answer from
// the same effectiveCapabilitySetSql.
const ALL_PUBKEYS = [PUBKEY_V, PUBKEY_V2, PUBKEY_P, PUBKEY_P2, PUBKEY_X];

function addNodeProofDbStubs(db) {
    db.getStoredBlockHashes        = sinon.stub().resolves({ ledger_hash: SEED });
    db.getVerifiedFullNodeSet      = sinon.stub().resolves([]);   // genesis-only universe by default
    db.hasCapability               = sinon.stub();
    db.getValidatorsByCapability   = sinon.stub();
    db.createNodeProofVerification = sinon.stub().resolves(true);
    setCapable(db, () => true);                                   // PASS pubkeys hold full_node
}

// Drive BOTH capability APIs from one predicate, the way db.js does: a case that
// says who qualifies stays honest whichever path the handler takes.
function setCapable(db, predicate) {
    db.hasCapability.callsFake(async (pubkey, cap, blk) => !!(await predicate(pubkey, cap, blk)));
    db.getValidatorsByCapability.callsFake(async (cap, blk) => {
        const rows = [];
        for (const pubkey of ALL_PUBKEYS)
            if (await predicate(pubkey, cap, blk)) rows.push({ pubkey, amount: '0' });
        rows.truncated = false;
        return rows;
    });
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

// The CHALLENGE_ID the handler derives for the suite's epoch on one network.
function validChallengeIdFor(network) {
    return deriveChallengeId(network, EPOCH, SEED, TARGET);
}

// A fresh mock indexer, actions context and NODEPROOF handler for one test.
function makeNodeProofContext() {
    const indexer = createMockIndexer();
    addNodeProofDbStubs(indexer.indexerDb);
    const NETWORK = indexer.config['NETWORK'];

    // Seed a single genesis verifier so a one-sig verdict reaches quorum
    // (V=1 → floor(2·1/3)+1 = 1). Assign a fresh FULLNODE object so per-test
    // mutations never leak into other suites sharing the cached config.
    indexer.config.FULLNODE = Object.assign({}, indexer.config.FULLNODE, {
        GENESIS_VERIFIERS: [PUBKEY_V],
    });

    const actionsCtx = {
        config:    indexer.config,
        util:      indexer.util,
        mapper:    indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
    };
    const handler = new NodeProof(actionsCtx);
    indexer.util.resetLists();

    // Default: every verifier signature verifies.
    sinon.stub(ed25519, 'verify').returns(true);
    return { indexer, actionsCtx, handler, NETWORK };
}

// Undo the sinon stubs and the COIN and FULLNODE config a test may have changed.
function resetNodeProofConfig(indexer) {
    sinon.restore();
    indexer.config.COIN = 'BTC';
    indexer.config.FULLNODE = Object.assign({}, indexer.config.FULLNODE, { GENESIS_VERIFIERS: [] });
}

module.exports = {
    PUBKEY_V, PUBKEY_V2, PUBKEY_P, PUBKEY_P2, PUBKEY_X, SIG_V, SIG_V2, SIG_X,
    EPOCH, TARGET, SEED, SET_BLOCK,
    setCapable, deriveChallengeId, v0Params, v0Data, validChallengeIdFor,
    makeNodeProofContext, resetNodeProofConfig,
};
