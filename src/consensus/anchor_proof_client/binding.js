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
 *
 * The binding rule AnchorProofClient.judge applies: which anchor rows can
 * prove which reward tuple, and the verdict a complete anchor set yields.
 * Pure, so the whole rule is unit-testable without a DOGE indexer.
 *
 ********************************************************************/

'use strict';

// Attestation-bearing ANCHOR versions. A reward exists only for these; anything else on
// the txid is a different anchor and cannot stand in as proof of this one.
//
// The pre-restart wire bytes stay in this set on purpose. Rewards attested against them
// can still be IN FLIGHT: the hub wrote the attestation row before the version restart,
// and the row matures on the fleet watermark, which can land after the restart deployed
// (BTC testnet block 150456 did exactly this). Dropping the legacy bytes from this set
// made such a row eternally 'unknown' - the loop below never saw an attested anchor on
// the txid, and "cannot tell" defers the block forever. Keeping 4/5 (the retired
// per-chain wires) alongside 6/7 also keeps a mis-bind deterministic: a txid carrying
// only per-chain anchors judges 'rejected' rather than deferring, exactly as it did
// before the restart. Which versions can PROVE which family stays the job of
// REWARD_FAMILY_VERSIONS below; membership here only says "this is an attested anchor".
const ATTESTED_VERSIONS = [0, 1, 4, 5, 6, 7];

// Which anchor versions can prove which reward FAMILY, and nothing else.
//
// The reward type names one publishing shape, and each shape rides exactly one wire
// version: 'anchor_archive' is the v1 archive head, 'anchor_bundle' is the v0 per-network
// checkpoint bundle. The map is exhaustive and exclusive on purpose: an archive head can
// never prove a bundle reward and a bundle section can never prove an archive one, whatever
// else on the transaction matches. Membership here is part of the binding, not a
// convenience, so a wire version added later gets a family here or proves nothing.
//
// The per-chain family is gone with the per-chain wires: those rewards were attested before
// the version restart, are already recorded, and are never re-derived.
//
// Each family also admits its PRE-RESTART wire byte. The restart renumbered the same two
// shapes rather than defining new ones - anchor.js's own dispatch reads wire byte 6
// through the v1 archive branch and 7 through the v0 bundle branch - but a pre-restart
// anchor ROW keeps the byte it was mined with, so a pre-restart-attested reward maturing
// after the restart must find its anchor under the legacy byte or it can never be proven
// (the BTC testnet halt at 150455/150456). The exclusivity the map exists for survives the
// alias: 6 admits only into archive and 7 only into bundle, so a bundle section still
// cannot prove an archive reward in either era. A post-activation anchor forged on a
// legacy byte cannot ride in: at/above ANCHOR_ACTIVATION those bytes parse
// 'invalid: VERSION (unknown)', a wire-determined status every DOGE node computes
// identically, and the deterministic-invalid filter in judge drops the row as evidence.
const REWARD_FAMILY_VERSIONS = {
    archive: [1, 6],
    bundle:  [0, 7]
};

// The reward family a reward_type names. reward_type is inside the XANCPUB canonical the
// caller re-verifies (anchor_reward_derive.rewardCanonical), so it is quorum-signed; the
// family is read from it alone and never from an unsigned mirror column. A reward_type
// naming no live family (a pre-restart 'anchor_<CHAIN>') returns null and proves nothing:
// falling back to a family would let a live anchor stand in for a retired reward.
function rewardFamily(rewardType){
    let t = String(rewardType);
    if(t === 'anchor_archive') return 'archive';
    if(t === 'anchor_bundle')  return 'bundle';
    return null;
}

// Anchor statuses that are NOT fleet-uniform, so they are evidence of nothing here.
//
// judge's whole licence to memoize a permanent 'rejected' is that the status is chain
// data every honest DOGE node computes identically. Three values in actions/anchor.js
// break that, and they break it in OPPOSITE directions on the same anchor:
//   'unverified'            - the node holds no mirrored oracle_publish snapshot
//                             (anchor.js oracleN === 0), so it declines to judge the
//                             root quorum at all.
//   'invalid: insufficient  - only a node that DOES mirror the snapshot can produce this
//    signer stake|valid       verdict for the SAME anchor the unmirrored node stamped
//    signatures (n/m)'        'unverified'.
//   'invalid: SECTION n     - the same quorum verdict on the v7 bundle leg, which names the
//    insufficient ...'        failing section. The bundle stamps ONE status across its
//                             section rows, and a node holding no mirrored snapshot for any
//                             section stamps the whole bundle 'unverified', so this spelling
//                             divides the fleet exactly as the per-chain one does.
//   'invalid_archive'       - the head-side reassembly CRC, stamped only by a node that
//                             holds the chunks and passes the unverified-head gate.
// So a BTC node reading a mirrored DOGE indexer memoized 'rejected' and skipped the
// reward forever, while a BTC node reading an unmirrored one read 'unverified', fell
// through to 'verified' and minted: a permanent COLLECT-rail divergence decided by which
// DOGE_INDEXER_URL each node happens to carry. Treating all four as non-evidence pins
// every node to the reading the unmirrored class already produces, so the verdict keys
// only on fields that are node-class-independent (version, chain, network, publisher,
// snapshot_block, seq, confirmations). The publisher-attestation quorum is not lost with
// them: anchor_reward_derive.verifyAttestation re-runs it BTC-side before proveMined.
// Every other 'invalid: ...' anchor.js writes is decided from the wire bytes plus
// replayed DOGE chain state, so it stays a deterministic reject.
const NODE_CLASS_DEPENDENT_STATUS =
    /^(?:unverified|invalid: insufficient|invalid: SECTION \d+ insufficient|invalid_archive)/i;

