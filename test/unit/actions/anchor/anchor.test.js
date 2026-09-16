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
// ANCHOR action handler: the per-network checkpoint bundle (v0), the archive
// head (v1) and its continuation chunks (v2).
//
// This file holds the bundle reward and the v1 archive head. The v0 bundle
// checks, the activation gate, the archive replay guard and the chunk path live
// beside it in anchor.test/, each opening the same 'Anchor (ANCHOR) @regression
// @tier3' describe so every full test title is unchanged;
// anchor.test/helpers/anchor_fixtures.js holds the wire builders and the mock
// handler they share.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../fixtures/mocks');
const { PUBKEY_A, PUBKEY_B, SIG, HASH, crc32Hex, gz64, v0Params, THREE_CHAINS, v1Params, ARCHIVE_JSON, PUBLISHER, armAnchor, disarmAnchor } = require('./anchor.test/helpers/anchor_fixtures.js');
const Anchor = require('../../../../src/actions/anchor/index.js');
const eq = require('../../../../src/equivocation_header.js');

let indexer, handler, verifyStub, swqStub, deriveGateStub;

function lastWrite() { return indexer.indexerDb.createAnchorAction.lastCall.args[0]; }

function writtenRows() { return indexer.indexerDb.createAnchorAction.getCalls().map(c => c.args[0]); }

describe('Anchor (ANCHOR) @regression @tier3', function () {
    beforeEach(function () {
        ({ indexer, handler, verifyStub, swqStub, deriveGateStub } = armAnchor());
    });
    afterEach(function () {
        disarmAnchor({ verifyStub, swqStub, deriveGateStub });
    });

    // ── the bundle reward ────────────────────────────────────────────────────────────
    it('v0 with a valid publisher attestation DERIVES exactly ONE anchor_bundle reward', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({ sections: THREE_CHAINS }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(data['PUBLISHER'], PUBKEY_A);
        assert.ok(indexer.indexerDb.createValidatorReward.calledOnce,
            'ONE reward per bundle, not one per section');
        // (pubkeyHex, roundReference, rewardType, amount, blockIndex, upsert,
        // deriveBlockIndex, roundQualifier) - frozen amount, NOT wire. round_reference is
        // SNAPSHOT_BLOCK, a height that only advances, so the qualifier stays 0.
        assert.deepStrictEqual(indexer.indexerDb.createValidatorReward.firstCall.args,
            [PUBKEY_A, 100, 'anchor_bundle', '10.00000000', 100, true, null, 0]);
        assert.ok(indexer.indexerDb.reconcileAnchorRewardWinner.calledOnceWith(100, 'anchor_bundle'));
    });

    it('at/above the derive-relocation gate the DOGE-side write is SKIPPED (relocated to BTC), bundle still valid', async function () {
        deriveGateStub.returns(true);                                   // derive relocated to the BTC indexer
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({ sections: THREE_CHAINS }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');                    // attestation verification unaffected
        assert.strictEqual(data['PUBLISHER'], PUBKEY_A);
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled, 'DOGE no longer writes the reward at/above the gate');
        assert.ok(indexer.indexerDb.reconcileAnchorRewardWinner.notCalled);
        assert.strictEqual(writtenRows().length, 3);                    // the sections are still recorded
    });

    it('v0 keeps the bundle valid but SKIPS the reward when PUBLISHER is not in the oracle_publish set', async function () {
        // Snapshot = {A}; attestation quorum from A is valid, but the named PUBLISHER is B.
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({ publisher: PUBKEY_B }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');                 // the anchor still lands
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled); // reward denied
    });

    it('v0 keeps the bundle valid but SKIPS the reward when the attestation quorum is short', async function () {
        // Snapshot = {A}; the only attestation sig is from B (not in the set) -> 0 valid attesters.
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({ attest: [[PUBKEY_B, SIG]] }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
    });

    it('v0 rejects a malformed PUBLISHER', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({ publisher: 'nothex' }), data, null);
        assert.ok(String(data['STATUS']).startsWith('invalid: PUBLISHER format'));
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
    });
});

