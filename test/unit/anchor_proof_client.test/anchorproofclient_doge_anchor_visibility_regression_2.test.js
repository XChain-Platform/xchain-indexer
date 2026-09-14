/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/anchor_proof_client.test/anchorproofclient_doge_anchor_visibility_regression_2.test.js
 *
 * Sibling block of the anchor_proof_client.test.js suite, carrying:
 *   AnchorProofClient (DOGE anchor visibility) @regression @tier2
 *
 * Each block repeats its parent describe title, so the full test titles this
 * file collects are the ones the entry collected before the split.
 */
'use strict';

const assert = require('assert');
const AnchorProofClient = require('../../../src/consensus/doge_peer_clients/anchor_proof_client.js');

const TXID = 'b'.repeat(64);





function anchor(overrides) {
    return Object.assign({
        status: 'valid', version: 1,
        checkpoint_chain: 'BTC', checkpoint_network: 'regtest',
        block_index: 500, checkpoint_seq: 99, snapshot_block: 900,
        publisher: 'aa'.repeat(32), match_batch_seq: 12,
        block_index_doge: 100, confirmations: 60
    }, overrides || {});
}

function expectation(overrides) {
    return Object.assign({
        txid: TXID, rewardType: 'anchor_archive', roundReference: 12,
        snapshotBlock: 900, publisher: 'aa'.repeat(32),
        network: 'regtest', minConfirmations: 60
    }, overrides || {});
}

function client() { return new AnchorProofClient({ COIN: 'BTC', NETWORK: 'regtest' }, { url: 'http://doge.invalid/' }); };

function sibling() { return anchor({ match_batch_seq: 999 }); }

const SNAP = 150208;

function section(overrides) {
return Object.assign({
status: 'valid', version: 0,
checkpoint_chain: 'BTC', checkpoint_network: 'regtest',
block_index: 150208, checkpoint_seq: SNAP, snapshot_block: SNAP,
publisher: 'aa'.repeat(32), match_batch_seq: null,
block_index_doge: 100, confirmations: 60
}, overrides || {});
}

function bundle(overrides) {
return [section(Object.assign({ checkpoint_chain: 'BTC'  }, overrides || {})),
section(Object.assign({ checkpoint_chain: 'DOGE' }, overrides || {})),
section(Object.assign({ checkpoint_chain: 'LTC'  }, overrides || {}))];
}

function bundleReward(overrides) {
return expectation(Object.assign({
rewardType: 'anchor_bundle', roundReference: SNAP, snapshotBlock: SNAP
}, overrides || {}));
}

function ownBundle() {
return bundle().map((s, i) => Object.assign(s, { action_index: 41, section_index: i }));
}

describe('AnchorProofClient (DOGE anchor visibility) @regression @tier2', () => {
    describe('_judge: the v0 bundle leg', function () {
        it('verifies a buried v0 bundle against its one anchor_bundle reward', function () {
        assert.strictEqual(client().judge(bundle(), bundleReward()), 'verified');
        });

        // The whole point of the family: no section's chain is compared to anything. Slicing
        // the chain out of 'anchor_bundle' yields the literal 'BUNDLE', which no section can
        // ever equal, so a chain-named binding cannot prove this reward at all.
        it('binds the bundle reward to no chain, whichever section leads the wire', function () {
        const c = client();
        for (const first of ['LTC', 'DOGE', 'BTC'])
        assert.strictEqual(c.judge([section({ checkpoint_chain: first })], bundleReward()),
        'verified', first);
        });

        // A bundle is proven at the block the reward names. A bundle at a different snapshot
        // block is a positively-detected mis-bind: chain data, identical on every honest node,
        // so it is the permanent 'rejected' the rest of this file gives that case. Degrading it
        // to 'unknown' would raise AnchorProofUnavailableError on every retry and wedge the
        // block loop forever, which is the failure this leg exists to remove.
        it('refuses a v0 bundle whose snapshot block is not the reward round', function () {
        const c = client();
        assert.strictEqual(c.judge(bundle({ snapshot_block: SNAP - 6, checkpoint_seq: SNAP - 6 }),
        bundleReward()), 'rejected');
        assert.strictEqual(c.judge(bundle(), bundleReward({ roundReference: SNAP - 6 })), 'rejected');
        });

        // A lagging chain rides the bundle at its OWN older snapshot block, and the parser proves
        // the header block is the maximum over the sections, so the maximum over the section rows
        // reconstructs the header the reward is keyed on. The lagging section must not be able to
        // prove a reward at its own block: no such reward was ever attested or earned.
        it('verifies a bundle carrying a lagging section, and only at the header block', function () {
        const rows = [section({ checkpoint_chain: 'BTC' }),
        section({ checkpoint_chain: 'LTC', snapshot_block: SNAP - 6, checkpoint_seq: SNAP - 6 })];
        assert.strictEqual(client().judge(rows, bundleReward()), 'verified');
        assert.strictEqual(client().judge(rows, bundleReward({ roundReference: SNAP - 6, snapshotBlock: SNAP - 6 })),
        'rejected');
        });

        // CHECKPOINT_SEQ and SECTION_SNAPSHOT_BLOCK are separate wire fields on a section, and
        // the bundle reward is keyed on the snapshot block alone. A section's own seq is
        // per-chain checkpoint identity, covered by that section's own signatures; it is no
        // part of the one reward, so the round term must never read it. Binding to it instead
        // would tie the whole bundle to whichever chain led the wire.
        it('binds the bundle round to the snapshot block, never to a section checkpoint_seq', function () {
        assert.strictEqual(client().judge(bundle({ checkpoint_seq: SNAP - 3 }), bundleReward()), 'verified');
        });

        it('refuses a v0 bundle crediting a different publisher', function () {
        assert.strictEqual(client().judge(bundle({ publisher: 'cc'.repeat(32) }), bundleReward()), 'rejected');
        });

        it('refuses a v0 bundle anchored for a different network', function () {
        assert.strictEqual(client().judge(bundle({ checkpoint_network: 'testnet' }), bundleReward()), 'rejected');
        });
        });
});

