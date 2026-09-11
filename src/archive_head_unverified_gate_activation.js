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
 * no mirrored oracle_publish snapshot every v1 head is stored
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
 * ONE TRAIN WITH THE CLASS-6 HEIGHT-KEY REPAIR, ON MAINNET. This gate and
 * stateHash.js's ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION are both
 * preimage-moving consensus calls over the SAME invalid_archive stamp, so
 * neither mainnet key is ever moved alone: they are pinned together (operator
 * ruling 2026-08-16), and the 2026-09-09 ruling arms both at genesis in one
 * wave. regtest is armed at 0 so fresh regtest stacks exercise the widened gate
 * end to end.
 *
 * MAINNET IS ARMED AT GENESIS (operator ruling 2026-09-09). The indexed mainnet
 * history carries 0 archive chunks (measured 2026-09-09), so there is no
 * invalid_archive stamp for the widened head-side gate to move and the mirrored
 * and snapshot-less node classes cannot already have diverged: the widening is
 * the identity function over every mainnet block committed so far. The proof is
 * a per-chain OLD-vs-ON replay witness, not this comment.
 *
 * WHY TESTNET IS 0 HERE AND ITS CLASS-6 SIBLING IS NOT. This key was armed at
 * genesis by the 2026-08-18 wave, one of six gates armed ahead of the testnet
 * reindex, whose stated precondition was a rebuild: that reindex replayed all
 * three testnet indexer and decoder DBs from chain under the armed rules
 * (2026-08-22), and the 2026-08-24
 * re-genesis then moved every testnet firstBlock forward again. So no testnet
 * block was ever indexed under the narrower valid-only rule, and a height of
 * 0 is a genesis rule here rather than a retroactive one. The class-6 sibling
 * was not in that wave, so on testnet it cannot take 0 and is sized to a future
 * height instead. Testnet has been a live public ledger since 2026-09-01: do
 * not move this key.
 *
 * THE 2026-09-01 RULING IS SUPERSEDED FOR THIS KEY. That ruling held the
 * mainnet arming for a post-launch activation gate (D4 in the living
 * release-management spec) that would name a carrier, a publication path and
 * the behaviour of lagging nodes. The 2026-09-09 ruling supplies what D4 was
 * to protect: a gate that is identity on the indexed history has no divergence
 * to sequence, so there is no cutover for a lagging node to miss. What the
 * 2026-09-01 ruling governed was the arming, never whether the widened code
 * exists; that landed behind this flag day on 2026-08-17.
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

// Per-network activation, interpreted against the DOGE block_index the v1
// archive head landed in. Every network is armed from genesis. Changing any value
// here is a consensus change: read the header block first.
const ARCHIVE_HEAD_UNVERIFIED_GATE_ACTIVATION = {
    // ARMED at genesis by the 2026-09-09 ruling: identity on the indexed mainnet history
    // (0 archive chunks, measured 2026-09-09). Pinned at genesis in the same wave as the
    // class-6 height-key repair, which this key is never moved apart from.
    mainnet: 0,
    // Armed from genesis. Safe on a chain with history ONLY where that chain's indexer
    // state is rebuilt from the chain itself, because a rebuild recomputes every block
    // under this rule and so leaves nothing indexed under the narrower one to contradict.
    // That rebuild is a precondition of this height, not a consequence of it.
    testnet: 0,
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
