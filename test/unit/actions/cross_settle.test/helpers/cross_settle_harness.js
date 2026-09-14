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
// The harness the whole Cross_Settle suite runs on: real Ed25519 signers, the
// match builders, the cross_chain snapshot builder and a mock indexer with the
// cross-chain DB stubs. The suite is cross_settle.test.js plus the files in
// cross_settle.test/; each file keeps its own indexer/actionsCtx/handler names
// and fills them through useCrossSettleHarness, so the test bodies read exactly
// as they did when the suite was one file.

const crypto = require('crypto');
const sinon = require('sinon');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../../fixtures/mocks');

const Cross_Settle = require('../../../../../src/actions/cross_settle/index.js');
const swq          = require('../../../../../src/stake_weighted_quorum.js');

// ── Real Ed25519 keypair helpers ───────────────────────────────────────────
// cross_settle verifies signatures with the production ed25519.js (no stub), so
// the test signs the exact canonical string with a real key. Pubkey is the raw
// 32-byte hex (SPKI minus the 12-byte prefix); sig is the raw 64-byte hex.
const SPKI_PREFIX_LEN = 12;

function genValidator() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    const pubkey = spki.subarray(SPKI_PREFIX_LEN).toString('hex');
    return { pubkey, privateKey };
}

function signCanonical(privateKey, canonical) {
    return crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('hex');
}

// A complete, well-formed cross-chain match where THIS chain (BTC) is leg `a`.
function makeMatch(overrides) {
    return {
        match_id: 'm'.repeat(64),
        snapshot_block: 150,
        a_chain: 'BTC', a_action_index: 42, a_tick: 'AAA', a_amount: '10', a_ownership: 0,
        a_payout_addr: '1AApayoutXXXXXXXXXXXXXXXXXXXXXaKc5Z',
        b_chain: 'LTC', b_action_index: 99, b_tick: 'BBB', b_amount: '5', b_ownership: 0,
        b_payout_addr: 'LBBpayoutXXXXXXXXXXXXXXXXXXXXXaKc5Z',
        effective_time: 1700000000,
        network: 'regtest',
        validator_signatures: '[]',
        ...overrides,
    };
}

// The harness the running test was given. signMatch reads its handler, so the
// canonical it signs is the one that handler verifies.
let current = null;

// Build a signed match: returns the match with `validators` resolvable and
// validator_signatures populated by `n` valid signers over the canonical.
function signMatch(match, n) {
    const canonical = current.handler.canonical(match);
    const validators = [];
    const sigs = [];
    for (let i = 0; i < n; i++) {
        const v = genValidator();
        validators.push({ pubkey: v.pubkey });
        sigs.push({ pubkey: v.pubkey, sig: signCanonical(v.privateKey, canonical) });
    }
    match.validator_signatures = JSON.stringify(sigs);
    return { match, validators, sigs };
}

// A cross_chain validator snapshot of size N that INCLUDES every pubkey that
// signed `match`; the quorum counts only snapshot members (snapPubkeys.has), and
// pads to N with distinct non-signing keys so N drives the (legacy, swqStub-
// pinned) majority-floor quorum. A bare placeholder snapshot (e.g. [{}])
// deliberately omits the signers, modelling a non-member.
function snapFor(match, N) {
    let signed;
    try { signed = JSON.parse(match.validator_signatures || '[]'); } catch (_) { signed = []; }
    const out = [], seen = new Set();
    for (const s of (Array.isArray(signed) ? signed : [])) {
        const pk = (s && typeof s.pubkey === 'string') ? s.pubkey.toLowerCase() : null;
        if (pk && /^[0-9a-f]{64}$/.test(pk) && !seen.has(pk)) { seen.add(pk); out.push({ pubkey: pk }); }
    }
    while (out.length < N) out.push({ pubkey: genValidator().pubkey });
    return out;
}

// One fresh harness, built the way every Cross_Settle test starts.
function createCrossSettleHarness() {
    const indexer = createMockIndexer();
    const actionsCtx = {
        config: indexer.config,
        util: indexer.util,
        mapper: indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
    };
    const handler = new Cross_Settle(actionsCtx);
    indexer.util.resetLists();

    // These cases assert legacy COUNT quorum (the live mainnet path, whose
    // activation height is a far-future placeholder). On regtest, the
    // stake-weighted quorum is active at every block, so pin the legacy path
    // explicitly : the validator mocks below carry no source/weight and the
    // weighted predicate diverges from the majority floor at N=3. Weighted
    // coverage lives in stake_weighted_quorum.test.js.
    const swqStub = sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);

    // Cross-chain DB methods not present in the shared mock : add neutral stubs.
    indexer.indexerDb.getValidatorsByCapability = sinon.stub().resolves([]);
    indexer.indexerDb.hasCapability = sinon.stub().resolves(true);
    indexer.indexerDb.recordCrossChainSettlement = sinon.stub().resolves();
    indexer.indexerDb.clearTokenEscrow = sinon.stub().resolves();

    // Local offer resolves open by default; the AAA token exists.
    indexer.indexerDb.getSwapInfo.resolves({
        SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        SWAP_STATUS: 'open',
    });
    indexer.indexerDb.getTokenInfo.callsFake(async (tick) =>
        createTokenInfo({ TICK: tick, TICK_ID: 1, DECIMALS: 0 }));
    indexer.indexerDb.createActionIndex.resolves(777);
    return { indexer, actionsCtx, handler, swqStub };
}

// Mocha hooks for one describe block: a fresh harness before every test, handed
// to bind so the calling file can fill its own names, and sinon restored after.
function useCrossSettleHarness(bind) {
    beforeEach(function () {
        current = createCrossSettleHarness();
        bind(current);
    });

    // Restores swqStub plus the per-test stubs created in beforeEach : without
    // this the default sandbox accumulates across cases (sinon leak warning).
    afterEach(function () { sinon.restore(); });
}

function makeData(overrides) {
    return createBaseData({ ACTION: 'CROSS_SETTLE', BLOCK_INDEX: 200, ...overrides });
}

module.exports = {
    genValidator, signCanonical, makeMatch, signMatch, snapFor, makeData,
    createCrossSettleHarness, useCrossSettleHarness,
};