// Can this row be evidence for the reward tuple at all? The three chain-data terms judge's
// evidence loop applies before it will accept a row: not deterministically invalid, right
// checkpoint network, right publisher. Factored out so the old-peer bundle-header
// reconstruction in judge (which has no action identity to group on) narrows its maximum
// with EXACTLY the predicates the loop will later apply, and the two can never drift apart
// into a header no candidate row can equal. The version-family term stays at each call site,
// which already knows which family it is asking about.
function isRewardCandidateRow(a, network, publisher){
    let status = String((a && a.status) || '');
    if(/^invalid/i.test(status) && !NODE_CLASS_DEPENDENT_STATUS.test(status)) return false;
    if(String((a && a.checkpoint_network) || '') !== network) return false;
    if(String((a && a.publisher) || '').toLowerCase() !== publisher) return false;
    return true;
}

// The bundle's header SNAPSHOT_BLOCK, reconstructed from the section rows.
//
// The wire carries the header block once and each section carries its own, and the
// indexer writes the SECTION's value onto the section's row, so no single row reports
// the header. The parser proves the header IS the maximum over the sections (a header
// above every section would move the attestation round, and the reward's earn block,
// onto an oracle_publish set no section signed against), so the maximum over ONE
// BUNDLE's rows reconstructs it exactly. The hub keys the one bundle reward on that
// header block, so binding here is what stops a LAGGING section, riding the bundle at
// its own older block, from proving a reward at that older block: a reward the
// federation never attested and the bundle never earned.
//
// SCOPED PER ACTION, not per transaction. "One transaction carries one bundle" is a
// convention of the publishing hub, not a rule of the wire: a BATCH gives each command
// its own action_index, so anyone can ride a second ANCHOR on the same DOGE
// transaction, and even a bundle too malformed to yield a section still writes a row
// carrying its header block. A transaction-wide maximum let that unrelated row raise
// the header above the real bundle's, so the genuine section never equalled it, the
// loop below fell through to a positively-detected mis-bind, and proveMined memoized a
// permanent 'rejected' - a legitimate COLLECT-spendable reward forfeited by a
// third-party write. Grouping on action_index is what the wire actually means by "this
// bundle", so two anchors on one transaction can no longer perturb each other.
//
// The grouping needs the row identity, which a DOGE indexer predating that field does
// not serve. Answering 'unknown' there is not an option (it raises
// AnchorProofUnavailableError, halting block processing fleet-wide until the peer is
// upgraded), so the old-peer path keeps ONE maximum but takes it only over rows that
// pass the same version / deterministic-invalid / network / publisher predicates the
// evidence loop applies. That is strictly narrower than the transaction-wide maximum it
// replaces and is still fleet-deterministic (every term is chain data), so 'rejected'
// stays memoizable; it cannot close the case of a forged sibling naming the real
// publisher under a node-class-dependent status, which is why identity is the fix and
// this is the fallback.
//
// Consensus note: this changes which rewards derive, so it is deployed like the other
// pre-arming remedies in anchor_reward_activation.js - remedy in code while
// ANCHOR_REWARD_DERIVE_ACTIVATION.mainnet is inert (null), with the operator ratifying
// a height only once the whole fleet carries it. It needs no gate of its own.
//
// Returns { byAction: Map(action_index -> header block), filtered: old-peer maximum or null }.
function bundleHeaderBlocks(anchors, network, publisher){
    let byAction = new Map();
    let filtered = null;
    for(let a of anchors){
        // Either era's bundle rows (v0, or pre-restart v7) reconstruct the header;
        // one bundle is one era, so the eras never mix within an action.
        if(!REWARD_FAMILY_VERSIONS.bundle.includes(Number(a.version))) continue;
        let b = Number(a.snapshot_block);
        if(!Number.isFinite(b)) continue;
        let ai = Number(a.action_index);
        if(Number.isInteger(ai)){
            let cur = byAction.get(ai);
            if(cur === undefined || b > cur) byAction.set(ai, b);
        }
        // Old-peer fallback only. Sections of one action share status, network and
        // publisher (they are written from one decoded action), so filtering here
        // never drops a genuine section of a bundle this node could prove.
        if(!isRewardCandidateRow(a, network, publisher)) continue;
        if(filtered === null || b > filtered) filtered = b;
    }
    return { byAction: byAction, filtered: filtered };
}

