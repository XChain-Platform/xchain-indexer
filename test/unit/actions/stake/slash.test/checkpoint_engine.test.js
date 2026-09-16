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
// SLASH action handler: the CHECKPOINT engine tag and its two content
// families, XCHECKPOINT and XANCPUB, with the slot positions bound to the
// indexer's own canonical builders.
// Part of the SLASH suite; see ../slash.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const eq    = require('../../../../../src/equivocation_header.js');
const { buried, params, data, useSlashHarness } = require('./helpers/slash_harness.js');

// Each test gets a fresh harness from useSlashHarness; bind() hands it to the
// names the test bodies use.
let indexer, handler, offender;
const bind = (h) => { ({ indexer, handler, offender } = h); };

// ── CHECKPOINT engine tag: two content families ──
// XCHECKPOINT (root canonical, snapshot_block at index 9) and XANCPUB (reward
// attestation, snapshot_block at index 3) share the CHECKPOINT engine tag.

// Realistic XCHECKPOINT raw canonical, in the root-bearing shape an ANCHOR v0 section
// carries; snapshot_block is field index 9, ahead of the root suffix.
function checkpointContent(snap, ledgerHash) {
    return ['XCHECKPOINT', 'BTC', 'regtest', '199', 'aa'.repeat(32), ledgerHash,
            'cc'.repeat(32), 'dd'.repeat(32), '5', String(snap),
            'ee'.repeat(32), '1', 'ff'.repeat(32), '1'].join('|');
}
// XANCPUB reward-attestation canonical (per-chain leg); snapshot_block is field index 3.
function ancpubContent(snap, publisher) {
    return ['XANCPUB', 'anchor_BTC', '5', String(snap), publisher, '50'].join('|');
}
const CP_ROUND = 'cp_5';

describe('SLASH action handler: equivocation verifier @regression', function () {
    useSlashHarness(bind);

    it('ACCEPTS an XCHECKPOINT equivocation (snapshot_block at index 9)', async function () {
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, CP_ROUND, 0, checkpointContent(100, 'e1'.repeat(32)));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, CP_ROUND, 0, checkpointContent(100, 'e2'.repeat(32)));
        const d = data();
        await handler.parse(params('oracle_publish', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args, ['oracle_publish', buried(100)]);
        assert.ok(indexer.indexerDb.slashCapabilityStake.calledOnce);
    });

    it('ACCEPTS an XANCPUB equivocation (snapshot_block at index 3)', async function () {
        // Same round, two different attested publishers = a reward-attestation double-sign.
        const round = 'XANCPUB|BTC|regtest|5|100';
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, round, 0, ancpubContent(100, 'aaaa'.repeat(16)));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, round, 0, ancpubContent(100, 'bbbb'.repeat(16)));
        const d = data();
        await handler.parse(params('oracle_publish', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args, ['oracle_publish', buried(100)]);
        assert.ok(indexer.indexerDb.slashCapabilityStake.calledOnce);
    });

    it('ACCEPTS an archive-leg XANCPUB equivocation (anchor_archive scope)', async function () {
        const round = 'XANCPUB|archive|regtest|7|100';
        const base  = (pub) => ['XANCPUB', 'anchor_archive', '7', '100', pub, '50'].join('|');
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, round, 0, base('aaaa'.repeat(16)));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, round, 0, base('bbbb'.repeat(16)));
        const d = data();
        await handler.parse(params('oracle_publish', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args, ['oracle_publish', buried(100)]);
    });
});

