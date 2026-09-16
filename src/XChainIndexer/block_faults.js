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
 * XChain Indexer - Block faults
 *
 * Naming the fault that ended a block. A host or proof fault this node cannot resolve
 * from here (the VM executor, a DOGE anchor proof, a bridge escrow proof, a ROLLCALL
 * epoch) sets its stall reason and halts or defers loudly; anything else is logged as a
 * block error. Installed onto XChainIndexer.prototype by ../XChainIndexer.js.
 *
 ********************************************************************/

const { getLogger } = require('../observability/index.js');

module.exports = {

    // Name the fault that ended a block: a host or proof fault sets its stall reason and
    // is logged loudly; anything else is logged as a block error.
    noteBlockFault(error, lastIndexerBlock){
        if(this.noteExecutorOrAnchorFault(error, lastIndexerBlock)) return;
        if(this.noteBridgeOrRollcallFault(error, lastIndexerBlock)) return;
        // Log the error
        this.util.logError(`Error while parsing block data at block ${lastIndexerBlock}:`, error);
    },

    // The VM executor or a DOGE anchor proof is unavailable from HERE. Returns true when
    // the fault was one of these two.
    noteExecutorOrAnchorFault(error, lastIndexerBlock){
        // Host fault (out-of-process VM executor cannot run a contract on THIS
        // machine: fork EAGAIN, isolated-vm load failure). This is NOT a contract
        // outcome. Committing a fabricated out_of_resource for work the fleet runs
        // normally would diverge this node's contract_hash and fork it off the chain.
        // So we HALT (do not advance) rather than fabricate: the block is left
        // uncommitted and retried below. A transient fault self-heals on the next
        // retry (the executor probes a fresh worker); a persistent one keeps the
        // indexer halted + alerting until the operator fixes the host. The block
        // watchdog surfaces the stall (no silent freeze).
        if(error && error.code === 'EXECUTOR_UNAVAILABLE'){
            getLogger().error(`HOST FAULT at block ${lastIndexerBlock}: VM executor unavailable. ` +
                `HALTING block processing (not committing; a fabricated result would fork). ` +
                `Retrying after ${this.config['BLOCK_CHECK_INTERVAL']}ms; will resume when the host recovers.`);
            this.stallReason = 'vm_executor_unavailable';
            this.stallClearsAt = null;          // a host fault has no deadline
            return true;
        }
        if(error && error.name === 'AnchorProofUnavailableError'){
            // A matured anchor reward could not be proven mined on DOGE from HERE.
            // Not a contract or host outcome: deriving it unproven would pay for an
            // anchor that may never have landed, and skipping it would make this
            // node's reward set differ from its peers' at a height they all agree
            // on. Both fork the COLLECT rail, so the block is left uncommitted and
            // retried, loudly, until DOGE visibility returns.
            getLogger().error('ANCHOR REWARD PROOF UNAVAILABLE at block ' + lastIndexerBlock + ': ' +
                (error && error.message) + ' HALTING block processing (not committing; an ' +
                'unproven or partial reward set would fork). Retrying after ' +
                this.config['BLOCK_CHECK_INTERVAL'] + 'ms.');
            this.stallReason = 'anchor_reward_proof_unavailable';
            this.stallClearsAt = null;          // clears when DOGE visibility returns, not on a clock
            return true;
        }
        return false;
    },

    // A bridge escrow proof or a ROLLCALL epoch cannot be decided from HERE. Returns true
    // when the fault was one of these two.
    noteBridgeOrRollcallFault(error, lastIndexerBlock){
        if(error && error.name === 'BridgeProofUnavailableError'){
            // The bridge escrow cross-check could not be handed a proof from HERE: no
            // quorum-established checkpoint at or after the transfer's
            // snapshot_block is held locally, or the origin chain's indexer served
            // none. That is a property of THIS node's mirror and network, not of
            // the row, so it must never read as ok:false - a node that is merely
            // behind would then decide, permanently, that a legitimate transfer is
            // forged, and mint nothing where its peers mint. Defer and retry, the
            // way the sync barriers defer, with the barrier-shaped stall
            // reason so /status classifies it as mirror lag rather than a wedge.
            getLogger().warn('BRIDGE ESCROW PROOF UNAVAILABLE at block ' + lastIndexerBlock + ': ' +
                (error && error.message) + ' Deferring the block (not committing; an ' +
                'unproven mint is exactly what D2 exists to stop). Retrying after ' +
                this.config['BLOCK_CHECK_INTERVAL'] + 'ms.');
            this.stallReason = 'bridge_proof_barrier';
            this.stallClearsAt = null;          // clears when the checkpoint arrives, not on a clock
            return true;
        }
        if(error && error.name === 'RollcallProofUnavailableError'){
            // A ROLLCALL epoch could not be decided from HERE. Closing it anyway
            // would take the worst possible reading of silence: an unreachable or
            // stale DOGE peer answers "no signatures", which is indistinguishable
            // from the entire federation being absent, and acting on it would evict
            // every validator at once. Deferring is the only outcome that keeps this
            // node's verdict identical to its peers'.
            getLogger().error('ROLLCALL PROOF UNAVAILABLE at block ' + lastIndexerBlock + ': ' +
                (error && error.message) + ' HALTING block processing (not committing; ' +
                'silence is not absence). Retrying after ' +
                this.config['BLOCK_CHECK_INTERVAL'] + 'ms.');
            this.stallReason = 'rollcall_proof_unavailable';
            this.stallClearsAt = null;          // clears when DOGE visibility returns, not on a clock
            return true;
        }
        return false;
    }
};