// Does attested anchor row `a` bind to the reward tuple `t` (built in judgeAnchors)?
// `headers` is bundleHeaderBlocks' answer on the bundle leg and null on the archive leg.
// Burial depth is not a term here: judgeAnchors reads it off the row this accepts.
function bindsToTuple(a, t, headers){
    // One family, one wire version per era (REWARD_FAMILY_VERSIONS above). A bundle
    // section can never prove an archive reward and an archive head can never prove a
    // bundle one, in either era, whatever else on the transaction matches.
    if(!t.versions.includes(Number(a.version))) return false;
    // The three chain-data terms, applied through isRewardCandidateRow above so the
    // old-peer header reconstruction narrows on exactly what this loop will accept:
    //   - Decoded-invalid never anchored anything, EXCEPT where the invalidity is a
    //     node-class verdict rather than chain data (NODE_CLASS_DEPENDENT_STATUS
    //     above): those are skipped as evidence so two BTC nodes reading different DOGE
    //     indexers cannot decide the same reward tuple oppositely and fork the set.
    //   - The checkpoint network must be the reward's.
    //   - The publisher must be the elected one the reward pays.
    // No CHAIN term: neither live family binds one. The archive XANCPUB canonical keys on
    // MATCH_BATCH_SEQ, and its head carries the chain of whatever checkpoint wrapped it;
    // a bundle is ONE action carrying every checkpointed chain as a section under one
    // publisher tail and one reward keyed on the bundle SNAPSHOT_BLOCK, so it is bound to
    // the BUNDLE and names no chain at all. The retired per-chain family was the only one
    // that needed the term, and it can no longer be proven at all (see rewardFamily).
    if(!isRewardCandidateRow(a, t.network, t.publisher)) return false;
    // On a v0 section row this column is the SECTION's own snapshot block, not the
    // bundle header's, because a lagging chain rides a bundle at its own block. So the
    // bundle leg holds the row to BOTH values: the reward's snapshot block and the
    // reconstructed header above. The two together prove the row is the header-block
    // section of the bundle the reward names.
    if(t.family === 'bundle'){
        let ai = Number(a.action_index);
        let header = headers.byAction.has(ai) ? headers.byAction.get(ai)
                                              : headers.filtered;
        if(Number(a.snapshot_block) !== header) return false;
    }
    if(Number(a.snapshot_block) !== t.snapshot) return false;
    // The round term per family. Archive: match_batch_seq. Bundle: the snapshot block
    // itself, because a bundle's round_reference IS its SNAPSHOT_BLOCK (one reward per
    // bundle, keyed on the bundle block, six-field XANCPUB canonical with the block
    // repeated at fields 2 and 3). Using a section's checkpoint_seq here instead would
    // bind the whole bundle to whichever chain happened to be first in the wire, and
    // would reject outright any bundle carrying a lagging section whose seq trails the
    // bundle block.
    let seq = t.isArchive ? Number(a.match_batch_seq) : Number(a.snapshot_block);
    return seq === t.round;
}

// Bind the anchors a txid carries to the reward tuple `e` (proveMined's expectation) and
// return 'verified' | 'rejected' | 'unknown'.
function judgeAnchors(anchors, e){
    let family = rewardFamily(e.rewardType);
    // A reward_type that names no live family names a retired wire (the pre-restart
    // per-chain anchors). No anchor of any live version can prove it, and every node
    // reads that off the quorum-signed reward_type alone, so it is a deterministic
    // permanent reject rather than an 'unknown' that would defer the block forever.
    if(family === null) return 'rejected';
    let t = {
        minConf:   Number(e.minConfirmations),
        network:   String(e.network || ''),
        publisher: String(e.publisher || '').toLowerCase(),
        round:     Number(e.roundReference),
        snapshot:  Number(e.snapshotBlock),
        family:    family,
        isArchive: family === 'archive',
        versions:  REWARD_FAMILY_VERSIONS[family]
    };
    let headers = (family === 'bundle') ? bundleHeaderBlocks(anchors, t.network, t.publisher) : null;
    let sawAttested = false;
    for(let a of anchors){
        if(!ATTESTED_VERSIONS.includes(Number(a.version))) continue;   // a sibling anchor in the same tx, not our proof
        sawAttested = true;
        if(!bindsToTuple(a, t, headers)) continue;
        // Bound at last: a tuple-matching anchor that is merely too shallow is a
        // 'unknown' (it will bury), not a 'rejected' (it never will).
        if(!(Number(a.confirmations) >= t.minConf)) return 'unknown';
        return 'verified';
    }
    // The transaction is on DOGE and carries attested anchors, none of which is this
    // reward: a positively-detected mis-bind. Every node sees the same rows, so this is
    // a deterministic permanent reject. If it carried no attested anchor at all we
    // cannot tell a forge from an un-decoded row, so that stays 'unknown'.
    return sawAttested ? 'rejected' : 'unknown';
}

module.exports = {
    ATTESTED_VERSIONS, REWARD_FAMILY_VERSIONS, NODE_CLASS_DEPENDENT_STATUS,
    rewardFamily, isRewardCandidateRow, bundleHeaderBlocks, bindsToTuple, judgeAnchors
};
