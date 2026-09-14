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
 * XChain Platform - bridge escrow proof TRANSPORT: the client half of the escrow cross-check.
 *
 * WHAT THIS IS. bridge_checkpoint_check.js proves an origin-chain escrow balance against a
 * quorum-signed state checkpoint, and is deliberately synchronous and pure: it chooses no
 * checkpoint and performs no I/O. This module is the half that does both, and its header
 * names the two obligations it discharges on that module's behalf:
 *
 *   1. SELECT THE CHECKPOINT DETERMINISTICALLY. The first checkpoint at or after
 *      row.snapshot_block for (row.src_chain, row.network), highest checkpoint_seq at that
 *      height. Two nodes that pick different checkpoints, or that differ on whether one is
 *      present yet, produce different verdicts for the same row at the same height, and a
 *      verdict that decides whether an action index is assigned is consensus-visible.
 *   2. HAND OVER ONLY A QUORUM-ESTABLISHED CHECKPOINT. Two sources qualify, and each is
 *      already quorum-established before it reaches the selector:
 *        - a locally parsed `anchor_actions` v0 bundle SECTION with status 'valid'. The
 *          strongest source: actions/anchor.js verified the oracle_publish quorum at parse
 *          time, from chain data this node parsed itself.
 *        - a mirrored `state_checkpoints` row RE-VERIFIED here against the capability
 *          snapshot at that checkpoint's own snapshot_block. The mirror is untrusted, so a
 *          row that has not been re-verified is not a candidate at all: a hub that can forge
 *          the transfer could otherwise forge the root it is proven against, and the whole
 *          cross-check would be vacuous.
 *
 * A CHECKPOINT NOT YET HELD LOCALLY STALLS THE PASS, and that is the third obligation. It is
 * NOT a refusal: a refusal is a consensus verdict ("this row never applies here"), while
 * "my mirror has not caught up" is a property of one node's network. Refusing on absence
 * would let a node that is merely behind decide, permanently, that a legitimate transfer is
 * forged. So every absence, every unreachable endpoint and every malformed answer raises
 * BridgeProofUnavailableError, which the block loop turns into a DEFERRED BLOCK under the
 * stall reason BRIDGE_PROOF_BARRIER, beside waitForBridgeSync. The node retries the same
 * block until the proof is obtainable; it never advances past it on a guess.
 *
 * RESIDUAL NON-DETERMINISM, STATED RATHER THAN HIDDEN. Two nodes can hold DIFFERENT
 * checkpoint sets above row.snapshot_block, so one may select height 102 where the other
 * selects 105. Both are quorum-signed commitments of the same chain and both prove the same
 * escrow balance, so both verdicts are ok:true and the applied effect is identical. The
 * selection rule removes the case that actually forks: two nodes holding the SAME set never
 * pick differently, and a node holding NO qualifying checkpoint stalls instead of deciding.
 *
 * THE PROOF IS TRANSPORT, NEVER A CANONICAL FIELD. Nothing in here is signed, nothing
 * in here is written, and nothing in here reads or writes a signed field.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../observability/index.js');
const { CONFIG_ENV } = require('../config.js');
// The parts of the transport. The wire, the stall vocabulary and the checkpoint selection each
// keep their own file; what stays here is the envelope this module hands to the check, which is
// the only thing a caller of bridge_proof_client.js is asking for.
const { resolveOriginEndpoint, rpc } = require('./bridge_proof_client/transport.js');
const { BRIDGE_PROOF_BARRIER, PROOF_STALL_REASON,
        BridgeProofUnavailableError } = require('./bridge_proof_client/stall.js');
const { ANCHOR_SECTION_VERSION, checkpointCanonical,
        verifyCheckpointQuorum, selectCheckpoint } = require('./bridge_proof_client/checkpoint_source.js');

/**
 * Ask the ORIGIN chain's indexer for the escrow balance proof at the selected checkpoint's
 * height, and assemble the envelope bridge_checkpoint_check.js reads.
 *
 * The checkpoint member is attached HERE, from the checkpoint this node selected and
 * established itself. It is never taken from the served payload: a served checkpoint would let
 * whoever answers the RPC choose the root its own proof is measured against, which is the
 * forgery the whole cross-check exists to stop. The handler does serve one of its own, and
 * overwriting it is deliberate even though the two normally agree, because "normally" is not a
 * security property. It also serves its state_root_version STAMPED rather than re-derived, and
 * the replacement keeps that property: the version below is the one carried on the checkpoint
 * row this node selected, so the check's derived-versus-stamped comparison stays a real
 * binding instead of comparing a number to itself.
 *
 * @param {Object} row - the bridge_transfers row
 * @param {Object} ctx - the settle-pass context { config, indexerDb, ... }
 * @param {Object} checkpoint - the selection from selectCheckpoint
 * @param {string} escrowAddress - the escrow address this node resolved from the ORIGIN
 *                                 chain's own coin config (never the envelope's)
 * @returns {Promise<Object|null>} the proof envelope, or null when the answer is unusable
 */
