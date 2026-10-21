/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 **********************************************************************
 *
 * XChain Platform - bridge escrow proof transport: choosing the checkpoint.
 *
 * The first of the two obligations this module discharges for bridge_checkpoint_check.js:
 * select the checkpoint DETERMINISTICALLY, and hand over only one whose own quorum this node
 * has established. The canonical rebuild and the re-verification that establishes a mirrored
 * row sit here with the selection they serve.
 *
 ********************************************************************/

'use strict';

const ed25519 = require('../ed25519.js');
const swq     = require('../stake_weighted_quorum.js');
const eq      = require('../equivocation_header.js');
const gateRegistry = require('../gate_registry');
const { anchorMatched } = require('../bridge_checkpoint_check/anchor_match.js');

// The ANCHOR wire version that carries a checkpoint SECTION in its own right. Version 1 is the
// archive head, which carries its WRAPPER checkpoint's identity rather than being one, and
// version 2 is a continuation chunk with no identity at all. Kept as a local constant rather
// than imported from anchor_action_query.js's CHECKPOINT_VERSIONS, which deliberately admits
// the archive head for the getanchoraction read: an archive head's state_root columns are NULL
// (see sql/anchor_actions.sql), so admitting it here would select a rootless "checkpoint" that
// fails CHECKPOINT_ROOTLESS and turn a provable transfer into a refusal.
const ANCHOR_SECTION_VERSION = 0;

// From BRIDGE_CHECKPOINT_V3_SECTION_ACTIVATION, read at the settling chain's own block, the pick
// also reads the chain-bearing sections of a post-fold v3 action, which carry their own
// checkpoint identity and state_root exactly as a v0 section does. Below it only v0 is read, as
// before. Defined here and not by CHECKPOINT_SECTION_VERSIONS in db/anchor_sql.js, which also
// feeds getanchoraction and so must not move with this gate.
const V3_SECTION_KEY      = 'bridge_checkpoint_v3_section_activation.BRIDGE_CHECKPOINT_V3_SECTION_ACTIVATION';
const ANCHOR_SECTION_VERSION_V3 = 3;

// The section version (a number) or versions (a list) the anchor read binds for this block.
function sectionVersions(ctx){
    const on = !!ctx && typeof ctx === 'object' &&
               gateRegistry.activeAt(V3_SECTION_KEY, ctx.network, ctx.coin, ctx.blockIndex, null);
    return on ? [ANCHOR_SECTION_VERSION, ANCHOR_SECTION_VERSION_V3] : ANCHOR_SECTION_VERSION;
}

// A finite non-negative integer, or null. Heights arrive from a MariaDB driver that may hand
// back a number, a string or a BigInt depending on its bigint options.
function height(v){
    if(v === null || v === undefined) return null;
    if(typeof v === 'bigint') return (v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(v) : null;
    const n = Number(v);
    return (Number.isFinite(n) && Number.isInteger(n) && n >= 0) ? n : null;
}

/**
 * Rebuild the XCHECKPOINT v0 canonical for a mirrored state_checkpoints row. One of seven
 * checkpoint-family copies: the hub's canonical_forms.js canonicalCheckpoint, the SDK's and
 * sync's checkpoint.js canonicalCheckpoint, the explorer's canonicalCheckpointString and
 * bin/recovery.js checkpointCanonical (pinned to this copy by its own parity test) gate
 * the root suffix on CHECKPOINT_COMMITMENT at snapshot_block; this file and actions/anchor
 * `canonical` (FORMAT 0) append it UNCONDITIONALLY. The archive family (actions/anchor FORMAT 1,
 * bin/recovery.js wrapperCanonical, the hub's archiveCanonical) is rootless and separate.
 *
 * The unconditional append is the safety property, not a parity accident: the row's roots are
 * what selectCheckpoint hands the escrow check. Below the flag day the hub signs the rootless
 * form, so a gated rebuild would pass those signatures and adopt roots no quorum signed; this
 * form fails them instead, and the pick moves to a later root-committing checkpoint. At and
 * above the flag day every root-bearing row rebuilds the gated bytes exactly.
 *
 * @param {Object} cp - a state_checkpoints row
 * @returns {string}
 */
function checkpointCanonical(cp){
    let base = ['XCHECKPOINT', cp.chain, cp.network, String(cp.block_index), cp.block_hash,
                cp.ledger_hash, cp.actions_hash, cp.contract_hash,
                String(cp.checkpoint_seq), String(cp.snapshot_block)].join('|');
    base += '|' + [String(cp.state_root || '').toLowerCase(), String(cp.state_root_version),
                   String(cp.block_merkle_root || '').toLowerCase(), String(cp.block_merkle_version)].join('|');
    const roundId = cp.chain + '|' + cp.network + '|' + cp.block_index + '|' + cp.checkpoint_seq;
    if(eq.isEquivHeaderActive(cp.snapshot_block, cp.network))
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, roundId, 0, base);
    return base;
}