describe('SLASH action handler: equivocation verifier @regression', function () {
    useSlashHarness(bind);

    it('ACCEPTS a bundle-leg XANCPUB equivocation (anchor_bundle scope, ANCHOR v0)', async function () {
        // The bundle canonical repeats SNAPSHOT_BLOCK as its round_reference, keeping the
        // SIX positional fields so this branch finds the block at index 3 with no
        // third case in slash.js. Two attested publishers for one bundle round is a
        // reward-attestation double-sign exactly as on the per-chain and archive legs.
        const round = 'XANCPUB|bundle|regtest|100';
        const base  = (pub) => ['XANCPUB', 'anchor_bundle', '100', '100', pub, '50'].join('|');
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, round, 0, base('aaaa'.repeat(16)));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, round, 0, base('bbbb'.repeat(16)));
        const d = data();
        await handler.parse(params('oracle_publish', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args, ['oracle_publish', buried(100)]);
        assert.ok(indexer.indexerDb.slashCapabilityStake.calledOnce);
    });

    it('REJECTS an XANCPUB pair that disagrees on snapshot_block', async function () {
        const round = 'XANCPUB|BTC|regtest|5|100';
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, round, 0, ancpubContent(100, 'aaaa'.repeat(16)));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, round, 0, ancpubContent(101, 'aaaa'.repeat(16)));
        const d = data();
        await handler.parse(params('oracle_publish', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/snapshot_block/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS a mixed XCHECKPOINT/XANCPUB pair (content family mismatch)', async function () {
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, CP_ROUND, 0, checkpointContent(100, 'e1'.repeat(32)));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, CP_ROUND, 0, ancpubContent(100, 'aaaa'.repeat(16)));
        const d = data();
        await handler.parse(params('oracle_publish', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/family mismatch/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });
});

// ── the field indices come from a REAL builder, not from a hand-copied join ──
//
// resolveSlot hard-codes the in-content snapshot_block position per engine
// (CHECKPOINT 9, XANCPUB 3). slash.js is a SEVENTH consumer of the XCHECKPOINT
// layout and sits on no lockstep list and in no cross-service parity suite; the
// parity suites compare builders to builders, and every fixture above rebuilds
// the layout by hand, so a coordinated field insertion between CHAIN|NETWORK and
// SNAPSHOT_BLOCK keeps all of them green while resolveSlot starts reading
// CHECKPOINT_SEQ as the slot. That resolves the WRONG capability snapshot: real
// proofs get rejected, or a bond burns against the wrong height. And because
// deriveCheckpointSeq(snapshot_block) returns snapshot_block, an off-by-one-segment
// read looks plausible on live data while being structurally wrong.
//
// These two cases source the signed bytes from the indexer's OWN builder
// (Anchor.canonical / Anchor.rewardCanonical, the sibling of the hub's
// StateCheckpointEngine.canonicalCheckpoint), so a layout change in anchor.js
// moves the fixture and this file goes red rather than agreeing with itself.
// Called off the prototype with a bare receiver: neither builder touches `this`.
const Anchor = require('../../../../../src/actions/anchor/index.js');
const CP_SNAP = 100;
function builtCheckpoint(ledgerHash) {
    // FORMAT 0 = a bundle SECTION, the only checkpoint canonical the hub still signs.
    // The root suffix it appends sits AFTER segment 9, so the slot read is unmoved -
    // which is the point of pinning it against the real builder rather than a literal.
    return Anchor.prototype.canonical.call({}, {
        FORMAT: 0, CHAIN: 'BTC', NETWORK: 'regtest',
        BLOCK_INDEX_CHECKPOINTED: 199, BLOCK_HASH: 'aa'.repeat(32),
        LEDGER_HASH: ledgerHash, ACTIONS_HASH: 'cc'.repeat(32),
        CONTRACT_HASH: 'dd'.repeat(32), CHECKPOINT_SEQ: 5, SNAPSHOT_BLOCK: CP_SNAP,
        STATE_ROOT: 'ee'.repeat(32), STATE_ROOT_VERSION: 1,
        BLOCK_MERKLE_ROOT: 'ff'.repeat(32), BLOCK_MERKLE_VERSION: 1,
    });
}
function builtBundleAttestation(publisher) {
    return Anchor.prototype.rewardCanonical.call({}, {
        FORMAT: 0, NETWORK: 'regtest', SNAPSHOT_BLOCK: CP_SNAP, PUBLISHER: publisher,
    });
}
function builtArchiveAttestation(publisher) {
    return Anchor.prototype.rewardCanonical.call({}, {
        FORMAT: 1, CHAIN: 'BTC', NETWORK: 'regtest', MATCH_BATCH_SEQ: 7,
        SNAPSHOT_BLOCK: CP_SNAP, PUBLISHER: publisher, CHECKPOINT_SEQ: 5,
    });
}
const equivContent = (msg) => msg.slice(msg.indexOf('||') + 2);