describe('AnchorProofClient (DOGE anchor visibility) @regression @tier2', () => {
    describe('_judge: the v0 bundle leg', function () {
        // Depth is the one failure that self-heals, so a matching but shallow bundle defers.
        it('returns unknown for a matching bundle that is not yet buried deep enough', function () {
        assert.strictEqual(client().judge(bundle({ confirmations: 59 }), bundleReward()), 'unknown');
        });

        // A bundle section can never stand in for a retired per-chain reward: it shares the
        // publisher, network, snapshot block, seq and even the chain of the anchor_<CHAIN>
        // reward of the same round, and now the reward_type names no live family at all.
        it('refuses a v0 section as proof of a retired per-chain reward', function () {
        assert.strictEqual(client().judge([section()],
        expectation({ rewardType: 'anchor_BTC', roundReference: SNAP, snapshotBlock: SNAP })),
        'rejected');
        });

        it('refuses a v1 archive head as proof of a bundle reward', function () {
        const a = anchor({ version: 1, checkpoint_seq: SNAP, snapshot_block: SNAP, match_batch_seq: SNAP });
        assert.strictEqual(client().judge([a], bundleReward()), 'rejected');
        });

        // Pre-restart anchors are attested rows every node can read, so they are evidence:
        // the bundle's own pre-restart byte (7) proves its reward, and the rest of the
        // legacy set resolves 'rejected' deterministically instead of deferring the block
        // forever (the BTC testnet 150455 halt).
        it('judges a pre-restart anchor offered as proof of a bundle reward', function () {
        const c = client();
        for (const version of [4, 5, 6])
        assert.strictEqual(c.judge([anchor({ version, checkpoint_seq: SNAP, snapshot_block: SNAP })],
        bundleReward()), 'rejected', 'v' + version);
        assert.strictEqual(c.judge([anchor({ version: 7, checkpoint_seq: SNAP, snapshot_block: SNAP })],
        bundleReward()), 'verified', 'v7 is the bundle\'s own pre-restart byte');
        });

        // "Cannot tell" must stay apart from "no". A transaction carrying only unattested rows
        // (an archive continuation chunk, say) is no evidence either way, so the block defers
        // and the reward is re-asked rather than forfeited.
        it('returns unknown when the txid carries no attestation-bearing anchor at all', function () {
        const chunk = section({ version: 2, publisher: null, snapshot_block: null, checkpoint_seq: null });
        assert.strictEqual(client().judge([chunk], bundleReward()), 'unknown');
        });

        // The live shape: an archive head sharing the transaction with the bundle. Each reward
        // is proven from its own leg and neither leg can answer for the other.
        it('judges a bundle and an unrelated archive head sharing one transaction', function () {
        const archiveHead = anchor({ version: 1, checkpoint_chain: 'DOGE', checkpoint_seq: 99,
        snapshot_block: SNAP, match_batch_seq: 12 });
        const rows = bundle().concat([archiveHead]);
        assert.strictEqual(client().judge(rows, bundleReward()), 'verified');
        assert.strictEqual(client().judge(rows, expectation({ rewardType: 'anchor_archive',
        roundReference: 12, snapshotBlock: SNAP })),
        'verified');
        // The archive head is the only v1 present, so a bundle reward at ITS batch seq is
        // still a mis-bind rather than an accidental match.
        assert.strictEqual(client().judge(rows, bundleReward({ roundReference: 12, snapshotBlock: 12 })),
        'rejected');
        });
        });
});