/**
 * Re-verify a mirrored checkpoint's own quorum against the capability snapshot at ITS OWN
 * snapshot_block. The CROSS_SETTLE rule verbatim, on the `oracle_publish` capability (the set
 * that signs checkpoints, not the `cross_chain` set that signs transfers): a signature counts
 * only if its pubkey is in the set AND verifies, a pubkey enters the seen-set only AFTER its
 * signature verifies, stake-weighted source-deduped two-thirds at or above
 * STAKE_WEIGHTED_QUORUM_ACTIVATION and 2f+1 below it.
 *
 * An ABSENT capability snapshot returns false, which drops the row from the candidate set and
 * therefore STALLS rather than refuses. That direction matters: treating an unreadable roster
 * as a pass would hand bridge_checkpoint_check an unverified root.
 *
 * @param {Object} cp - a state_checkpoints row
 * @param {Object} indexerDb
 * @returns {Promise<boolean>}
 */
async function verifyCheckpointQuorum(cp, indexerDb){
    const snapshotBlock = height(cp.snapshot_block);
    if(snapshotBlock === null) return false;
    const weighted = swq.isStakeWeightedQuorumActive(snapshotBlock, cp.network);
    const validators = weighted
        ? await indexerDb.getStakeWeightsByCapability('oracle_publish', snapshotBlock)
        : await indexerDb.getValidatorsByCapability('oracle_publish', snapshotBlock);
    const N = (validators && validators.length) ? validators.length : 0;
    if(N === 0) return false;

    let sigs;
    try { sigs = JSON.parse(cp.validator_signatures || '[]'); }
    catch(_){ sigs = []; }
    if(!Array.isArray(sigs)) return false;

    const canonical   = checkpointCanonical(cp);
    const snapPubkeys = new Set(validators.map(v => String(v.pubkey).toLowerCase()));
    const validSigners = [], seen = new Set();
    for(const s of sigs){
        const pk  = String((s && s.pubkey) || '').toLowerCase();
        const sig = String((s && s.sig) || '').toLowerCase();
        if(seen.has(pk)) continue;
        if(!/^[0-9a-f]{64}$/.test(pk) || !/^[0-9a-f]{128}$/.test(sig)) continue;
        if(!snapPubkeys.has(pk)) continue;
        if(!ed25519.verify(canonical, sig, pk)) continue;
        seen.add(pk);
        validSigners.push(pk);
    }
    return weighted
        ? swq.meetsStakeThreshold(validators, validSigners)
        : (validSigners.length >= ((N <= 1) ? 1 : Math.max(2 * Math.floor((N - 1) / 3) + 1, Math.ceil((N + 1) / 2))));
}

/**
 * Select the checkpoint this transfer is proven against, deterministically.
 *
 * THE RULE, and it is the one bridge_checkpoint_check.js's header names: the FIRST checkpoint
 * at or after row.snapshot_block for (row.src_chain, row.network), and at that height the
 * HIGHEST checkpoint_seq. "First at or after" and not "latest": a later checkpoint would also
 * commit the escrow credit, but "latest" is a moving target that differs on every node at every
 * instant, and the whole point of the rule is that two nodes holding the same rows pick the
 * same one. The highest seq at that height is the append-only table's own latest-wins rule
 * (state_checkpoints readers take MAX(checkpoint_seq)), the tie-break when two rows name one
 * height. A reorg does not replace a signed row: the hub's round refuses a second payload at a
 * seq it already signed (xchain-hub src/anchor/checkpoint_engine/round.js claimSeqSignature).
 * After a rollback the federation signs NEW rows over the chain it now follows: on LTC and DOGE
 * those can land at heights below the old rows (not necessarily the old height itself), while
 * on BTC the cadence latch puts them above. Either way the old row's root stays on no honest
 * node, and when the new rows are not below the transfer's snapshot_block this rule still takes
 * the old row, because it takes the FIRST at or after snapshot_block. The origin's
 * getbridgeescrowproof read is what bounds that case (db/credits/escrow_divergence.js
 * divergenceSettled, or checkpointStreamStopped once the hub stops signing).
 *
 * THE AXIS. For a DOGE or LTC origin from BRIDGE_ESCROW_ANCHOR_MATCH_ACTIVATION, read at the
 * settling chain's own block, the same rule runs on the BTC anchor axis: the first checkpoint
 * whose snapshot_block is STRICTLY above row.snapshot_block, highest checkpoint_seq at that
 * snapshot_block. row.snapshot_block is a BTC height, so comparing it to a DOGE or LTC
 * block_index selected the oldest checkpoint held, from before the lock. Why strictly above
 * commits the lock is in bridge_checkpoint_check/anchor_match.js. A BTC origin, and every
 * origin below the activation, keeps the block_index rule exactly.
 *
 * Both sources are queried and the candidates are MERGED before the pick, rather than one
 * being preferred: a node that holds the anchor for height 105 and a mirrored row for 102 must
 * select 102, the same as a node that holds only the mirror, or "which source do I have" would
 * silently become an input to a consensus-visible verdict.
 *
 * @param {Object} row - the bridge_transfers row about to be applied
 * @param {Object} ctx - the settle-pass context { indexerDb, ... }
 * @returns {Promise<Object|null>} the checkpoint envelope member
 *          { chain, network, block_index, checkpoint_seq, snapshot_block, state_root,
 *            state_root_version, source }, or null when none is held locally (STALL)
 * @throws {Error} any source read fault, unchanged, so the block is retried rather than decided
 */
