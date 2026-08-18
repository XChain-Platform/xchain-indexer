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
 * test/unit/anchorProofClient.test.js
 *
 * DOGE anchor visibility for the BTC-side reward derivation (AML #4171).
 *
 * The reward this proof guards is COLLECT-spendable and is minted on BTC from a
 * hub-mirrored row, so the binding rule matters twice over: it must accept ONLY an anchor
 * that is this reward's anchor, and it must keep "cannot tell" strictly apart from "no".
 * Conflating the two is what forks the ledger: a node that skipped an unprovable reward
 * would commit a different set than a peer that proved it, at a height they both agree on.
 * These cases drive the pure binding half (_judge) plus the txid/wiring guards; the HTTP
 * half is exercised on regtest.
 ********************************************************************/

'use strict';

const assert = require('assert');
const AnchorProofClient = require('../../src/anchor_proof_client.js');

const TXID = 'b'.repeat(64);

// A getanchorconfirmations anchor entry for the reward tuple used throughout.
function anchor(overrides) {
    return Object.assign({
        status: 'valid', version: 4,
        checkpoint_chain: 'BTC', checkpoint_network: 'regtest',
        block_index: 500, checkpoint_seq: 7, snapshot_block: 900,
        publisher: 'aa'.repeat(32), match_batch_seq: null,
        block_index_doge: 100, confirmations: 60
    }, overrides || {});
}

function expectation(overrides) {
    return Object.assign({
        txid: TXID, rewardType: 'anchor_BTC', roundReference: 7,
        snapshotBlock: 900, publisher: 'aa'.repeat(32),
        network: 'regtest', minConfirmations: 60
    }, overrides || {});
}

function client() { return new AnchorProofClient({ COIN: 'BTC', NETWORK: 'regtest' }, { url: 'http://doge.invalid/' }); }

describe('AnchorProofClient (DOGE anchor visibility) @regression @tier2', function () {

    describe('_judge: binding an on-chain anchor to the reward tuple', function () {
        it('verifies a buried, tuple-matching v4 anchor', function () {
            assert.strictEqual(client()._judge([anchor()], expectation()), 'verified');
        });

        it('verifies the v6 archive leg against an archive reward on match_batch_seq', function () {
            const a = anchor({ version: 6, checkpoint_seq: 99, match_batch_seq: 12 });
            const e = expectation({ rewardType: 'anchor_archive', roundReference: 12 });
            assert.strictEqual(client()._judge([a], e), 'verified');
        });

        it('rejects a v4 anchor offered as proof of an ARCHIVE reward', function () {
            const e = expectation({ rewardType: 'anchor_archive', roundReference: 7 });
            assert.strictEqual(client()._judge([anchor()], e), 'rejected');
        });

        it('rejects a v6 anchor offered as proof of a PER-CHAIN reward', function () {
            const a = anchor({ version: 6, match_batch_seq: 7 });
            assert.strictEqual(client()._judge([a], expectation()), 'rejected');
        });

        it('rejects an anchor crediting a different publisher', function () {
            assert.strictEqual(client()._judge([anchor({ publisher: 'cc'.repeat(32) })], expectation()), 'rejected');
        });

        it('rejects an anchor for a different round', function () {
            assert.strictEqual(client()._judge([anchor({ checkpoint_seq: 8 })], expectation()), 'rejected');
        });

        it('rejects an anchor whose snapshot_block differs (a different signing set)', function () {
            assert.strictEqual(client()._judge([anchor({ snapshot_block: 901 })], expectation()), 'rejected');
        });

        it('rejects an anchor for a different network', function () {
            assert.strictEqual(client()._judge([anchor({ checkpoint_network: 'testnet' })], expectation()), 'rejected');
        });

        it('rejects a decoded-invalid anchor (it never anchored anything)', function () {
            assert.strictEqual(client()._judge([anchor({ status: 'invalid: bad sigs' })], expectation()), 'rejected');
        });

        // Depth is the one failure that self-heals, so it must never be terminal: the anchor
        // WILL bury. Treating it as a reject would forfeit a legitimate reward permanently.
        it('returns unknown for a tuple-matching anchor that is not yet buried deep enough', function () {
            assert.strictEqual(client()._judge([anchor({ confirmations: 59 })], expectation()), 'unknown');
        });

        // A transaction carrying only unattested versions tells us nothing about this reward:
        // we cannot distinguish a forge from a row we simply cannot read, so we must defer.
        it('returns unknown when the txid carries no attestation-bearing anchor at all', function () {
            assert.strictEqual(client()._judge([anchor({ version: 0, publisher: null })], expectation()), 'unknown');
        });

        it('picks the matching anchor when a transaction carries several', function () {
            const rows = [anchor({ version: 0, publisher: null }), anchor()];
            assert.strictEqual(client()._judge(rows, expectation()), 'verified');
        });
    });

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
            c._fetch = async () => { calls++; return { exists: true, anchors: [anchor()] }; };
            assert.strictEqual(await c.proveMined(expectation()), 'verified');
            assert.strictEqual(await c.proveMined(expectation()), 'verified');
            assert.strictEqual(calls, 1, 'a buried anchor is immutable chain data; re-asking is pure load');

            const c2 = client();
            let calls2 = 0;
            c2._fetch = async () => { calls2++; return { exists: true, anchors: [anchor({ confirmations: 1 })] }; };
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
            c._fetch = async () => ({ exists: true, anchors: [anchor()] });
            assert.strictEqual(await c.proveMined(expectation()), 'verified');
            // A different publisher's row naming the same txid is a positively-detected
            // mis-bind and must still be judged, not answered from the first row's memo.
            assert.strictEqual(
                await c.proveMined(expectation({ publisher: 'bb'.repeat(32) })), 'rejected');

            // Same shape the other way round: a rejected tuple must not poison the legitimate one.
            const c2 = client();
            c2._fetch = async () => ({ exists: true, anchors: [anchor()] });
            assert.strictEqual(await c2.proveMined(expectation({ roundReference: 8 })), 'rejected');
            assert.strictEqual(await c2.proveMined(expectation()), 'verified');
        });

        it('treats an unreachable DOGE indexer as unknown (defer), not as absent', async function () {
            const c = client();
            c._fetch = async () => null;
            assert.strictEqual(await c.proveMined(expectation()), 'unknown');
        });

        it('treats "no such transaction" as unknown: the DOGE indexer may simply be behind', async function () {
            const c = client();
            c._fetch = async () => ({ exists: false, anchors: [] });
            assert.strictEqual(await c.proveMined(expectation()), 'unknown');
        });
    });
});
