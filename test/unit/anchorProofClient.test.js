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

function client() { return new AnchorProofClient({ COIN: 'BTC', NETWORK: 'regtest' }, { url: 'http://doge.invalid/' }); }

describe('AnchorProofClient (DOGE anchor visibility) @regression @tier2', function () {

    describe('_judge: binding an on-chain anchor to the reward tuple', function () {
        it('verifies a buried, tuple-matching v1 archive head on its match_batch_seq', function () {
            assert.strictEqual(client()._judge([anchor()], expectation()), 'verified');
        });

        it('verifies the v0 bundle leg against an anchor_bundle reward on its snapshot block', function () {
            const a = anchor({ version: 0, match_batch_seq: null, checkpoint_seq: 900 });
            const e = expectation({ rewardType: 'anchor_bundle', roundReference: 900 });
            assert.strictEqual(client()._judge([a], e), 'verified');
        });

        it('rejects a v0 bundle section offered as proof of an ARCHIVE reward', function () {
            const a = anchor({ version: 0, match_batch_seq: null });
            assert.strictEqual(client()._judge([a], expectation()), 'rejected');
        });

        it('rejects a v1 archive head offered as proof of a BUNDLE reward', function () {
            const e = expectation({ rewardType: 'anchor_bundle', roundReference: 900 });
            assert.strictEqual(client()._judge([anchor()], e), 'rejected');
        });

        it('rejects an anchor crediting a different publisher', function () {
            assert.strictEqual(client()._judge([anchor({ publisher: 'cc'.repeat(32) })], expectation()), 'rejected');
        });

        it('rejects an anchor for a different round', function () {
            // The archive family's round term is match_batch_seq, never the wrapper's seq.
            assert.strictEqual(client()._judge([anchor({ match_batch_seq: 13 })], expectation()), 'rejected');
            assert.strictEqual(client()._judge([anchor({ checkpoint_seq: 8 })], expectation()), 'verified',
                'a different wrapper checkpoint_seq is not a different archive round');
        });

        it('rejects an anchor whose snapshot_block differs (a different signing set)', function () {
            assert.strictEqual(client()._judge([anchor({ snapshot_block: 901 })], expectation()), 'rejected');
        });

        it('rejects an anchor for a different network', function () {
            assert.strictEqual(client()._judge([anchor({ checkpoint_network: 'testnet' })], expectation()), 'rejected');
        });

        // Neither live family binds a chain, so there is no chain term left to gate on. The
        // archive XANCPUB canonical keys on MATCH_BATCH_SEQ and its head carries whatever
        // checkpoint wrapped it; a bundle is ONE action over every chain under one reward.
        it('binds no chain on either live family', function () {
            const c = client();
            const head = anchor({ checkpoint_chain: 'LTC' });
            assert.strictEqual(c._judge([head], expectation()), 'verified',
                'an archive head wrapping another chain\'s checkpoint still proves its own reward');
            const sect = anchor({ version: 0, checkpoint_chain: 'DOGE', match_batch_seq: null, checkpoint_seq: 900 });
            assert.strictEqual(c._judge([sect], expectation({ rewardType: 'anchor_bundle', roundReference: 900 })),
                'verified', 'a bundle section proves the one bundle reward whichever chain it names');
        });

        // The per-chain family retired with its wires. reward_type is inside the XANCPUB
        // canonical the caller re-verifies, so every node reads the same retired name off the
        // same signed bytes and reaches the same permanent verdict. Falling back to a family
        // would let a live anchor stand in for a reward no live wire can carry.
        it('permanently rejects a reward_type naming no live family', function () {
            const c = client();
            for (const rewardType of ['anchor_BTC', 'anchor_btc', 'anchor_LTC', 'anchor_DOGE', 'anchor_nonsense'])
                assert.strictEqual(c._judge([anchor(), anchor({ version: 0, match_batch_seq: null })],
                                            expectation({ rewardType })), 'rejected', rewardType);
        });

        it('rejects a retired reward_type even on a transaction carrying no anchors at all', function () {
            assert.strictEqual(client()._judge([], expectation({ rewardType: 'anchor_BTC' })), 'rejected',
                'the verdict comes off the signed reward_type alone, so it never depends on the page');
        });

        it('rejects a decoded-invalid anchor (it never anchored anything)', function () {
            assert.strictEqual(client()._judge([anchor({ status: 'invalid: bad sigs' })], expectation()), 'rejected');
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
            assert.strictEqual(c._judge([anchor({ status: 'invalid: insufficient valid signatures (1/3)' })],
                                        expectation()), 'verified');
            assert.strictEqual(c._judge([anchor({ status: 'invalid: insufficient signer stake' })],
                                        expectation()), 'verified');
        });

        it('does not reject on invalid_archive, which only a chunk-holding node can stamp', function () {
            assert.strictEqual(client()._judge([anchor({ status: 'invalid_archive' })], expectation()), 'verified');
        });

        it('still treats unverified as non-evidence, matching the two statuses above', function () {
            assert.strictEqual(client()._judge([anchor({ status: 'unverified' })], expectation()), 'verified');
        });

        it('keeps rejecting the deterministic invalid reasons a node computes from the wire', function () {
            const c = client();
            for(const status of ['invalid: BATCH_CRC32 (archive mismatch)',
                                 'invalid: CHECKPOINT_SEQ (stale; replay of an older checkpoint)',
                                 'invalid: STATE_ROOT (format)',
                                 'invalid: VERSION (unknown)'])
                assert.strictEqual(c._judge([anchor({ status })], expectation()), 'rejected', status);
        });

        // Depth is the one failure that self-heals, so it must never be terminal: the anchor
        // WILL bury. Treating it as a reject would forfeit a legitimate reward permanently.
        it('returns unknown for a tuple-matching anchor that is not yet buried deep enough', function () {
            assert.strictEqual(client()._judge([anchor({ confirmations: 59 })], expectation()), 'unknown');
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
            assert.strictEqual(c._judge([anchor({ version: 2, publisher: null })], expectation()), 'unknown');
        });

        // The pre-restart era, in one place. The version restart renumbered the archive head
        // 6 -> 1 and the bundle 7 -> 0 (anchor.js dispatch), so a pre-restart anchor row
        // keeps its legacy wire byte while naming the same shape. A reward attested before
        // the restart but maturing after it (BTC testnet 150456) must prove against that
        // byte; the family exclusivity holds across eras; and the retired per-chain wires
        // reject deterministically instead of deferring the block forever.
        it('verifies a buried, tuple-matching pre-restart v6 archive head (the 150456 shape)', function () {
            assert.strictEqual(client()._judge([anchor({ version: 6 })], expectation()), 'verified');
        });

        it('verifies a buried pre-restart v7 bundle against its anchor_bundle reward', function () {
            const a = anchor({ version: 7, match_batch_seq: null, checkpoint_seq: 900 });
            const e = expectation({ rewardType: 'anchor_bundle', roundReference: 900 });
            assert.strictEqual(client()._judge([a], e), 'verified');
        });

        it('keeps the family exclusive across eras: v6 proves no bundle, v7 proves no archive', function () {
            const c = client();
            const e = expectation({ rewardType: 'anchor_bundle', roundReference: 900 });
            assert.strictEqual(c._judge([anchor({ version: 6 })], e), 'rejected');
            assert.strictEqual(c._judge([anchor({ version: 7, match_batch_seq: null })], expectation()), 'rejected');
        });

        it('rejects (never defers on) a txid carrying only retired per-chain v4/v5 anchors', function () {
            const c = client();
            for (const version of [4, 5])
                assert.strictEqual(c._judge([anchor({ version })], expectation()), 'rejected', 'v' + version);
        });

        it('drops a post-activation forgery on a legacy byte via its wire-determined status', function () {
            // At/above ANCHOR_ACTIVATION a legacy byte parses 'invalid: VERSION (unknown)',
            // chain data every DOGE node computes identically, so the row is not evidence
            // and the mis-bind resolves 'rejected' rather than minting or deferring.
            const a = anchor({ version: 6, status: 'invalid: VERSION (unknown)' });
            assert.strictEqual(client()._judge([a], expectation()), 'rejected');
        });

        it('picks the matching anchor when a transaction carries several', function () {
            const rows = [anchor({ version: 2, publisher: null }), anchor()];
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

    // getanchorconfirmations bounds its answer. Before the walk below, a window cut off
    // BEFORE the matching anchor looked identical on the wire to a complete non-matching
    // set: _judge read a positively-detected mis-bind, proveMined MEMOIZED it, and
    // anchor_reward_derive turned that into "no reward derived" forever - a legitimate
    // COLLECT-spendable reward lost silently and permanently. Reinterpreting the verdict
    // was not an option: 'unknown' raises AnchorProofUnavailableError, which HALTS block
    // processing on every BTC node and never clears, because the same deterministic window
    // returns on every retry. So the window is removed instead, and _judge is handed the
    // complete set it always assumed it had.
    describe('proveMined walks every page before judging', function () {
        // A sibling attested anchor that is NOT this tuple's: on its own it makes _judge
        // return the permanent 'rejected'.
        function sibling() { return anchor({ match_batch_seq: 999 }); }

        it('follows the cursor and finds a match that fell past the first page', async function () {
            const c = client();
            const seen = [];
            c._fetch = async (txid, after) => {
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
            c._fetch = async (txid, after) => (after === null || after === undefined)
                ? { exists: true, anchors: [sibling()], truncated: true, next_after_action_index: 41 }
                : { exists: true, anchors: [sibling()], truncated: false, next_after_action_index: null };
            assert.strictEqual(await c.proveMined(expectation()), 'rejected');
        });

        it('asks for exactly one page when the peer says the set is complete', async function () {
            const c = client();
            let calls = 0;
            c._fetch = async () => { calls++; return { exists: true, anchors: [anchor()], truncated: false }; };
            assert.strictEqual(await c.proveMined(expectation()), 'verified');
            assert.strictEqual(calls, 1);
        });

        it('stops after one page against a peer that reports no truncation field at all', async function () {
            // An indexer predating pagination. The walk must degrade to exactly the old
            // behaviour (judge page one) rather than stall the block loop on a mixed fleet.
            const c = client();
            let calls = 0;
            c._fetch = async () => { calls++; return { exists: true, anchors: [sibling()] }; };
            assert.strictEqual(await c.proveMined(expectation()), 'rejected');
            assert.strictEqual(calls, 1);
        });

        it('refuses to judge a partial set when the cursor is missing or does not advance', async function () {
            const noCursor = client();
            noCursor._fetch = async () => ({ exists: true, anchors: [sibling()], truncated: true,
                                             next_after_action_index: null });
            assert.strictEqual(await noCursor.proveMined(expectation()), 'unknown');

            const stuck = client();
            stuck._fetch = async () => ({ exists: true, anchors: [sibling()], truncated: true,
                                          next_after_action_index: 41 });
            assert.strictEqual(await stuck.proveMined(expectation()), 'unknown',
                'a cursor that never advances would loop forever; it is a half-spoken protocol, not a set');
        });

        it('bounds the walk and refuses rather than judging what it managed to collect', async function () {
            const c = client();
            let calls = 0;
            c._fetch = async () => {
                calls++;
                return { exists: true, anchors: [sibling()], truncated: true, next_after_action_index: calls };
            };
            assert.strictEqual(await c.proveMined(expectation()), 'unknown');
            assert.ok(calls > 1 && calls <= 100, 'the walk must terminate on its own; made ' + calls + ' calls');
        });

        it('never memoizes an undecided walk, so the reward is retried rather than lost', async function () {
            const c = client();
            let calls = 0;
            c._fetch = async () => {
                calls++;
                return { exists: true, anchors: [sibling()], truncated: true, next_after_action_index: null };
            };
            assert.strictEqual(await c.proveMined(expectation()), 'unknown');
            const before = calls;
            assert.strictEqual(await c.proveMined(expectation()), 'unknown');
            assert.ok(calls > before, 'an undecided verdict must be re-asked, never cached');
        });
    });

    // The v0 checkpoint bundle: ONE anchor action carrying every checkpointed chain as a
    // section under one action_index, one publisher tail, and exactly ONE reward of type
    // 'anchor_bundle' keyed on the bundle's SNAPSHOT_BLOCK. So the reward is bound to the
    // BUNDLE, never to a chain: proving it mined is finding the v0 anchor at that txid whose
    // sections carry the reward's snapshot block, not matching a chain name.
    //
    // Each section becomes its own anchor_actions row, so getanchorconfirmations answers a
    // bundle transaction with N version-0 entries sharing publisher, network and status, each
    // carrying its own chain, block_index, checkpoint_seq and snapshot_block.
    describe('_judge: the v0 bundle leg', function () {
        const SNAP = 150208;

        // One section row of a three-chain bundle, in the shape the DOGE indexer serves.
        function section(overrides) {
            return Object.assign({
                status: 'valid', version: 0,
                checkpoint_chain: 'BTC', checkpoint_network: 'regtest',
                block_index: 150208, checkpoint_seq: SNAP, snapshot_block: SNAP,
                publisher: 'aa'.repeat(32), match_batch_seq: null,
                block_index_doge: 100, confirmations: 60
            }, overrides || {});
        }

        // The three sections of one bundle, exactly as the live anchor carries them.
        function bundle(overrides) {
            return [section(Object.assign({ checkpoint_chain: 'BTC'  }, overrides || {})),
                    section(Object.assign({ checkpoint_chain: 'DOGE' }, overrides || {})),
                    section(Object.assign({ checkpoint_chain: 'LTC'  }, overrides || {}))];
        }

        // The one reward the bundle earns. round_reference IS the snapshot block.
        function bundleReward(overrides) {
            return expectation(Object.assign({
                rewardType: 'anchor_bundle', roundReference: SNAP, snapshotBlock: SNAP
            }, overrides || {}));
        }

        it('verifies a buried v0 bundle against its one anchor_bundle reward', function () {
            assert.strictEqual(client()._judge(bundle(), bundleReward()), 'verified');
        });

        // The whole point of the family: no section's chain is compared to anything. Slicing
        // the chain out of 'anchor_bundle' yields the literal 'BUNDLE', which no section can
        // ever equal, so a chain-named binding cannot prove this reward at all.
        it('binds the bundle reward to no chain, whichever section leads the wire', function () {
            const c = client();
            for (const first of ['LTC', 'DOGE', 'BTC'])
                assert.strictEqual(c._judge([section({ checkpoint_chain: first })], bundleReward()),
                                   'verified', first);
        });

        // A bundle is proven at the block the reward names. A bundle at a different snapshot
        // block is a positively-detected mis-bind: chain data, identical on every honest node,
        // so it is the permanent 'rejected' the rest of this file gives that case. Degrading it
        // to 'unknown' would raise AnchorProofUnavailableError on every retry and wedge the
        // block loop forever, which is the failure this leg exists to remove.
        it('refuses a v0 bundle whose snapshot block is not the reward round', function () {
            const c = client();
            assert.strictEqual(c._judge(bundle({ snapshot_block: SNAP - 6, checkpoint_seq: SNAP - 6 }),
                                        bundleReward()), 'rejected');
            assert.strictEqual(c._judge(bundle(), bundleReward({ roundReference: SNAP - 6 })), 'rejected');
        });

        // A lagging chain rides the bundle at its OWN older snapshot block, and the parser proves
        // the header block is the maximum over the sections, so the maximum over the section rows
        // reconstructs the header the reward is keyed on. The lagging section must not be able to
        // prove a reward at its own block: no such reward was ever attested or earned.
        it('verifies a bundle carrying a lagging section, and only at the header block', function () {
            const rows = [section({ checkpoint_chain: 'BTC' }),
                          section({ checkpoint_chain: 'LTC', snapshot_block: SNAP - 6, checkpoint_seq: SNAP - 6 })];
            assert.strictEqual(client()._judge(rows, bundleReward()), 'verified');
            assert.strictEqual(client()._judge(rows, bundleReward({ roundReference: SNAP - 6, snapshotBlock: SNAP - 6 })),
                               'rejected');
        });

        // CHECKPOINT_SEQ and SECTION_SNAPSHOT_BLOCK are separate wire fields on a section, and
        // the bundle reward is keyed on the snapshot block alone. A section's own seq is
        // per-chain checkpoint identity, covered by that section's own signatures; it is no
        // part of the one reward, so the round term must never read it. Binding to it instead
        // would tie the whole bundle to whichever chain led the wire.
        it('binds the bundle round to the snapshot block, never to a section checkpoint_seq', function () {
            assert.strictEqual(client()._judge(bundle({ checkpoint_seq: SNAP - 3 }), bundleReward()), 'verified');
        });

        it('refuses a v0 bundle crediting a different publisher', function () {
            assert.strictEqual(client()._judge(bundle({ publisher: 'cc'.repeat(32) }), bundleReward()), 'rejected');
        });

        it('refuses a v0 bundle anchored for a different network', function () {
            assert.strictEqual(client()._judge(bundle({ checkpoint_network: 'testnet' }), bundleReward()), 'rejected');
        });

        // Depth is the one failure that self-heals, so a matching but shallow bundle defers.
        it('returns unknown for a matching bundle that is not yet buried deep enough', function () {
            assert.strictEqual(client()._judge(bundle({ confirmations: 59 }), bundleReward()), 'unknown');
        });

        // A bundle section can never stand in for a retired per-chain reward: it shares the
        // publisher, network, snapshot block, seq and even the chain of the anchor_<CHAIN>
        // reward of the same round, and now the reward_type names no live family at all.
        it('refuses a v0 section as proof of a retired per-chain reward', function () {
            assert.strictEqual(client()._judge([section()],
                expectation({ rewardType: 'anchor_BTC', roundReference: SNAP, snapshotBlock: SNAP })),
                'rejected');
        });

        it('refuses a v1 archive head as proof of a bundle reward', function () {
            const a = anchor({ version: 1, checkpoint_seq: SNAP, snapshot_block: SNAP, match_batch_seq: SNAP });
            assert.strictEqual(client()._judge([a], bundleReward()), 'rejected');
        });

        // Pre-restart anchors are attested rows every node can read, so they are evidence:
        // the bundle's own pre-restart byte (7) proves its reward, and the rest of the
        // legacy set resolves 'rejected' deterministically instead of deferring the block
        // forever (the BTC testnet 150455 halt).
        it('judges a pre-restart anchor offered as proof of a bundle reward', function () {
            const c = client();
            for (const version of [4, 5, 6])
                assert.strictEqual(c._judge([anchor({ version, checkpoint_seq: SNAP, snapshot_block: SNAP })],
                                            bundleReward()), 'rejected', 'v' + version);
            assert.strictEqual(c._judge([anchor({ version: 7, checkpoint_seq: SNAP, snapshot_block: SNAP })],
                                        bundleReward()), 'verified', 'v7 is the bundle\'s own pre-restart byte');
        });

        // "Cannot tell" must stay apart from "no". A transaction carrying only unattested rows
        // (an archive continuation chunk, say) is no evidence either way, so the block defers
        // and the reward is re-asked rather than forfeited.
        it('returns unknown when the txid carries no attestation-bearing anchor at all', function () {
            const chunk = section({ version: 2, publisher: null, snapshot_block: null, checkpoint_seq: null });
            assert.strictEqual(client()._judge([chunk], bundleReward()), 'unknown');
        });

        // The live shape: an archive head sharing the transaction with the bundle. Each reward
        // is proven from its own leg and neither leg can answer for the other.
        it('judges a bundle and an unrelated archive head sharing one transaction', function () {
            const archiveHead = anchor({ version: 1, checkpoint_chain: 'DOGE', checkpoint_seq: 99,
                                         snapshot_block: SNAP, match_batch_seq: 12 });
            const rows = bundle().concat([archiveHead]);
            assert.strictEqual(client()._judge(rows, bundleReward()), 'verified');
            assert.strictEqual(client()._judge(rows, expectation({ rewardType: 'anchor_archive',
                                                                  roundReference: 12, snapshotBlock: SNAP })),
                               'verified');
            // The archive head is the only v1 present, so a bundle reward at ITS batch seq is
            // still a mis-bind rather than an accidental match.
            assert.strictEqual(client()._judge(rows, bundleReward({ roundReference: 12, snapshotBlock: 12 })),
                               'rejected');
        });

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
                assert.strictEqual(c._judge(bundle({ status }), bundleReward()), 'verified', status);
        });

        it('keeps rejecting the v0 verdicts a node computes from the wire alone', function () {
            const c = client();
            for (const status of ['invalid: SECTION 1 CHECKPOINT_SEQ (stale; replay of an older checkpoint)',
                                  'invalid: SECTION 0 CHAIN (duplicate)',
                                  'invalid: SNAPSHOT_BLOCK (not the section maximum)'])
                assert.strictEqual(c._judge(bundle({ status }), bundleReward()), 'rejected', status);
        });

        // End to end over the real transport shape: one page, three version-0 sections, the
        // verdict memoized per tuple.
        it('proves the live three-section bundle through proveMined', async function () {
            const c = client();
            let calls = 0;
            c._fetch = async () => { calls++; return { exists: true, anchors: bundle(), truncated: false }; };
            assert.strictEqual(await c.proveMined(bundleReward()), 'verified');
            assert.strictEqual(await c.proveMined(bundleReward()), 'verified');
            assert.strictEqual(calls, 1);
        });
    });

    // The per-chain leg is RETIRED with its wires. Its already-attested rewards stay
    // recorded and are never re-derived (spec D9), so what this proof client owes them is a
    // deterministic permanent NO rather than an 'unknown' that would wedge the block loop
    // waiting for an anchor no live wire can ever carry.
    describe('_judge: the retired per-chain leg', function () {
        it('exposes the live and pre-restart attested versions', function () {
            // 0/1 are the live wires; 4-7 are the pre-restart bytes, kept so an attested
            // reward maturing after the version restart still finds its anchor (6/7 prove
            // their renumbered family, 4/5 reject deterministically via the family map).
            assert.deepStrictEqual(AnchorProofClient.ATTESTED_VERSIONS.slice().sort((a, b) => a - b), [0, 1, 4, 5, 6, 7]);
        });

        it('rejects every per-chain reward_type, whatever the transaction carries', function () {
            const c = client();
            for (const chain of ['BTC', 'DOGE', 'LTC']) {
                const e = expectation({ rewardType: 'anchor_' + chain });
                assert.strictEqual(c._judge([anchor({ checkpoint_chain: chain })], e), 'rejected', chain);
                assert.strictEqual(c._judge([anchor({ version: 4, checkpoint_chain: chain })], e), 'rejected', chain + '/v4');
                assert.strictEqual(c._judge([], e), 'rejected', chain + '/empty');
            }
        });

        it('leaves the two live legs proving their own rewards', function () {
            const c = client();
            assert.strictEqual(c._judge([anchor({ checkpoint_chain: 'LTC' })], expectation()), 'verified');
            assert.strictEqual(
                c._judge([anchor({ version: 0, match_batch_seq: null, checkpoint_seq: 900 })],
                         expectation({ rewardType: 'anchor_bundle', roundReference: 900 })), 'verified');
        });
    });
});
