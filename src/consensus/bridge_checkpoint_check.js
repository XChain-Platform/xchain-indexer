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
 *
 * XChain Platform - the escrow cross-check against the anchored state checkpoint.
 *
 * WHAT THIS IS. The trust boundary of the bridge. Without it the bridge is a hub-trusted mint: off
 * the origin chain the hub supplies BOTH the transfer record and the capability roster
 * that verifies it, so a compromised hub can mint on the destination with nothing held in
 * escrow on the origin. This module makes the destination indexer prove, before it mints,
 * that the origin chain's own quorum-signed state checkpoint agrees that the escrow holds
 * at least what is about to be minted. That reduces the assumption to "the cross_chain
 * quorum AND the checkpoint quorum both lied", the assumption the cross-chain DEX and every
 * validator action already rest on. Nothing arms on mainnet before this is built.
 * The two rules below fix how the proof travels and what it proves.
 *
 * THE PROOF IS TRANSPORT, NEVER A CANONICAL FIELD. It arrives in ctx.proof, fetched
 * beside the row or by the indexer itself, and is no part of the signed content canonical.
 * That is exactly what lets this cross-check arm without changing one canonical or invalidating one
 * signature: every canonical field is a byte-match obligation forever. Nothing in here
 * reads or writes a signed field, and nothing in here is signed.
 *
 * WHY A BALANCE PROOF AND NOT A NEW COMMITMENT. The escrow is an ordinary balance at
 * ADDRESS.BRIDGE_<dest_chain> on the origin chain, so it already rides balances_root, which
 * already rides the state_root the checkpoint quorum signs. No new subtree, no new hash
 * input, no flag day for the commitment itself.
 *
 * THE CHAIN OF BINDINGS this module checks, each one of which a forgery has to break:
 *   1. the leg is an IN leg (this chain is dest_chain), derived from the row, never a column
 *   2. the proof names THIS transfer's chain, network, tick and the escrow address this
 *      module resolves itself from the origin chain's coin config (never the envelope's)
 *   3. the checkpoint is for the origin chain and network, and is at or after snapshot_block
 *   4. the checkpoint's state_root_version is the version this node DERIVES at that
 *      checkpoint's own height for that chain and network, the way the fleet mints it
 *   5. the sub-roots in the envelope reassemble EXACTLY to the checkpoint's state_root
 *   6. the balance leaf this module derives from the claimed balance is proven under
 *      balances_root at the key this module derives
 *   7. the proven balance is at least the transfer amount
 * A proof that is absent, stale, malformed or fails any binding returns ok:false and the
 * row applies nothing.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO, and whose job it is. It does not verify the
 * checkpoint's own validator signatures, and it does not choose the checkpoint. Both are the
 * CALLER's obligation and both are load-bearing:
 *   - the caller must pass a checkpoint it has already established as quorum-signed: an
 *     anchor_actions row parsed from an on-chain ANCHOR v0 bundle with status 'valid' (the
 *     strongest source, because the local handler verified the quorum at parse time from
 *     chain data), or a mirrored state_checkpoints row re-verified against the capability
 *     snapshot at the checkpoint's own snapshot_block. Handing this module an unverified
 *     checkpoint makes the cross-check vacuous, because a hub that can forge the transfer
 *     can then forge the root it is proven against.
 *   - the caller must select the checkpoint DETERMINISTICALLY: the first checkpoint at or
 *     after row.snapshot_block for (row.src_chain, row.network), highest checkpoint_seq at
 *     that height. Two nodes that pick different checkpoints, or that differ on whether one
 *     is present yet, produce different verdicts for the same row at the same height, and a
 *     verdict that decides whether an action index is assigned is consensus-visible. A
 *     checkpoint not yet held locally must therefore stall the pass, the way
 *     waitForSnapshotSync already stalls it for the roster, and never read as "refuse".
 * Keeping the signature rule out of here also keeps a further XCHECKPOINT canonical copy out
 * of this module. The caller's copy for mirrored rows is bridge_proof_client/checkpoint_source.js
 * checkpointCanonical, whose header lists the other copies it must stay byte-matched with.
 *
 ********************************************************************/

'use strict';

