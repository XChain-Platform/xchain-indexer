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
 * ONE TRAIN WITH THE CLASS-6 HEIGHT-KEY REPAIR, ON MAINNET. This gate and
 * stateHash.js's ARCHIVE_INVALID_HEIGHT_KEY_ACTIVATION are both
 * preimage-moving consensus calls over the SAME invalid_archive stamp, so on
 * a network carrying history that no rebuild will replay, neither height is
 * chosen alone: they are pinned together at ratification (operator ruling
 * 2026-08-16). Both mainnet keys are INERT placeholders today. regtest is
 * armed at 0 so fresh regtest stacks exercise the widened gate end to end.
 *
 * WHY TESTNET IS 0 HERE AND ITS CLASS-6 SIBLING IS NOT. This key was armed at
 * genesis by the 2026-08-18 wave, one of six gates armed ahead of the testnet
 * reindex, whose stated precondition was a rebuild: that reindex replayed all
 * three testnet indexer and decoder DBs from chain under the armed rules
 * (2026-08-22), and the 2026-08-24
 * re-genesis then moved every testnet firstBlock forward again. So no testnet
 * block was ever indexed under the narrower valid-only rule, and a height of
 * 0 is a genesis rule here rather than a retroactive one. The class-6 sibling
 * was not in that wave and is still INERT on testnet as well as mainnet, so
 * the pinned-together rule above now binds MAINNET only. Testnet has been a
 * live public ledger since 2026-09-01: do not move this key.
 *
 * THE MAINNET ARMING IS RULED, NOT PENDING (operator ruling 2026-09-01). The
 * mainnet key stays INERT and takes a real height only from the post-launch
 * activation gate that a follow-up must write into the living
 * release-management spec as D4, which is still unwritten: it must name the
 * carrier, the publication path, and the behaviour of lagging nodes. Until D4
 * is ruled, do not pin a mainnet height here, and do not widen the head-side
 * gate on a ledger with history by any other route. The board that produced
 * that ruling asked the question as though the widening were still reverted.
 * It is not: it was re-landed behind this flag day on 2026-08-17, so what the
 * ruling governs is the mainnet arming, not whether the widened code exists.
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
// archive head landed in. Mainnet is the only INERT key; testnet and regtest are
// armed from genesis. Changing any value here is a consensus change: read the
// header block first.
const ARCHIVE_HEAD_UNVERIFIED_GATE_ACTIVATION = {
    // INERT placeholder. Pinned with the class-6 height-key repair at ratification, and
    // takes a height only from the post-launch activation gate a follow-up must define
    // as D4 (operator ruling 2026-09-01). No mainnet height until that gate exists.
    mainnet: 999999999,
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
