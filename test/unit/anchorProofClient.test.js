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

        // The cross-chain mis-bind the rest of the tuple cannot see. Every per-chain checkpoint
        // of one round shares network, snapshot_block, checkpoint_seq and publisher, so a real,
        // buried, correctly attested LTC anchor differs from the BTC one ONLY in chain.
        it('rejects a real anchor for a SIBLING CHAIN of the same round', function () {
            assert.strictEqual(client()._judge([anchor({ checkpoint_chain: 'LTC' })], expectation()), 'rejected');
        });

        // The expected chain comes from reward_type, which the XANCPUB quorum signed, never from
        // the mirror's unsigned `chain` column: a corrupted row that renames both must still
        // produce an anchor for the chain its reward_type claims.
        it('rejects a sibling-chain anchor even when the row also claims that chain', function () {
            const e = expectation({ rewardType: 'anchor_BTC', chain: 'LTC' });
            assert.strictEqual(client()._judge([anchor({ checkpoint_chain: 'LTC' })], e), 'rejected');
        });

        it('accepts a chain that differs only in case (the DOGE parse side uppercases)', function () {
            const e = expectation({ rewardType: 'anchor_btc' });
            assert.strictEqual(client()._judge([anchor()], e), 'verified');
        });

        // The archive XANCPUB canonical binds no chain (it keys on MATCH_BATCH_SEQ), and a v6
        // head carries whatever checkpoint wrapped it, so the chain guard must not fire there.
        it('does not chain-gate the archive leg', function () {
            const a = anchor({ version: 6, checkpoint_chain: 'LTC', checkpoint_seq: 99, match_batch_seq: 12 });
            const e = expectation({ rewardType: 'anchor_archive', roundReference: 12 });
            assert.strictEqual(client()._judge([a], e), 'verified');
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
            const a = anchor({ version: 6, checkpoint_seq: 99, match_batch_seq: 12, status: 'invalid_archive' });
            const e = expectation({ rewardType: 'anchor_archive', roundReference: 12 });
            assert.strictEqual(client()._judge([a], e), 'verified');
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
        function sibling() { return anchor({ checkpoint_seq: 999 }); }

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

    // The v7 checkpoint bundle: ONE anchor action carrying every checkpointed chain as a
    // section under one action_index, one publisher tail, and exactly ONE reward of type
    // 'anchor_bundle' keyed on the bundle's SNAPSHOT_BLOCK. So the reward is bound to the
    // BUNDLE, never to a chain: proving it mined is finding the v7 anchor at that txid whose
    // sections carry the reward's snapshot block, not matching a chain name.
    //
    // Each section becomes its own anchor_actions row, so getanchorconfirmations answers a
    // bundle transaction with N version-7 entries sharing publisher, network and status, each
    // carrying its own chain, block_index, checkpoint_seq and snapshot_block.
    describe('_judge: the v7 bundle leg', function () {
        const SNAP = 150208;

        // One section row of a three-chain bundle, in the shape the DOGE indexer serves.
        function section(overrides) {
            return Object.assign({
                status: 'valid', version: 7,
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

        it('verifies a buried v7 bundle against its one anchor_bundle reward', function () {
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
        it('refuses a v7 bundle whose snapshot block is not the reward round', function () {
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

        it('refuses a v7 bundle crediting a different publisher', function () {
            assert.strictEqual(client()._judge(bundle({ publisher: 'cc'.repeat(32) }), bundleReward()), 'rejected');
        });

        it('refuses a v7 bundle anchored for a different network', function () {
            assert.strictEqual(client()._judge(bundle({ checkpoint_network: 'testnet' }), bundleReward()), 'rejected');
        });

        // Depth is the one failure that self-heals, so a matching but shallow bundle defers.
        it('returns unknown for a matching bundle that is not yet buried deep enough', function () {
            assert.strictEqual(client()._judge(bundle({ confirmations: 59 }), bundleReward()), 'unknown');
        });

        // A version-7 section can never stand in for a legacy per-chain reward: it shares the
        // publisher, network, snapshot block, seq and even the chain of the anchor_<CHAIN>
        // reward of the same round, so the family map is the ONLY thing separating them.
        it('refuses a v7 section as proof of a per-chain reward', function () {
            assert.strictEqual(client()._judge([section()], expectation({ roundReference: SNAP, snapshotBlock: SNAP })),
                               'rejected');
        });

        it('refuses a v4 or v5 per-chain anchor as proof of a bundle reward', function () {
            const c = client();
            for (const version of [4, 5])
                assert.strictEqual(c._judge([anchor({ version, checkpoint_seq: SNAP, snapshot_block: SNAP })],
                                            bundleReward()), 'rejected', 'v' + version);
        });

        it('refuses a v6 archive head as proof of a bundle reward', function () {
            const a = anchor({ version: 6, checkpoint_seq: SNAP, snapshot_block: SNAP, match_batch_seq: SNAP });
            assert.strictEqual(client()._judge([a], bundleReward()), 'rejected');
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
            const archiveHead = anchor({ version: 6, checkpoint_chain: 'DOGE', checkpoint_seq: 99,
                                         snapshot_block: SNAP, match_batch_seq: 12 });
            const rows = bundle().concat([archiveHead]);
            assert.strictEqual(client()._judge(rows, bundleReward()), 'verified');
            assert.strictEqual(client()._judge(rows, expectation({ rewardType: 'anchor_archive',
                                                                  roundReference: 12, snapshotBlock: SNAP })),
                               'verified');
            // The archive head is the only v6 present, so a bundle reward at ITS batch seq is
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

        it('keeps rejecting the v7 verdicts a node computes from the wire alone', function () {
            const c = client();
            for (const status of ['invalid: SECTION 1 CHECKPOINT_SEQ (stale; replay of an older checkpoint)',
                                  'invalid: SECTION 0 CHAIN (duplicate)',
                                  'invalid: SNAPSHOT_BLOCK (not the section maximum)'])
                assert.strictEqual(c._judge(bundle({ status }), bundleReward()), 'rejected', status);
        });

        // End to end over the real transport shape: one page, three version-7 sections, the
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

    // The legacy legs are live on testnet right now and prove 'verified' today, so the bundle
    // work must leave every one of them exactly where it was.
    describe('_judge: the legacy legs are unchanged by the bundle leg', function () {
        it('verifies each per-chain shape against its own reward', function () {
            const c = client();
            for (const chain of ['BTC', 'DOGE', 'LTC']) {
                for (const version of [4, 5]) {
                    assert.strictEqual(
                        c._judge([anchor({ version, checkpoint_chain: chain })],
                                 expectation({ rewardType: 'anchor_' + chain })),
                        'verified', chain + '/v' + version);
                }
            }
        });

        it('still rejects a per-chain reward proven by a SIBLING chain of the same round', function () {
            const c = client();
            assert.strictEqual(c._judge([anchor({ version: 5, checkpoint_chain: 'LTC' })],
                                        expectation({ rewardType: 'anchor_BTC' })), 'rejected');
        });

        it('verifies the v6 archive leg on match_batch_seq and chain-gates nothing', function () {
            const a = anchor({ version: 6, checkpoint_chain: 'LTC', checkpoint_seq: 99, match_batch_seq: 12 });
            assert.strictEqual(client()._judge([a], expectation({ rewardType: 'anchor_archive', roundReference: 12 })),
                               'verified');
        });
    });
});