async function selectCheckpoint(row, ctx){
    const chain     = String(row.src_chain || '');
    const network   = String(row.network || '');
    const atOrAfter = height(row.snapshot_block);
    if(!chain || !network || atOrAfter === null) return null;

    const db = ctx.indexerDb;
    const candidates = [];
    const onAnchor = anchorMatched(chain, ctx);

    // Source 1: locally parsed ANCHOR v0 sections whose quorum this node verified at parse
    // time. status 'valid' ONLY: 'unverified' means this node had no capability snapshot and
    // stored the row without checking a signature, which is exactly the unverified checkpoint
    // the check must never be handed.
    // Only a SUCCESSFUL empty read is an absence, which stalls. A read fault propagates, the
    // block is not committed and is retried, so a fault on one source never shrinks the
    // candidate set into a pick a healthy peer holding the same rows would not make.
    const versions = sectionVersions(ctx);
    const anchors = onAnchor
        ? await db.getEarliestValidAnchorCheckpointAfterAnchor(versions, chain, network, atOrAfter)
        : await db.getEarliestValidAnchorCheckpoint(versions, chain, network, atOrAfter);
    for(const a of anchors)
        candidates.push({ chain: a.chain, network: a.network, block_index: height(a.block_index),
                          checkpoint_seq: height(a.checkpoint_seq), snapshot_block: height(a.snapshot_block),
                          state_root: a.state_root, state_root_version: a.state_root_version,
                          source: 'anchor_actions' });

    // Source 2: the hub-mirrored state_checkpoints copy, re-verified here. More than one row is
    // read because the LOWEST qualifying height is what the rule wants and a row at that height
    // may fail re-verification, in which case the next candidate up is the honest pick rather
    // than a stall. Bounded, because this runs inside the block loop. A read fault here
    // propagates for the same reason as Source 1's.
    const mirrored = onAnchor
        ? await db.getMirroredStateCheckpointCandidatesAfterAnchor(chain, network, atOrAfter)
        : await db.getMirroredStateCheckpointCandidates(chain, network, atOrAfter);
    for(const m of mirrored){
        if(!await verifyCheckpointQuorum(m, db)) continue;
        candidates.push({ chain: m.chain, network: m.network, block_index: height(m.block_index),
                          checkpoint_seq: height(m.checkpoint_seq), snapshot_block: height(m.snapshot_block),
                          state_root: m.state_root, state_root_version: m.state_root_version,
                          source: 'state_checkpoints' });
        // One verified mirrored candidate at the lowest qualifying height is all the rule can
        // use; the rows are already ordered, so the first that verifies is that height's pick.
        break;
    }

    const usable = candidates.filter(c => c.block_index !== null && c.checkpoint_seq !== null &&
                                          (!onAnchor || c.snapshot_block !== null));
    if(usable.length === 0) return null;
    if(onAnchor)
        usable.sort((a, b) => (a.snapshot_block - b.snapshot_block) || (b.checkpoint_seq - a.checkpoint_seq));
    else
        usable.sort((a, b) => (a.block_index - b.block_index) || (b.checkpoint_seq - a.checkpoint_seq));
    return usable[0];
}

module.exports = { ANCHOR_SECTION_VERSION, V3_SECTION_KEY, sectionVersions, height, checkpointCanonical, verifyCheckpointQuorum, selectCheckpoint };
