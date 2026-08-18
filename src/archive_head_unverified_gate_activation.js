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
 *
 * Head-side archive reassembly gate: 'unverified' heads flag-day.
 *
 * THE PROBLEM. actions/anchor.js runs the archive reassembly CRC check from
 * two sides. The chunk-side gate (in _parseContinuation) fires when the
 * completing v2 chunk lands after its parent head, and it keys on the
 * ARRIVING CHUNK's status, never the parent head's. The head-side gate (in
 * _parseCheckpoint) covers the opposite ordering, chunks first and the head
 * last, and it keyed on the HEAD's own status being 'valid'. On a node with
 * no mirrored oracle_publish snapshot every v1/v6 head is stored
 * 'unverified' (oracleN === 0), so on exactly those nodes a chunks-last
 * arrival ran the CRC check and a head-last arrival skipped it: the ordering
 * nondeterminism the head-side gate exists to close, still open.
 *
 * WHY IT IS NOT A FREE FIX. Widening the head-side gate to admit
 * 'unverified' is preimage-moving, and it does NOT move the two node classes
 * together. anchor.js gives a MIRRORED node (one that HAS the snapshot) a
 * third outcome on the same head: quorum failure sets
 * error = 'invalid: insufficient signer stake' / 'insufficient valid
 * signatures', on which the head-side gate never runs at all and no
 * invalid_archive stamp lands. A snapshot-less node computes 'unverified'
 * with error null for that same head, so post-widening it DOES stamp. The
 * two classes agreed before the widening and disagree after, in the one
 * status that has a state-hash projection (stateHash.js class 6,
 * anchor_invalid), on every network where ARCHIVE_INVALID_STATE_HASH_ACTIVATION
 * is already armed. A straggler then recomputes a different preimage and
 * halts. An earlier landing of this widening shipped a comment asserting it
 * was "safe without a flag day"; that safety property is false, and it is
 * recorded here so it is not re-derived.
 *
 * THE FIX. The widening ships like every other preimage-moving change in
 * this repo: default INERT behind a per-network activation height, so below
 * the threshold the head-side gate keeps its deployed 'valid'-only rule and
 * replay is byte-identical. At/above it every node admits an 'unverified'
 * head, and the divergence above becomes a coordinated flag day rather than
 * a silent fork.
 *
 * ONE TRAIN WITH THE CLASS-6 HEIGHT-KEY REPAIR. This gate and
 * stateHash.js's ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION are both
 * preimage-moving consensus calls over the SAME invalid_archive stamp, so
 * neither height is chosen alone: they are pinned together at ratification
 * (operator ruling 2026-08-16). Every mainnet AND testnet key here is an
 * INERT placeholder on purpose, matching that sibling exactly. Testnet is
 * NOT armed at genesis the way the older publisher-scoped and v6-coverage
 * gates were: those rulings were made at the testnet re-genesis, and testnet
 * has run for a week since, so a height of 0 here would be retroactive
 * rather than a flag day. regtest is armed at 0 so fresh regtest stacks
 * exercise the widened gate end to end.
 *
 * KEYED ON THE HEAD'S OWN DOGE BLOCK INDEX (anchor_actions.block_index_doge,
 * i.e. data['BLOCK_INDEX'] at parse time), per network, never on
 * BLOCK_INDEX_CHECKPOINTED (a different chain's height entirely) and never
 * on SNAPSHOT_BLOCK like the anchor-reward family: the row being judged is
 * the head itself, and its own landing height is the one value every node
 * resolves identically without consulting status. No per-chain keys: ANCHOR
 * is valid only on DOGE.
 *
 ********************************************************************/

'use strict';

// Per-network activation, interpreted against the DOGE block_index the v1/v6
// archive head landed in. Mainnet and testnet are INERT placeholders pinned on
// the same flag-day train as ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION; regtest is
// armed from genesis.
const ARCHIVE_HEAD_UNVERIFIED_GATE_ACTIVATION = {
    mainnet: 999999999,   // INERT placeholder; pinned with the class-6 height-key repair at ratification
    testnet: 999999999,   // INERT placeholder; arming it at 0 would be retroactive, not a flag day
    regtest: 0,           // armed from genesis: fresh regtest stacks exercise the widened gate end to end
};

// Whether the head-side archive reassembly gate admits an 'unverified' head for
// a head that landed at DOGE height `blockIndex` on `network`. A non-numeric
// height or an unknown network -> false (the deployed 'valid'-only rule stands,
// preimage unchanged).
function isArchiveHeadUnverifiedGateActive(blockIndex, network){
    let b = parseInt(blockIndex);
    if(!Number.isFinite(b)) return false;
    let threshold = ARCHIVE_HEAD_UNVERIFIED_GATE_ACTIVATION[network];
    if(threshold === undefined) return false;
    return b >= threshold;
}

module.exports = {
    ARCHIVE_HEAD_UNVERIFIED_GATE_ACTIVATION,
    isArchiveHeadUnverifiedGateActive
};
