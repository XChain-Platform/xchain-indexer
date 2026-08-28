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
// _buildV7Payload) is asserted to reproduce these exact bytes in xchain-hub
// test/unit/StateAnchorPublisher.test.js against the same vendored
// anchor_canonical_vectors.json. Here we feed those frozen bytes through the real
// indexer parser and assert it positionally extracts the fixture fields. If either
// repo reorders a field, its own side breaks against the shared frozen string, so a
// silent producer/parser drift (which forks validator signatures) fails loudly in CI
// without needing a sibling-repo checkout. Authoritative copy + provenance:
// xchain-documentation/protocol/test-vectors/anchor_canonical.json.
//
// The fixture's `bundle` deliberately lists its sections (LTC, BTC, DOGE) and one
// signature list OUT of the wire's order, so a test that merely echoed fixture order
// would fail: the ordering rules (sections CHAIN ascending, pairs PUBKEY ascending,
// D5) are what make two publishers emit identical bytes for one bundle.

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
const BUNDLE = GOLDEN.fixture.bundle;
// Wire order: sections CHAIN ascending, which the fixture object deliberately is not.
const WIRE_SECTIONS = BUNDLE.sections.slice().sort((a, b) => (a.chain < b.chain ? -1 : a.chain > b.chain ? 1 : 0));
// Every distinct signer across the bundle: all of them hold oracle_publish in these
// tests, so both the per-section root quorum and the bundle attestation verify.
const SIGNERS = [...new Set(
    WIRE_SECTIONS.flatMap(s => s.validator_signatures.map(v => v.pubkey))
        .concat(BUNDLE.attest_sigs.map(v => v.pubkey)))];

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

    it('the retired per-chain vectors are gone (v0/v3/v4/v5 deleted, not deprecated)', function () {
        for (const v of ['v0', 'v3', 'v4', 'v5'])
            assert.strictEqual(GOLDEN.vectors[v], undefined,
                'vector ' + v + ' is retired (D2); its parser is deleted, so keeping the case would ' +
                'pin a wire nothing produces or reads');
    });
});

