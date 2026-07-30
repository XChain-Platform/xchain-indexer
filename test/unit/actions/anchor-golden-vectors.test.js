// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Frozen ANCHOR canonical wire vectors: the PARSER half of the hub<->indexer
// byte-identity contract. The hub PRODUCER (xchain-hub StateAnchorPublisher
// _buildV0/V3/V4/V5Payload) is asserted to reproduce these exact bytes in
// xchain-hub test/unit/StateAnchorPublisher.test.js against the same vendored
// anchor_canonical_vectors.json. Here we feed those frozen bytes through the real
// indexer parser and assert it positionally extracts the fixture fields. If either
// repo reorders a field, its own side breaks against the shared frozen string, so a
// silent producer/parser drift (which forks validator signatures) fails loudly in CI
// without needing a sibling-repo checkout. Authoritative copy + provenance:
// xchain-documentation/protocol/test-vectors/anchor_canonical.json.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');
const Anchor   = require('../../../src/actions/anchor.js');
const ed25519  = require('../../../src/ed25519.js');
const swq      = require('../../../src/stake_weighted_quorum.js');
const arMod    = require('../../../src/anchor_reward_activation.js');

const fs     = require('fs');
const path   = require('path');

const GOLDEN = require('../../fixtures/anchor_canonical_vectors.json');
const ROW    = GOLDEN.fixture.row;
const SIGS   = ROW.validator_signatures;

// Byte-identity guard: the vendored fixture MUST match its canonical authority so a
// silent edit to one copy (which would fork the hub-producer / indexer-parser wire
// contract) fails loudly. Skips green when the sibling doc is absent, unless
// XCHAIN_REQUIRE_SIBLINGS=1 (CI) forces a hard failure. The hub-producer half is
// asserted in xchain-hub against the same canonical file.
const CANON_VECTORS = path.resolve(__dirname, '../../../../xchain-documentation/protocol/test-vectors/anchor_canonical.json');
const FIXTURE_PATH  = path.resolve(__dirname, '../../fixtures/anchor_canonical_vectors.json');

describe('Anchor canonical vectors byte-identity to xchain-documentation @regression', function () {
    it('fixture is byte-identical to xchain-documentation/protocol/test-vectors/anchor_canonical.json', function () {
        if (!fs.existsSync(CANON_VECTORS)) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but canonical anchor vectors not found at ' + CANON_VECTORS);
            this.skip();
            return;
        }
        const local = fs.readFileSync(FIXTURE_PATH, 'utf8');
        const canon = fs.readFileSync(CANON_VECTORS, 'utf8');
        assert.strictEqual(local, canon,
            'this repo\'s anchor_canonical_vectors.json has drifted from the canonical ' +
            'xchain-documentation/protocol/test-vectors/anchor_canonical.json; reconcile both copies.');
    });
});

// The wire string the encoder/decoder hands the action framework has the leading
// 'ANCHOR' keyword stripped, so params[0] = VERSION (mirrors v0Params() et al.).
function wireToParams(vector) {
    const parts = vector.split('|');
    assert.strictEqual(parts[0], 'ANCHOR', 'golden vector must begin with the ANCHOR keyword');
    return parts.slice(1);
}