describe('AnchorProofClient (DOGE anchor visibility) @regression @tier2', () => {
    function sibling() { return anchor({ match_batch_seq: 999 }); }
    const SNAP = 150208;
    function section(overrides) {
    return Object.assign({
    status: 'valid', version: 0,
    checkpoint_chain: 'BTC', checkpoint_network: 'regtest',
    block_index: 150208, checkpoint_seq: SNAP, snapshot_block: SNAP,
    publisher: 'aa'.repeat(32), match_batch_seq: null,
    block_index_doge: 100, confirmations: 60
    }, overrides || {});
    }
    function bundle(overrides) {
    return [section(Object.assign({ checkpoint_chain: 'BTC'  }, overrides || {})),
    section(Object.assign({ checkpoint_chain: 'DOGE' }, overrides || {})),
    section(Object.assign({ checkpoint_chain: 'LTC'  }, overrides || {}))];
    }
    function bundleReward(overrides) {
    return expectation(Object.assign({
    rewardType: 'anchor_bundle', roundReference: SNAP, snapshotBlock: SNAP
    }, overrides || {}));
    }
    function ownBundle() {
    return bundle().map((s, i) => Object.assign(s, { action_index: 41, section_index: i }));
    }

    describe('_judge: the v0 bundle leg', function () {
    // The bundle stamps ONE status across its section rows, and a node holding no mirrored
    // oracle_publish snapshot for any section stamps the whole bundle 'unverified'. So the
    // section-quorum verdict divides the fleet exactly as the per-chain spelling does, and
    // reading it as a positive reject would let two BTC nodes decide one reward oppositely
    // and forever, by which DOGE indexer each happens to read.
    it('treats the section-quorum verdict as node-class evidence, not a reject', function () {
    const c = client();
    for (const status of ['invalid: SECTION 0 insufficient valid signatures (1/3)',
    'invalid: SECTION 2 insufficient signer stake',
    'unverified'])
    assert.strictEqual(c.judge(bundle({ status }), bundleReward()), 'verified', status);
    });

    it('keeps rejecting the v0 verdicts a node computes from the wire alone', function () {
    const c = client();
    for (const status of ['invalid: SECTION 1 CHECKPOINT_SEQ (stale; replay of an older checkpoint)',
    'invalid: SECTION 0 CHAIN (duplicate)',
    'invalid: SNAPSHOT_BLOCK (not the section maximum)'])
    assert.strictEqual(c.judge(bundle({ status }), bundleReward()), 'rejected', status);
    });

    // End to end over the real transport shape: one page, three version-0 sections, the
    // verdict memoized per tuple.
    it('proves the live three-section bundle through proveMined', async function () {
    const c = client();
    let calls = 0;
    c.fetch = async () => { calls++; return { exists: true, anchors: bundle(), truncated: false }; };
    assert.strictEqual(await c.proveMined(bundleReward()), 'verified');
    assert.strictEqual(await c.proveMined(bundleReward()), 'verified');
    assert.strictEqual(calls, 1);
    });
    });
});
// One section row of a three-chain bundle, in the shape the DOGE indexer serves.

// The one reward the bundle earns. round_reference IS the snapshot block.

// The v0 checkpoint bundle: ONE anchor action carrying every checkpointed chain as a

// 'anchor_bundle' keyed on the bundle's SNAPSHOT_BLOCK. So the reward is bound to the

// sections carry the reward's snapshot block, not matching a chain name.

// Each section becomes its own anchor_actions row, so getanchorconfirmations answers a

// carrying its own chain, block_index, checkpoint_seq and snapshot_block.

// recorded and are never re-derived, so what this proof client owes them is a

// waiting for an anchor no live wire can ever carry.