describe('Anchor frozen canonical wire vectors (parser side) @regression', function () {
    let indexer, handler, verifyStub, swqStub, deriveGateStub;

    beforeEach(function () {
        indexer = createMockIndexer();
        indexer.config = Object.assign({}, indexer.config, { COIN: 'DOGE', NETWORK: 'regtest' });
        indexer.indexerDb.getValidatorsByCapability  = sinon.stub().resolves(
            SIGNERS.map(pubkey => ({ pubkey, amount: '1' })));
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
        // pin the derive-relocation gate OFF so these vectors exercise the DOGE-side
        // reward write (the below-gate / mainnet behavior). The live regtest/testnet
        // path skips that write; its own case is in anchor.test.js.
        deriveGateStub = sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(false);
    });
    afterEach(function () { verifyStub.restore(); swqStub.restore(); deriveGateStub.restore(); });

    function writtenRows() { return indexer.indexerDb.createAnchorAction.getCalls().map(c => c.args[0]); }

    // The wire string the encoder/decoder hands the action framework has the leading
    // 'ANCHOR' keyword stripped, so params[0] = VERSION.
    function wireToParams(vector) {
        const parts = vector.split('|');
        assert.strictEqual(parts[0], 'ANCHOR', 'golden vector must begin with the ANCHOR keyword');
        return parts.slice(1);
    }

    async function parseV7() {
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE' });
        await handler.parse(wireToParams(GOLDEN.vectors.v7), data, null);
        return data;
    }

    // The params index of section `n`'s first slot (its CHAIN), walked the same way the
    // parser walks it: 13 fixed slots then 2*SIG_COUNT signature slots. Derived from the
    // frozen bytes rather than hard-coded, so a hostile variant below is built out of the
    // real wire instead of a hand-written imitation of it.
    function sectionStart(params, n) {
        let cursor = 4;
        for (let i = 0; i < n; i++) cursor += 13 + 2 * parseInt(params[cursor + 12]);
        return cursor;
    }

    it('v7: the frozen bytes parse to one valid row per section, in wire order', async function () {
        const data = await parseV7();
        assert.strictEqual(data['STATUS'], 'valid', `unexpected STATUS ${data['STATUS']}`);

        const rows = writtenRows();
        assert.strictEqual(rows.length, WIRE_SECTIONS.length,
            'one anchor_actions row per section, not one per action');
        rows.forEach((row, i) => {
            const want = WIRE_SECTIONS[i];
            assert.strictEqual(Number(row['SECTION_INDEX']), i, 'section_index follows WIRE order');
            assert.strictEqual(row['CHAIN'], want.chain);
            assert.strictEqual(String(row['BLOCK_INDEX_CHECKPOINTED']), String(want.block_index));
            assert.strictEqual(row['BLOCK_HASH'], want.block_hash);
            assert.strictEqual(row['LEDGER_HASH'], want.ledger_hash);
            assert.strictEqual(row['ACTIONS_HASH'], want.actions_hash);
            assert.strictEqual(row['CONTRACT_HASH'], want.contract_hash);
            assert.strictEqual(String(row['CHECKPOINT_SEQ']), String(want.checkpoint_seq));
            assert.strictEqual(String(row['SNAPSHOT_BLOCK']), String(want.snapshot_block));
            assert.strictEqual(row['STATE_ROOT'], want.state_root);
            assert.strictEqual(String(row['STATE_ROOT_VERSION']), String(want.state_root_version));
            assert.strictEqual(row['BLOCK_MERKLE_ROOT'], want.block_merkle_root);
            assert.strictEqual(String(row['BLOCK_MERKLE_VERSION']), String(want.block_merkle_version));
            assert.strictEqual(Number(row['FORMAT']), 7);
            assert.strictEqual(row['STATUS'], 'valid');
        });
        // The fixture lists LTC first; the wire (and therefore section_index 0) is BTC.
        assert.strictEqual(rows[0]['CHAIN'], 'BTC',
            'section order is CHAIN ascending on the wire, not the fixture object\'s order');
    });

    it('sanity: the section walk locates the frozen vector\'s three CHAIN slots', function () {
        // If this drifts, the duplicate-chain case below would be mutating some other
        // field and would pass for the wrong reason.
        const params = wireToParams(GOLDEN.vectors.v7);
        assert.deepStrictEqual([0, 1, 2].map(n => params[sectionStart(params, n)]),
            WIRE_SECTIONS.map(s => s.chain));
    });

    it('v7: a bundle naming the same CHAIN twice is invalid as a WHOLE, with zero rewards (D39)', async function () {
        // Built out of the frozen bytes: rewrite the LAST section's CHAIN to repeat the
        // first one's. The hub's selector groups by (chain, network) and can only produce
        // one section per chain, so a repeat is malformed or forged - and a second
        // checkpoint claim for one chain under a single publisher signature cannot be
        // skipped, because every per-chain reader resolves an identity to a row without
        // seeing the sibling row that contradicts it.
        const params = wireToParams(GOLDEN.vectors.v7);
        params[sectionStart(params, 2)] = params[sectionStart(params, 0)];   // LTC -> BTC
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE' });
        await handler.parse(params, data, null);

        assert.strictEqual(data['STATUS'], 'invalid: SECTION 2 CHAIN (duplicate)');
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled,
            'a duplicate-chain bundle pays nothing, not even for its well-formed sections');
        assert.ok(indexer.indexerDb.reconcileAnchorRewardWinner.notCalled);
        assert.ok(writtenRows().every(r => r['STATUS'] === data['STATUS']),
            'the verdict is all-or-nothing: no section row is left valid');
    });

    it('v7: the duplicate guard is scoped to ONE bundle, so a chain repeats across actions', async function () {
        // The frozen vector parsed twice: each action carries BTC/DOGE/LTC once, and the
        // second must be as valid as the first. A guard leaking across actions would make
        // the second cycle's bundle invalid forever.
        assert.strictEqual((await parseV7())['STATUS'], 'valid');
        assert.strictEqual((await parseV7())['STATUS'], 'valid');
    });

    it('v7: the header NETWORK and block_index are denormalized onto EVERY section row', async function () {
        await parseV7();
        for (const row of writtenRows()) {
            assert.strictEqual(row['NETWORK'], BUNDLE.network,
                'every section carries the BUNDLE network: idx_anchor_checkpoint and ' +
                'getMaxAnchorCheckpointSeq(chain, network) read it off the row');
            assert.ok(row['BLOCK_INDEX_CHECKPOINTED'] != null, 'every section carries its own block_index');
        }
    });

    it('v7: publisher and publisher_attestations are written on every section row', async function () {
        const data = await parseV7();
        assert.strictEqual(data['PUBLISHER'], BUNDLE.publisher);
        for (const row of writtenRows()) {
            assert.strictEqual(row['PUBLISHER'], BUNDLE.publisher);
            assert.deepStrictEqual(JSON.parse(row['PUBLISHER_ATTESTATIONS']), BUNDLE.attest_sigs,
                'the RAW wire tail is denormalized onto every row (UNVERIFIED transport)');
        }
    });

    it('v7: each section row stores its OWN signature list', async function () {
        await parseV7();
        writtenRows().forEach((row, i) => {
            const want = WIRE_SECTIONS[i].validator_signatures;
            const got  = JSON.parse(row['VALIDATOR_SIGNATURES']);
            assert.strictEqual(got.length, want.length);
            // Compared as a SET: the fixture's BTC section lists its pairs out of PUBKEY
            // order on purpose, and the wire carries them sorted (D5).
            assert.deepStrictEqual(
                got.map(s => s.pubkey).sort(),
                want.map(s => s.pubkey).sort());
        });
    });

    it('v7: exactly ONE anchor_bundle reward per bundle, over the exact canonical bytes', async function () {
        const data = await parseV7();
        assert.ok(indexer.indexerDb.createValidatorReward.calledOnce,
            'a bundle earns ONE reward, not one per section');
        const [publisher, round, type, amount, earnBlock, , , qualifier] =
            indexer.indexerDb.createValidatorReward.firstCall.args;
        assert.strictEqual(publisher, BUNDLE.publisher);
        assert.strictEqual(type, 'anchor_bundle');
        assert.strictEqual(round, BUNDLE.snapshot_block, 'round_reference IS the snapshot block');
        assert.strictEqual(amount, require('../../../src/anchor_reward_activation.js').ANCHOR_REWARD_AMOUNT);
        assert.strictEqual(earnBlock, BUNDLE.snapshot_block);
        assert.strictEqual(qualifier, 0, 'a bundle round_reference only advances, so qualifier is 0');

        // The bytes the attestation quorum signed, six positional fields with
        // round_reference repeated as the snapshot block (D22).
        const eq = require('../../../src/equivocation_header.js');
        const canonical = handler._rewardCanonical(data);
        const expected  = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT,
            'XANCPUB|bundle|' + BUNDLE.network + '|' + BUNDLE.snapshot_block, 0,
            ['XANCPUB', 'anchor_bundle', String(BUNDLE.snapshot_block), String(BUNDLE.snapshot_block),
             BUNDLE.publisher, require('../../../src/anchor_reward_activation.js').ANCHOR_REWARD_AMOUNT].join('|'));
        assert.strictEqual(canonical, expected,
            'the bundle XANCPUB canonical drifted from the frozen six-field layout');
    });

    it('v7: each section canonical is rebuilt with the HEADER network, at the section\'s own block', async function () {
        await parseV7();
        const eq = require('../../../src/equivocation_header.js');
        for (const row of writtenRows()) {
            const canonical = handler._canonical(row);
            const base = ['XCHECKPOINT', row['CHAIN'], BUNDLE.network, String(row['BLOCK_INDEX_CHECKPOINTED']),
                          row['BLOCK_HASH'], row['LEDGER_HASH'], row['ACTIONS_HASH'], row['CONTRACT_HASH'],
                          String(row['CHECKPOINT_SEQ']), String(row['SNAPSHOT_BLOCK']),
                          row['STATE_ROOT'], String(row['STATE_ROOT_VERSION']),
                          row['BLOCK_MERKLE_ROOT'], String(row['BLOCK_MERKLE_VERSION'])].join('|');
            const roundId = row['CHAIN'] + '|' + BUNDLE.network + '|' +
                            row['BLOCK_INDEX_CHECKPOINTED'] + '|' + row['CHECKPOINT_SEQ'];
            assert.strictEqual(canonical,
                eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, base),
                'a v7 section canonical must byte-match the per-chain XCHECKPOINT the hub signed');
        }
    });
});
