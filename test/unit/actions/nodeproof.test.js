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
const fs     = require('fs');
const path   = require('path');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const NodeProof = require('../../../src/actions/nodeproof.js');
// Same cached module NodeProof references; stubbing verify() controls which
// verifier signatures the handler accepts toward quorum.
const ed25519   = require('../../../src/ed25519.js');
const srb       = require('../../../src/snapshot_reorg_buffer.js');

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
// The height every full_node VALIDATOR-SET read resolves at. EPOCH is the DECLARED
// height (signed preimage, verification rows, EQUIV flag-day plane) and stays raw;
// the set reads bury it by CANONICAL_REORG_BUFFER, matching the producing hub, which
// locks its claimant universe through CapabilitySnapshot at the same buried height.
// Regtest arms snapshot burial from genesis, so the split is live in this suite.
const SET_BLOCK = EPOCH - srb.CANONICAL_REORG_BUFFER;   // 282

describe('NodeProof (NODEPROOF) @regression @tier3', function () {
    let indexer, actionsCtx, handler, NETWORK;

    // Every pubkey this suite uses. The mock resolves the BATCHED capability set over
    // it, mirroring db.js where getValidatorsByCapability and hasCapability answer from
    // the same _effectiveCapabilitySetSql (#3873).
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

    // The producing hub locks its claimant universe below the tip (CapabilitySnapshot
    // buries every getSnapshot) and now asks getfullnodeverifiers for the same buried
    // height. A verifier re-deriving at the raw epoch resolved a DIFFERENT full_node
    // set whenever stake moved inside the buffer window: it dropped the verification
    // row for a node the hub had already challenged and quorum-signed, and it sized the
    // 2/3+1 divisor off a tip-adjacent, reorg-unstable height. Both set reads bury; the
    // declared height keeps riding the wire and the rows unchanged.
    it('resolves both full_node set reads at the buried height, leaving the declared height raw', async function () {
        const data = v0Data();
        await handler.parse(v0Params({
            challengeId: validChallengeId(), pass: [PUBKEY_P], sigs: [{ pubkey: PUBKEY_V, sig: SIG_V }],
        }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.notStrictEqual(SET_BLOCK, EPOCH, 'burial must be armed for this suite to mean anything');
        // Eligible-verifier universe (the quorum divisor) and the PASS credit gate.
        assert.ok(indexer.indexerDb.getVerifiedFullNodeSet.calledWith(SET_BLOCK),
            'the eligible-verifier set must resolve below the tip, not at the raw epoch');
        assert.ok(indexer.indexerDb.getValidatorsByCapability.getCalls()
            .every(c => c.args[1] === SET_BLOCK),
            'every full_node capability read must resolve at the buried height');
        // Declared plane untouched: the row still records the epoch the wire declared.
        assert.strictEqual(indexer.indexerDb.createNodeProofVerification.firstCall.args[2], EPOCH);
        assert.strictEqual(indexer.indexerDb.createNodeProofVerification.firstCall.args[3], TARGET);
    });

    it('records one row per PASS pubkey', async function () {
        const data = v0Data();
        await handler.parse(v0Params({
            challengeId: validChallengeId(), pass: [PUBKEY_P, PUBKEY_P2], sigs: [{ pubkey: PUBKEY_V, sig: SIG_V }],
        }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(indexer.indexerDb.createNodeProofVerification.callCount, 2);
    });

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
        // Both loops used to run hasCapability (~5 sequential queries) per element: the
        // verifier intersect that sizes the quorum divisor, and the PASS recording pass
        // (#3873). Two batched reads now answer both, whatever the list length.
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
        assert.ok(indexer.indexerDb.getValidatorsByCapability.calledWith('full_node', SET_BLOCK));
        // And the DECLARED height never leaks into a set read: the two planes are the
        // whole point of the burial split, so a regression that collapses them here
        // would otherwise pass on the batched-read assertion alone.
        assert.ok(!indexer.indexerDb.getValidatorsByCapability.calledWith('full_node', EPOCH),
            'no full_node set read may resolve at the raw declared epoch');
    });

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
        assert.ok(indexer.indexerDb.hasCapability.calledWith(PUBKEY_P, 'full_node', SET_BLOCK),
            'a capped read must be re-probed, not trusted as membership');
        // V + P are both eligible → quorum floor(2*2/3)+1 = 2, and only V signed.
        assert.ok(String(data['STATUS']).includes('1/2 of 2'),
            'the truncated read must not shrink the divisor, got: ' + data['STATUS']);
    });

    // #3859: the PASS list is joined into the ed25519 preimage, so its order is
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
        let hubSrc;
        try {
            hubSrc = fs.readFileSync(
                path.join(__dirname, '../../../../xchain-hub/src/FullNodeChallengeRound.js'), 'utf8');
        } catch (e) { return this.skip(); }
        assert.match(hubSrc, /const PASS_CMP = \(a, b\) => Buffer\.compare\(/,
            'the hub producer must define the same byte comparator');
        assert.strictEqual(/\bpass\.sort\(\)|passList\.slice\(\)\.sort\(\)|pass\.slice\(\)\.sort\(\)/.test(hubSrc), false,
            'a bare PASS sort survives in the hub producer; all four sites must use PASS_CMP');
        assert.strictEqual((hubSrc.match(/\.sort\(PASS_CMP\)/g) || []).length, 4,
            'the hub has exactly four PASS sort sites feeding the signed preimage');
    });

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