describe('Anchor (ANCHOR) @regression @tier3', function () {
    beforeEach(function () {
        ({ indexer, handler, verifyStub, swqStub, deriveGateStub } = armAnchor());
    });
    afterEach(function () {
        disarmAnchor({ verifyStub, swqStub, deriveGateStub });
    });

    it('bundle reward (XANCPUB) canonical: six positional fields with snapshot_block at index 3', function () {
        // The layout keeps SIX fields, round_reference repeated as the snapshot block,
        // so slash.js's XANCPUB branch (index 3) judges a bundle equivocation with no third
        // case. A five-field draft would have made every bundle equivocation read
        // 'invalid: snapshot_block'.
        let d = { FORMAT: 0, NETWORK: 'regtest', SNAPSHOT_BLOCK: 100, PUBLISHER: PUBKEY_A };
        let raw = ['XANCPUB', 'anchor_bundle', '100', '100', PUBKEY_A, '10.00000000'].join('|');
        let expected = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, 'XANCPUB|bundle|regtest|100', 0, raw);
        assert.strictEqual(handler.rewardCanonical(d), expected);
        // The content slash.js reads sits after the '||' separator; field 3 is the block.
        assert.strictEqual(expected.split('||')[1].split('|')[3], '100');
    });

    it('determinism: two independent parses of identical v0 bytes derive the identical reward row', async function () {
        let h2 = new Anchor(indexer);
        let d1 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        let d2 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({ sections: THREE_CHAINS }), d1, null);
        let firstArgs = indexer.indexerDb.createValidatorReward.lastCall.args;
        await h2.parse(v0Params({ sections: THREE_CHAINS }), d2, null);
        let secondArgs = indexer.indexerDb.createValidatorReward.lastCall.args;
        assert.deepStrictEqual(firstArgs, secondArgs);
    });

    // ── v1: the archive head, its publisher tail and anchor_archive reward derivation ──
    it('v1 with a valid publisher attestation is valid, stores the archive, and DERIVES the anchor_archive reward', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        await handler.parse(v1Params(ARCHIVE_JSON), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(data['PUBLISHER'], PUBKEY_A);
        assert.strictEqual(data['MATCH_BATCH_SEQ'], '0');
        assert.strictEqual(data['ARCHIVE_B64'], gz64(ARCHIVE_JSON));
        assert.ok(indexer.indexerDb.createValidatorReward.calledOnce);
        // (pubkeyHex, roundReference=MATCH_BATCH_SEQ, rewardType, amount, blockIndex, upsert,
        // deriveBlockIndex, roundQualifier) - frozen ARCHIVE amount, NOT wire. The archive leg
        // IS qualified: MATCH_BATCH_SEQ is a dense hub counter a wipe-and-replay rebase
        // reissues, so SNAPSHOT_BLOCK (100 here, the same height block_index carries) is what
        // keeps two genuinely distinct archive anchors from collapsing onto one reward row.
        assert.deepStrictEqual(indexer.indexerDb.createValidatorReward.firstCall.args,
            [PUBKEY_A, 0, 'anchor_archive', '10.00000000', 100, true, null, 100]);
        assert.ok(indexer.indexerDb.reconcileAnchorRewardWinner.calledOnceWith(0, 'anchor_archive'));
    });

    it('v1 wrapper sigs verify over the archive canonical (batch-extended, EQUIV-wrapped)', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        await handler.parse(v1Params(ARCHIVE_JSON), data, null);
        let raw = ['XCHECKPOINT', 'BTC', 'regtest', '500', HASH('0'), HASH('1'), HASH('2'), HASH('3'), '0', '100'].join('|') +
                  '|0|1|' + crc32Hex(ARCHIVE_JSON) + '|1';
        let expected = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, 'BTC|regtest|500|0|0', 0, raw);
        assert.strictEqual(verifyStub.firstCall.args[0], expected);
    });
});

