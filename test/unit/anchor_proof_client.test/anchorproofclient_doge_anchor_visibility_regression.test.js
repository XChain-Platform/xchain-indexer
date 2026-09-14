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
 * test/unit/anchor_proof_client.test/anchorproofclient_doge_anchor_visibility_regression.test.js
 *
 * Sibling block of the anchor_proof_client.test.js suite, carrying:
 *   AnchorProofClient (DOGE anchor visibility) @regression @tier2
 *
 * Each block repeats its parent describe title, so the full test titles this
 * file collects are the ones the entry collected before the split.
 */
'use strict';

const assert = require('assert');
const AnchorProofClient = require('../../../src/consensus/anchor_proof_client.js');

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
    describe('proveMined guards', function () {
        it('rejects a row with no doge_anchor_txid (unprovable by shape, identically on every node)', async function () {
        assert.strictEqual(await client().proveMined(expectation({ txid: null })), 'rejected');
        });

        it('rejects a malformed txid without making a call', async function () {
        assert.strictEqual(await client().proveMined(expectation({ txid: 'nope' })), 'rejected');
        });

        // Fail CLOSED: an unconfigured node must defer, never pay for an anchor it cannot see.
        it('returns unknown (defer) when no DOGE indexer is wired', async function () {
        const c = new AnchorProofClient({ COIN: 'BTC', NETWORK: 'regtest' }, { url: '' });
        assert.strictEqual(c.configured(), false);
        assert.strictEqual(await c.proveMined(expectation()), 'unknown');
        });

        it('memoizes a decided verdict but never memoizes unknown', async function () {
        const c = client();
        let calls = 0;
        c.fetch = async () => { calls++; return { exists: true, anchors: [anchor()] }; };
        assert.strictEqual(await c.proveMined(expectation()), 'verified');
        assert.strictEqual(await c.proveMined(expectation()), 'verified');
        assert.strictEqual(calls, 1, 'a buried anchor is immutable chain data; re-asking is pure load');

        const c2 = client();
        let calls2 = 0;
        c2.fetch = async () => { calls2++; return { exists: true, anchors: [anchor({ confirmations: 1 })] }; };
        assert.strictEqual(await c2.proveMined(expectation()), 'unknown');
        assert.strictEqual(await c2.proveMined(expectation()), 'unknown');
        assert.strictEqual(calls2, 2, 'unknown is exactly the state expected to change, so it must be re-asked');
        });

        // The memo caches a TUPLE's verdict, not a txid's. One DOGE txid can be named by more
        // than one attestation row (a failover double-publish inserts one row per publisher,
        // and the per-chain and archive legs can share a transaction) and doge_anchor_txid is
        // not covered by the XANCPUB canonical, so a txid-only key let a 'verified' for one
        // tuple mint an unproven reward for another, and a 'rejected' suppress a legitimate one.
        it('does not leak a decided verdict to a different reward tuple on the same txid', async function () {
        const c = client();
        // The transaction carries ONLY the publisher-aa / seq-7 anchor.
        c.fetch = async () => ({ exists: true, anchors: [anchor()] });
        assert.strictEqual(await c.proveMined(expectation()), 'verified');
        // A different publisher's row naming the same txid is a positively-detected
        // mis-bind and must still be judged, not answered from the first row's memo.
        assert.strictEqual(
        await c.proveMined(expectation({ publisher: 'bb'.repeat(32) })), 'rejected');
        // Same shape the other way round: a rejected tuple must not poison the legitimate one.
        const c2 = client();
        c2.fetch = async () => ({ exists: true, anchors: [anchor()] });
        assert.strictEqual(await c2.proveMined(expectation({ roundReference: 8 })), 'rejected');
        assert.strictEqual(await c2.proveMined(expectation()), 'verified');
        });
        it('treats an unreachable DOGE indexer as unknown (defer), not as absent', async function () {
        const c = client();
        c.fetch = async () => null;
        assert.strictEqual(await c.proveMined(expectation()), 'unknown');
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

    describe('proveMined guards', function () {
    it('treats "no such transaction" as unknown: the DOGE indexer may simply be behind', async function () {
    const c = client();
    c.fetch = async () => ({ exists: false, anchors: [] });
    assert.strictEqual(await c.proveMined(expectation()), 'unknown');
    });
    });
});

describe('AnchorProofClient (DOGE anchor visibility) @regression @tier2', () => {
    describe('proveMined walks every page before judging', function () {
        it('follows the cursor and finds a match that fell past the first page', async function () {
        const c = client();
        const seen = [];
        c.fetch = async (txid, after) => {
        seen.push(after);
        return (after === null || after === undefined)
        ? { exists: true, anchors: [sibling()], truncated: true, next_after_action_index: 41 }
        : { exists: true, anchors: [anchor()], truncated: false, next_after_action_index: null };
        };
        assert.strictEqual(await c.proveMined(expectation()), 'verified');
        assert.deepStrictEqual(seen, [null, 41], 'the second page must be requested from the reported cursor');
        });

        it('does not reject on a truncated window whose later page contradicts the tuple', async function () {
        // Same shape, but the anchor past the boundary is also a mis-bind: only after the
        // walk completes is 'rejected' a statement about the WHOLE set rather than a page.
        const c = client();
        c.fetch = async (txid, after) => (after === null || after === undefined)
        ? { exists: true, anchors: [sibling()], truncated: true, next_after_action_index: 41 }
        : { exists: true, anchors: [sibling()], truncated: false, next_after_action_index: null };
        assert.strictEqual(await c.proveMined(expectation()), 'rejected');
        });

        it('asks for exactly one page when the peer says the set is complete', async function () {
        const c = client();
        let calls = 0;
        c.fetch = async () => { calls++; return { exists: true, anchors: [anchor()], truncated: false }; };
        assert.strictEqual(await c.proveMined(expectation()), 'verified');
        assert.strictEqual(calls, 1);
        });

        it('stops after one page against a peer that reports no truncation field at all', async function () {
        // An indexer predating pagination. The walk must degrade to exactly the old
        // behaviour (judge page one) rather than stall the block loop on a mixed fleet.
        const c = client();
        let calls = 0;
        c.fetch = async () => { calls++; return { exists: true, anchors: [sibling()] }; };
        assert.strictEqual(await c.proveMined(expectation()), 'rejected');
        assert.strictEqual(calls, 1);
        });

        it('refuses to judge a partial set when the cursor is missing or does not advance', async function () {
        const noCursor = client();
        noCursor.fetch = async () => ({ exists: true, anchors: [sibling()], truncated: true,
        next_after_action_index: null });
        assert.strictEqual(await noCursor.proveMined(expectation()), 'unknown');

        const stuck = client();
        stuck.fetch = async () => ({ exists: true, anchors: [sibling()], truncated: true,
        next_after_action_index: 41 });
        assert.strictEqual(await stuck.proveMined(expectation()), 'unknown',
        'a cursor that never advances would loop forever; it is a half-spoken protocol, not a set');
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

    describe('proveMined walks every page before judging', function () {
    it('bounds the walk and refuses rather than judging what it managed to collect', async function () {
    const c = client();
    let calls = 0;
    c.fetch = async () => {
    calls++;
    return { exists: true, anchors: [sibling()], truncated: true, next_after_action_index: calls };
    };
    assert.strictEqual(await c.proveMined(expectation()), 'unknown');
    assert.ok(calls > 1 && calls <= 100, 'the walk must terminate on its own; made ' + calls + ' calls');
    });

    it('never memoizes an undecided walk, so the reward is retried rather than lost', async function () {
    const c = client();
    let calls = 0;
    c.fetch = async () => {
    calls++;
    return { exists: true, anchors: [sibling()], truncated: true, next_after_action_index: null };
    };
    assert.strictEqual(await c.proveMined(expectation()), 'unknown');
    const before = calls;
    assert.strictEqual(await c.proveMined(expectation()), 'unknown');
    assert.ok(calls > before, 'an undecided verdict must be re-asked, never cached');
    });
    });
});