// The check is a chain of BINDINGS, one phase per link, in bridge_checkpoint_check/bindings.js.
// This file is the door the settle pass calls and the order the links are applied in; it holds
// no rule of its own, so a link can be read, tested and falsified on its own without the reader
// having to hold the whole ladder in their head.
const { ESCROW_ROLE_PREFIX, ESCROW_CHAIN, ESCROW_PROOF_REASON } = require('./bridge_checkpoint_check/reasons.js');
const { resolveEscrowAddress } = require('./bridge_checkpoint_check/escrow_address.js');
const bind = require('./bridge_checkpoint_check/bindings.js');

/**
 * THE ESCROW CROSS-CHECK HOOK. Prove the origin-chain escrow behind a transfer against the state checkpoint
 * the origin chain's quorum signed, before this chain mints.
 *
 * Synchronous and pure by design: everything it needs is the row plus the envelope the
 * caller fetched beside it, so the check itself performs no I/O and cannot make two nodes
 * disagree because one of them had a slower database.
 *
 * ctx.proof envelope, which is TRANSPORT and mirrors what a producer reads straight out of
 * its own state_tree_roots and checkpoint tables:
 *   {
 *     chain, network,            the origin chain and network the roots belong to
 *     block_index,               the origin height the roots commit
 *     sub_roots: {               every named sub-root committed at that height; an absent
 *       balances_root,           or empty slot is the empty-SMT root, exactly as the
 *       stakes_root, ...         producer's assembly treats it
 *     },
 *     address, tick, balance,    the escrow balance being claimed, as a decimal string
 *     balance_proof: {           an SMT proof under balances_root: either the 256 explicit
 *       siblings | compressed    siblings or the compressed wire form. leaf_value in the
 *     },                         envelope is IGNORED; the leaf is derived from `balance`
 *     checkpoint: {              the quorum-signed checkpoint the caller already verified
 *       chain, network, block_index, checkpoint_seq, snapshot_block,
 *       state_root, state_root_version   as SIGNED, so the version is the one the origin
 *     }                                  chain derived at block_index, not a static constant
 *   }
 *
 * OBLIGATION ON WHOEVER BUILDS THE PRODUCER, and it is not optional. `sub_roots` must carry
 * EVERY sub-root the checkpoint's own version commits, because the binding here is a full
 * reassembly to the signed state_root. A version-2 chain with real contract state commits a
 * non-empty contract_state_root, so an envelope carrying only the v1 pair reassembles to a
 * different root and the transfer is refused. The indexer's `state_tree_roots` row holds all
 * of them, so a producer reading beside the row satisfies this for free; the explorer's
 * public SPV endpoint does NOT, since it serves balances_root and stakes_root plus a
 * `sub_root_path` proving balances_root under state_root, which is a different binding and
 * a different envelope shape (`height`, `amount`, `smt_proof`). Mapping that surface onto
 * this one is the proof client's job, and dropping slots on the way is a silent refusal.
 *
 * @param {Object} row - the bridge_transfers row about to be applied
 * @param {Object} ctx - pass context { actions, indexerDb, util, config, coin, network,
 *                       blockIndex, blockTime }, plus { proof } when the caller fetched one
 * @returns {{ok: boolean, reason: string}} ok false applies nothing and is what the single
 *          log line naming the transfer_id reports
 */
function verifyEscrowAgainstCheckpoint(row, ctx){
    const leg = bind.screenLeg(row, ctx);
    if(leg.verdict) return leg.verdict;
    const f = leg.fields;

    const checkpoint = bind.bindCheckpoint(ctx.proof, f);
    if(checkpoint.verdict) return checkpoint.verdict;

    const envelope = bind.bindEnvelope(ctx.proof, f, checkpoint.cpHeight);
    if(envelope.verdict) return envelope.verdict;

    const rooted = bind.bindRootVersion(checkpoint.cp, f, checkpoint.cpHeight);
    if(rooted.verdict) return rooted.verdict;

    const assembled = bind.reassembleStateRoot(ctx.proof, rooted.cpRoot);
    if(assembled.verdict) return assembled.verdict;

    const claim = bind.deriveClaimedLeaf(ctx.proof, f, envelope.escrow);
    if(claim.verdict) return claim.verdict;

    return bind.verifyProvenBalance(ctx.proof, f, assembled.balancesRoot, claim);
}

module.exports = {
    verifyEscrowAgainstCheckpoint,
    resolveEscrowAddress,
    ESCROW_PROOF_REASON,
    ESCROW_ROLE_PREFIX,
    ESCROW_CHAIN,
};
