/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/unit/anchor_proof_client.test.js
 *
 * DOGE anchor visibility for the BTC-side reward derivation.
 *
 * The reward this proof guards is COLLECT-spendable and is minted on BTC from a
 * hub-mirrored row, so the binding rule matters twice over: it must accept ONLY an anchor
 * that is this reward's anchor, and it must keep "cannot tell" strictly apart from "no".
 * Conflating the two is what forks the ledger: a node that skipped an unprovable reward
 * would commit a different set than a peer that proved it, at a height they both agree on.
 * These cases drive the pure binding half (judge) plus the txid/wiring guards; the HTTP
 * half is exercised on regtest.
 ********************************************************************/

'use strict';

const assert = require('assert');
const AnchorProofClient = require('../../src/consensus/anchor_proof_client.js');

const TXID = 'b'.repeat(64);

// A getanchorconfirmations anchor entry for the reward tuple used throughout: the v1
// archive head, whose round term is MATCH_BATCH_SEQ. The two live families are the
// archive head {1} and the bundle section {0}; the per-chain family retired with its
// wires, so no anchor of any live version proves an 'anchor_<CHAIN>' reward.
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
    describe('_judge: binding an on-chain anchor to the reward tuple', function () {
        it('verifies a buried, tuple-matching v1 archive head on its match_batch_seq', function () {
        assert.strictEqual(client().judge([anchor()], expectation()), 'verified');
        });

        it('verifies the v0 bundle leg against an anchor_bundle reward on its snapshot block', function () {
        const a = anchor({ version: 0, match_batch_seq: null, checkpoint_seq: 900 });
        const e = expectation({ rewardType: 'anchor_bundle', roundReference: 900 });
        assert.strictEqual(client().judge([a], e), 'verified');
        });

        it('rejects a v0 bundle section offered as proof of an ARCHIVE reward', function () {
        const a = anchor({ version: 0, match_batch_seq: null });
        assert.strictEqual(client().judge([a], expectation()), 'rejected');
        });

        it('rejects a v1 archive head offered as proof of a BUNDLE reward', function () {
        const e = expectation({ rewardType: 'anchor_bundle', roundReference: 900 });
        assert.strictEqual(client().judge([anchor()], e), 'rejected');
        });

        it('rejects an anchor crediting a different publisher', function () {
        assert.strictEqual(client().judge([anchor({ publisher: 'cc'.repeat(32) })], expectation()), 'rejected');
        });

        it('rejects an anchor for a different round', function () {
        // The archive family's round term is match_batch_seq, never the wrapper's seq.
        assert.strictEqual(client().judge([anchor({ match_batch_seq: 13 })], expectation()), 'rejected');
        assert.strictEqual(client().judge([anchor({ checkpoint_seq: 8 })], expectation()), 'verified',
        'a different wrapper checkpoint_seq is not a different archive round');
        });

        it('rejects an anchor whose snapshot_block differs (a different signing set)', function () {
        assert.strictEqual(client().judge([anchor({ snapshot_block: 901 })], expectation()), 'rejected');
        });

        it('rejects an anchor for a different network', function () {
        assert.strictEqual(client().judge([anchor({ checkpoint_network: 'testnet' })], expectation()), 'rejected');
        });

        // Neither live family binds a chain, so there is no chain term left to gate on. The
        // archive XANCPUB canonical keys on MATCH_BATCH_SEQ and its head carries whatever
        // checkpoint wrapped it; a bundle is ONE action over every chain under one reward.
        it('binds no chain on either live family', function () {
        const c = client();
        const head = anchor({ checkpoint_chain: 'LTC' });
        assert.strictEqual(c.judge([head], expectation()), 'verified',
        'an archive head wrapping another chain\'s checkpoint still proves its own reward');
        const sect = anchor({ version: 0, checkpoint_chain: 'DOGE', match_batch_seq: null, checkpoint_seq: 900 });
        assert.strictEqual(c.judge([sect], expectation({ rewardType: 'anchor_bundle', roundReference: 900 })),
        'verified', 'a bundle section proves the one bundle reward whichever chain it names');
        });
        });
});