describe('Anchor frozen canonical wire vectors (parser side) @regression', function () {
    let indexer, handler, verifyStub, swqStub, deriveGateStub;

    beforeEach(function () {
        indexer = createMockIndexer();
        indexer.config = Object.assign({}, indexer.config, { COIN: 'DOGE', NETWORK: 'regtest' });
        // The two validators in the fixture both hold oracle_publish, so the 2-sig
        // root quorum and the publisher attestation both verify -> STATUS 'valid'.
        indexer.indexerDb.getValidatorsByCapability  = sinon.stub().resolves(
            SIGS.map(s => ({ pubkey: s.pubkey, amount: '1' })));
        indexer.indexerDb.hasCapability              = sinon.stub().resolves(true);
        indexer.indexerDb.getMaxAnchorCheckpointSeq  = sinon.stub().resolves(null);
        indexer.indexerDb.getArchiveReplayWatermarks = sinon.stub().resolves({ batchSeq: null, checkpointSeq: null });
        indexer.indexerDb.createAnchorAction         = sinon.stub().resolves();
        indexer.indexerDb.getAnchorV1ByBatchSeq      = sinon.stub().resolves(null);
        indexer.indexerDb.getAnchorChunks            = sinon.stub().resolves([]);
        indexer.indexerDb.setAnchorArchiveStatus     = sinon.stub().resolves();
        indexer.indexerDb.createValidatorReward      = sinon.stub().resolves(true);
        indexer.indexerDb.reconcileAnchorRewardWinner= sinon.stub().resolves(0);
        handler = new Anchor(indexer);
        verifyStub = sinon.stub(ed25519, 'verify').returns(true);
        // Pin the legacy COUNT quorum path (regtest stake-weighted quorum is active at
        // every block); the fixture sigs carry no source/weight.
        swqStub = sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
        // : pin the derive-relocation gate OFF so these vectors exercise the legacy
        // DOGE-side reward write (the below-gate / mainnet behavior).
        deriveGateStub = sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(false);
    });
    afterEach(function () { verifyStub.restore(); swqStub.restore(); deriveGateStub.restore(); });

    function lastWrite() { return indexer.indexerDb.createAnchorAction.lastCall.args[0]; }

    // Shared assertions for the checkpoint fields every version carries (v0 field order).
    function assertCheckpointFields(row) {
        assert.strictEqual(row['CHAIN'], 'DOGE');
        assert.strictEqual(String(row['BLOCK_INDEX_CHECKPOINTED']), String(ROW.block_index));
        assert.strictEqual(row['BLOCK_HASH'], ROW.block_hash);
        assert.strictEqual(row['LEDGER_HASH'], ROW.ledger_hash);
        assert.strictEqual(row['ACTIONS_HASH'], ROW.actions_hash);
        assert.strictEqual(row['CONTRACT_HASH'], ROW.contract_hash);
        assert.strictEqual(String(row['CHECKPOINT_SEQ']), String(ROW.checkpoint_seq));
        assert.strictEqual(String(row['SNAPSHOT_BLOCK']), String(ROW.snapshot_block));
    }

    it('v0: parser extracts the checkpoint fields from the frozen bytes', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(wireToParams(GOLDEN.vectors.v0), data, null);
        assert.strictEqual(data['STATUS'], 'valid', `unexpected STATUS ${data['STATUS']}`);
        assertCheckpointFields(lastWrite());
    });

    it('v3: parser extracts the checkpoint + SPV root fields from the frozen bytes', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 3, COIN: 'DOGE' });
        await handler.parse(wireToParams(GOLDEN.vectors.v3), data, null);
        assert.strictEqual(data['STATUS'], 'valid', `unexpected STATUS ${data['STATUS']}`);
        let row = lastWrite();
        assertCheckpointFields(row);
        assert.strictEqual(row['STATE_ROOT'], ROW.state_root);
        assert.strictEqual(String(row['STATE_ROOT_VERSION']), String(ROW.state_root_version));
        assert.strictEqual(row['BLOCK_MERKLE_ROOT'], ROW.block_merkle_root);
        assert.strictEqual(String(row['BLOCK_MERKLE_VERSION']), String(ROW.block_merkle_version));
    });

    it('v4: parser extracts the checkpoint fields + PUBLISHER and derives the reward', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 4, COIN: 'DOGE' });
        await handler.parse(wireToParams(GOLDEN.vectors.v4), data, null);
        assert.strictEqual(data['STATUS'], 'valid', `unexpected STATUS ${data['STATUS']}`);
        assertCheckpointFields(lastWrite());
        assert.strictEqual(data['PUBLISHER'], GOLDEN.fixture.publisher);
        assert.ok(indexer.indexerDb.createValidatorReward.calledOnce);
    });

    it('v5: parser extracts the checkpoint + root fields + PUBLISHER and derives the reward', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 5, COIN: 'DOGE' });
        await handler.parse(wireToParams(GOLDEN.vectors.v5), data, null);
        assert.strictEqual(data['STATUS'], 'valid', `unexpected STATUS ${data['STATUS']}`);
        let row = lastWrite();
        assertCheckpointFields(row);
        assert.strictEqual(row['STATE_ROOT'], ROW.state_root);
        assert.strictEqual(data['PUBLISHER'], GOLDEN.fixture.publisher);
        assert.ok(indexer.indexerDb.createValidatorReward.calledOnce);
    });
});