describe('SLASH action handler: equivocation verifier @regression', function () {
    useSlashHarness(bind);

    it('resolves the CHECKPOINT slot from a canonical the real builder produced', async function () {
        const msgA = builtCheckpoint('e1'.repeat(32));
        const msgB = builtCheckpoint('e2'.repeat(32));
        // Pin the positional read itself, so a shift reports as a layout change rather
        // than as an opaque wrong-slot number further down.
        assert.strictEqual(equivContent(msgA).split('|')[9], String(CP_SNAP),
            'Anchor._canonical no longer carries SNAPSHOT_BLOCK at segment 9; slash._resolveSlot ' +
            'FIELD[CHECKPOINT] still says 9 and would resolve the wrong bond slot. Content was: ' +
            equivContent(msgA));

        const d = data();
        await handler.parse(params('oracle_publish', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args,
            ['oracle_publish', buried(CP_SNAP)],
            'the slot must be the builder-produced SNAPSHOT_BLOCK, not whatever sits at segment 9');
    });

    it('resolves the XANCPUB slot from a canonical the real builder produced', async function () {
        const msgA = builtArchiveAttestation('aaaa'.repeat(16));
        const msgB = builtArchiveAttestation('bbbb'.repeat(16));
        assert.strictEqual(equivContent(msgA).split('|')[3], String(CP_SNAP),
            'Anchor._rewardCanonical no longer carries SNAPSHOT_BLOCK at segment 3; slash._resolveSlot ' +
            'switches to index 3 on the XANCPUB family and would resolve the wrong bond slot. Content was: ' +
            equivContent(msgA));

        const d = data();
        await handler.parse(params('oracle_publish', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args,
            ['oracle_publish', buried(CP_SNAP)]);
    });
});

describe('SLASH action handler: equivocation verifier @regression', function () {
    useSlashHarness(bind);

    it('resolves the BUNDLE XANCPUB slot from a canonical the real builder produced', async function () {
        const msgA = builtBundleAttestation('aaaa'.repeat(16));
        const msgB = builtBundleAttestation('bbbb'.repeat(16));
        assert.strictEqual(equivContent(msgA).split('|')[3], String(CP_SNAP),
            'Anchor._rewardCanonical\'s v0 branch no longer carries SNAPSHOT_BLOCK at segment 3; ' +
            'slash._resolveSlot reads index 3 for every XANCPUB family and would resolve the wrong ' +
            'bond slot. Content was: ' + equivContent(msgA));
        assert.strictEqual(equivContent(msgA).split('|').length, 6,
            'the bundle canonical must keep SIX positional fields (D22): a five-field layout ' +
            'would make every bundle equivocation read as invalid: snapshot_block');

        const d = data();
        await handler.parse(params('oracle_publish', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args,
            ['oracle_publish', buried(CP_SNAP)],
            'slash.js needs NO third branch for the bundle: index 3 already finds its snapshot_block');
    });

    it('the hand-written checkpoint fixture still matches the real builder segment for segment', function () {
        // The fixtures above stay hand-written on purpose (they vary fields the builder
        // would not), so bind their SHAPE to the builder here: same segment count, same
        // snapshot_block position. Without this, a field insertion updates the builder
        // and leaves every hand-written fixture generating the stale ten-segment string.
        const built = equivContent(builtCheckpoint('e1'.repeat(32))).split('|');
        const hand  = checkpointContent(CP_SNAP, 'e1'.repeat(32)).split('|');
        assert.strictEqual(hand.length, built.length,
            `hand-written checkpointContent() has ${hand.length} segments, the builder emits ` +
            `${built.length}; the fixture is a stale copy of the canonical layout`);
        assert.strictEqual(hand.indexOf(String(CP_SNAP)), built.indexOf(String(CP_SNAP)),
            'hand-written fixture puts snapshot_block at a different segment than the builder');
    });
});