describe('AnchorProofClient (DOGE anchor visibility) @regression @tier2', () => {
    describe('_judge: binding an on-chain anchor to the reward tuple', function () {
        // The per-chain family retired with its wires. reward_type is inside the XANCPUB
        // canonical the caller re-verifies, so every node reads the same retired name off the
        // same signed bytes and reaches the same permanent verdict. Falling back to a family
        // would let a live anchor stand in for a reward no live wire can carry.
        it('permanently rejects a reward_type naming no live family', function () {
        const c = client();
        for (const rewardType of ['anchor_BTC', 'anchor_btc', 'anchor_LTC', 'anchor_DOGE', 'anchor_nonsense'])
        assert.strictEqual(c.judge([anchor(), anchor({ version: 0, match_batch_seq: null })],
        expectation({ rewardType })), 'rejected', rewardType);
        });

        it('rejects a retired reward_type even on a transaction carrying no anchors at all', function () {
        assert.strictEqual(client().judge([], expectation({ rewardType: 'anchor_BTC' })), 'rejected',
        'the verdict comes off the signed reward_type alone, so it never depends on the page');
        });

        it('rejects a decoded-invalid anchor (it never anchored anything)', function () {
        assert.strictEqual(client().judge([anchor({ status: 'invalid: bad sigs' })], expectation()), 'rejected');
        });

        // The reject verdict is memoized as PERMANENT, and its whole licence to be so is
        // that every honest DOGE node computes the status identically. Three statuses break
        // that, and they break it in opposite directions on the SAME anchor: a DOGE node
        // that mirrors the oracle_publish snapshot writes 'invalid: insufficient ...' where
        // an unmirrored one writes 'unverified', and 'invalid_archive' is stamped only by a
        // node holding the archive chunks. Reading any of them as a positive reject let two
        // BTC nodes with different DOGE_INDEXER_URLs decide one reward tuple oppositely,
        // forever: a derived-reward-set fork on the COLLECT rail. They are evidence of
        // nothing, so the verdict falls through to the node-class-independent fields.
        it('does not reject on a signature-verdict status, which is node-class-dependent', function () {
        const c = client();
        assert.strictEqual(c.judge([anchor({ status: 'invalid: insufficient valid signatures (1/3)' })],
        expectation()), 'verified');
        assert.strictEqual(c.judge([anchor({ status: 'invalid: insufficient signer stake' })],
        expectation()), 'verified');
        });

        it('does not reject on invalid_archive, which only a chunk-holding node can stamp', function () {
        assert.strictEqual(client().judge([anchor({ status: 'invalid_archive' })], expectation()), 'verified');
        });

        it('still treats unverified as non-evidence, matching the two statuses above', function () {
        assert.strictEqual(client().judge([anchor({ status: 'unverified' })], expectation()), 'verified');
        });

        it('keeps rejecting the deterministic invalid reasons a node computes from the wire', function () {
        const c = client();
        for(const status of ['invalid: BATCH_CRC32 (archive mismatch)',
        'invalid: CHECKPOINT_SEQ (stale; replay of an older checkpoint)',
        'invalid: STATE_ROOT (format)',
        'invalid: VERSION (unknown)'])
        assert.strictEqual(c.judge([anchor({ status })], expectation()), 'rejected', status);
        });
        });
});

describe('AnchorProofClient (DOGE anchor visibility) @regression @tier2', () => {
    describe('_judge: binding an on-chain anchor to the reward tuple', function () {
        // Depth is the one failure that self-heals, so it must never be terminal: the anchor
        // WILL bury. Treating it as a reject would forfeit a legitimate reward permanently.
        it('returns unknown for a tuple-matching anchor that is not yet buried deep enough', function () {
        assert.strictEqual(client().judge([anchor({ confirmations: 59 })], expectation()), 'unknown');
        });

        // A transaction carrying only unattested versions tells us nothing about this reward:
        // we cannot distinguish a forge from a row we simply cannot read, so we must defer.
        it('returns unknown when the txid carries no attestation-bearing anchor at all', function () {
        // v2 is the archive continuation chunk: it carries no publisher tail, so it is
        // not evidence either way. The pre-restart versions do NOT read the same any
        // more: treating them as unreadable is what halted BTC testnet at 150455 forever
        // (a pre-restart-attested reward maturing after the restart could never be
        // proven). They are attestation-bearing rows every node can read, so they are
        // evidence - proving their own family (6 archive, 7 bundle) and deterministically
        // rejecting outside it (4/5, the retired per-chain wires, prove nothing).
        const c = client();
        assert.strictEqual(c.judge([anchor({ version: 2, publisher: null })], expectation()), 'unknown');
        });

        // The pre-restart era, in one place. The version restart renumbered the archive head
        // 6 -> 1 and the bundle 7 -> 0 (anchor.js dispatch), so a pre-restart anchor row
        // keeps its legacy wire byte while naming the same shape. A reward attested before
        // the restart but maturing after it (BTC testnet 150456) must prove against that
        // byte; the family exclusivity holds across eras; and the retired per-chain wires
        // reject deterministically instead of deferring the block forever.
        it('verifies a buried, tuple-matching pre-restart v6 archive head (the 150456 shape)', function () {
        assert.strictEqual(client().judge([anchor({ version: 6 })], expectation()), 'verified');
        });

        it('verifies a buried pre-restart v7 bundle against its anchor_bundle reward', function () {
        const a = anchor({ version: 7, match_batch_seq: null, checkpoint_seq: 900 });
        const e = expectation({ rewardType: 'anchor_bundle', roundReference: 900 });
        assert.strictEqual(client().judge([a], e), 'verified');
        });

        it('keeps the family exclusive across eras: v6 proves no bundle, v7 proves no archive', function () {
        const c = client();
        const e = expectation({ rewardType: 'anchor_bundle', roundReference: 900 });
        assert.strictEqual(c.judge([anchor({ version: 6 })], e), 'rejected');
        assert.strictEqual(c.judge([anchor({ version: 7, match_batch_seq: null })], expectation()), 'rejected');
        });

        it('rejects (never defers on) a txid carrying only retired per-chain v4/v5 anchors', function () {
        const c = client();
        for (const version of [4, 5])
        assert.strictEqual(c.judge([anchor({ version })], expectation()), 'rejected', 'v' + version);
        });

        it('drops a post-activation forgery on a legacy byte via its wire-determined status', function () {
        // At/above ANCHOR_ACTIVATION a legacy byte parses 'invalid: VERSION (unknown)',
        // chain data every DOGE node computes identically, so the row is not evidence
        // and the mis-bind resolves 'rejected' rather than minting or deferring.
        const a = anchor({ version: 6, status: 'invalid: VERSION (unknown)' });
        assert.strictEqual(client().judge([a], expectation()), 'rejected');
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

    describe('_judge: binding an on-chain anchor to the reward tuple', function () {
    it('picks the matching anchor when a transaction carries several', function () {
    const rows = [anchor({ version: 2, publisher: null }), anchor()];
    assert.strictEqual(client().judge(rows, expectation()), 'verified');
    });
    });
});