async function fetchEscrowProof(row, ctx, checkpoint, escrowAddress){
    const endpoint = resolveOriginEndpoint(row.src_chain, ctx.config);
    if(!endpoint.url) return null;
    const timeoutMs = parseInt(CONFIG_ENV.BRIDGE_PROOF_TIMEOUT_MS || '15000', 10);

    // THE HEIGHT IS THE CHECKPOINT'S OWN, never row.snapshot_block and never a tip. The handler
    // builds its answer at the exact height given: it reads state_tree_roots there and proves
    // the key against that block's balances_root, so any other height would prove a balance the
    // selected checkpoint's state_root does not commit. It reads only {address, tick,
    // block_index}; `chain` and `network` ride along as intent, and are ignored there because
    // an indexer serves exactly one pair.
    let result = null;
    try {
        result = await rpc(endpoint, 'getbridgeescrowproof', {
            chain:       String(row.src_chain),
            network:     String(row.network),
            block_index: checkpoint.block_index,
            address:     escrowAddress,
            tick:        String(row.tick)
        }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000);
    } catch(e){
        getLogger().warn('\t XBRIDGE : getbridgeescrowproof unreachable on ' + row.src_chain + ': ' + (e && e.message));
        return null;
    }
    // An {error} answer is the handler saying it cannot PROVE the key at that height: no
    // checkpoint there, or state_tree_nodes pruned below retention. Both are properties of that
    // node's storage and not of the transfer, so both return null here and reach the caller as a
    // STALL. Reading either as a refusal would let one origin node's pruning decide, for this
    // whole chain, that a legitimate transfer is forged.
    if(!result || typeof result !== 'object' || result.error) return null;

    // sub_roots must arrive COMPLETE: the binding inside the check is a full reassembly to the
    // signed state_root, so a served payload that dropped a slot reassembles to a different
    // root and reads as a forgery. Nothing is filled in or defaulted here; a missing slot is
    // left missing and the check refuses, which is the visible failure the header asks for.
    const subRoots = result.sub_roots || result.subRoots;
    if(!subRoots || typeof subRoots !== 'object') return null;

    return {
        chain:         String(row.src_chain),
        network:       String(row.network),
        block_index:   checkpoint.block_index,
        sub_roots:     subRoots,
        address:       escrowAddress,
        tick:          String(row.tick),
        balance:       result.balance,
        balance_proof: result.balance_proof || result.balanceProof,
        checkpoint: {
            chain:              checkpoint.chain,
            network:            checkpoint.network,
            block_index:        checkpoint.block_index,
            checkpoint_seq:     checkpoint.checkpoint_seq,
            snapshot_block:     checkpoint.snapshot_block,
            state_root:         checkpoint.state_root,
            state_root_version: checkpoint.state_root_version
        }
    };
}

/**
 * Build the proof envelope for one transfer, or STALL.
 *
 * Every failure here raises BridgeProofUnavailableError. There is no path that returns "no
 * proof, refuse the row": see the header. The caller is expected to let the error escape the
 * pass so the block loop defers the block under BRIDGE_PROOF_BARRIER.
 *
 * @param {Object} row - the bridge_transfers row about to be applied
 * @param {Object} ctx - the settle-pass context { config, indexerDb, ... }
 * @param {string} escrowAddress - the escrow address resolved from the ORIGIN chain's config
 * @returns {Promise<Object>} the envelope for ctx.proof
 * @throws {BridgeProofUnavailableError}
 */
async function buildEscrowProof(row, ctx, escrowAddress){
    const checkpoint = await selectCheckpoint(row, ctx);
    if(!checkpoint)
        throw new BridgeProofUnavailableError(row.transfer_id, PROOF_STALL_REASON.NO_CHECKPOINT);

    const endpoint = resolveOriginEndpoint(row.src_chain, ctx.config);
    if(!endpoint.url)
        throw new BridgeProofUnavailableError(row.transfer_id, PROOF_STALL_REASON.NO_ENDPOINT);

    const proof = await fetchEscrowProof(row, ctx, checkpoint, escrowAddress);
    if(!proof)
        throw new BridgeProofUnavailableError(row.transfer_id, PROOF_STALL_REASON.UNREACHABLE);
    return proof;
}

module.exports = {
    buildEscrowProof,
    selectCheckpoint,
    fetchEscrowProof,
    verifyCheckpointQuorum,
    checkpointCanonical,
    resolveOriginEndpoint,
    BridgeProofUnavailableError,
    BRIDGE_PROOF_BARRIER,
    PROOF_STALL_REASON,
    ANCHOR_SECTION_VERSION,
};