describe('Anchor (ANCHOR) @regression @tier3', function () {
    beforeEach(function () {
        ({ indexer, handler, verifyStub, swqStub, deriveGateStub } = armAnchor());
    });
    afterEach(function () {
        disarmAnchor({ verifyStub, swqStub, deriveGateStub });
    });

    // ARCHIVE_REWARD gates reward derivation ONLY, never the wire shape: v1 IS the
    // archive head, so rejecting a publisher-bearing head on that flag day would reject
    // every archive anchor on a network whose height has not been reached.
    it('v1 parses on its own shape, not on the ARCHIVE_REWARD flag-day', async function () {
        let arStub = sinon.stub(require('../../../../src/anchor_reward_activation.js'),
            'isArchiveRewardActive').returns(false);
        try {
            let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
            await handler.parse(v1Params(ARCHIVE_JSON), data, null);
            assert.strictEqual(data['STATUS'], 'valid',
                'the v1-below-flag-day wire-shape rejection is deleted; the flag day is not a parser rule');
        } finally { arStub.restore(); }
        assert.ok(!/before ARCHIVE_REWARD flag-day/.test(
            require('fs').readFileSync(require('path').resolve(__dirname, '../../../../src/actions/anchor/index.js'), 'utf8')),
            'the deleted rejection must not come back');
    });

    // The degraded archive round. The hub emits a v1 whose tail carries
    // ATTEST_SIG_COUNT 0 when the attestation quorum was unreachable; a degraded round
    // must cost the federation its reward, never its checkpoint.
    it('v1 with ATTEST_SIG_COUNT 0 is valid, stores NULL attestations and derives NO reward', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        await handler.parse(v1Params(ARCHIVE_JSON, { attest: [] }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(data['PUBLISHER'], PUBKEY_A, 'the PUBLISHER pubkey still rides the tail');
        assert.strictEqual(data['PUBLISHER_ATTESTATIONS'], null,
            'a count-0 tail carries no signatures, so the column stores NULL rather than an empty list');
        assert.strictEqual(lastWrite()['PUBLISHER_ATTESTATIONS'], null);
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled,
            'no attestation means no quorum means no anchor_archive reward');
        assert.ok(indexer.indexerDb.reconcileAnchorRewardWinner.notCalled);
    });

    it('v1 still rejects a NEGATIVE ATTEST_SIG_COUNT: 0 is degraded, -1 is malformed', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        let p = v1Params(ARCHIVE_JSON, { attest: [] });
        p[p.length - 1] = '-1';
        await handler.parse(p, data, null);
        assert.strictEqual(data['STATUS'], 'invalid: ATTEST_SIG_COUNT');
    });

    it('v1 without any tail at all fails on PUBLISHER, not as a tail-less legacy shape', async function () {
        // The tail-less wire is RETIRED: a v1 that stops after its wrapper signature list
        // has no shape to fall back to, so it must fail on the missing PUBLISHER rather
        // than parse as something older.
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        let p = v1Params(ARCHIVE_JSON);
        p = p.slice(0, p.length - 4);   // drop PUBLISHER, ATTEST_SIG_COUNT and the one pair
        await handler.parse(p, data, null);
        assert.strictEqual(data['STATUS'], 'invalid: PUBLISHER format');
    });
});

describe('Anchor (ANCHOR) @regression @tier3', function () {
    beforeEach(function () {
        ({ indexer, handler, verifyStub, swqStub, deriveGateStub } = armAnchor());
    });
    afterEach(function () {
        disarmAnchor({ verifyStub, swqStub, deriveGateStub });
    });

    it('v1 keeps the anchor valid but SKIPS the reward when PUBLISHER is not in the oracle_publish set', async function () {
        // Snapshot = {A}; attestation quorum from A is valid, but the named PUBLISHER is B.
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        await handler.parse(v1Params(ARCHIVE_JSON, { publisher: PUBKEY_B }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
    });

    it('v1 keeps the anchor valid but SKIPS the reward when the attestation quorum is short', async function () {
        // Snapshot = {A}; the only attestation sig is from B (not in the set) -> 0 valid attesters.
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        await handler.parse(v1Params(ARCHIVE_JSON, { attest: [[PUBKEY_B, SIG]] }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
    });

    it('v1 rejects a CRC mismatch (archive integrity unchanged)', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        await handler.parse(v1Params(ARCHIVE_JSON, { crc: 'deadbeef' }), data, null);
        assert.ok(String(data['STATUS']).startsWith('invalid: BATCH_CRC32'));
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
    });

    it('v1 archive reward (XANCPUB) canonical: XANCPUB|anchor_archive|batch|snapshot|publisher|amount with the archive round-id family', function () {
        let d = {
            FORMAT: 1, CHAIN: 'BTC', NETWORK: 'regtest', CHECKPOINT_SEQ: 0, SNAPSHOT_BLOCK: 100,
            MATCH_BATCH_SEQ: 3, PUBLISHER: PUBKEY_A
        };
        let raw = ['XANCPUB', 'anchor_archive', '3', '100', PUBKEY_A, '10.00000000'].join('|');
        let expected = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, 'XANCPUB|archive|regtest|3|100', 0, raw);
        assert.strictEqual(handler.rewardCanonical(d), expected);
    });
});
