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
 * XChain Indexer - Block poll pass
 *
 * One pass of the block loop around the catch-up: the reorg cursor and the two tips a
 * pass starts from, the deepest-rollback handling of every unprocessed decoder reorg,
 * the bounded mid-catch-up reorg recheck, and the retroactive replay witness: each recorded
 * chunk compared as its last block commits, the diverged hold, and the close at replay_to.
 * runBlockLoop and catchUpToDecoder stay in ../XChainIndexer.js beside start(). Installed
 * onto XChainIndexer.prototype by ../XChainIndexer.js.
 *
 ********************************************************************/

const { getLogger } = require('../observability/index.js');
const { advanceReplayMarker } = require('../consensus/retroactive/replay_marker.js');
const { replayReachedTip, replayMayComplete } = require('../consensus/retroactive/replay_status.js');
const { witnessHoldsBlocks } = require('../consensus/retroactive/witness_status.js');
const { stepWitnessChunk, stepWitnessFinal } = require('../consensus/retroactive/witness_compare_step.js');
const { recordReplayMarker } = require('../db/events/retroactive_replay_marker.js');
const {
    readLatestReplayWitness,
    readReplayWitnessBlocks,
    recordReplayWitnessPhase,
} = require('../db/events/retroactive_replay_witness.js');

module.exports = {

    // The reorg cursor and the decoder and indexer tips a pass starts from.
    async readPollCursors(indexerReorgView){
        // Fetch EVERY decoder reorg event the indexer has not yet processed (oldest first),
        // not just the latest. getLastProcessedReorgId() is the decoder event id of the most
        // recent reorg the indexer recorded; getReorgsSince() returns all decoder reorgs newer
        // than it. Reorgs are matched by event IDENTITY (the decoder's events.id), NOT by
        // block-height magnitude: heights increase across repeated reorgs, so a height compare
        // silently drops every reorg after the first. Do not re-introduce a height comparison.
        let lastProcessedReorgId = await indexerReorgView.getLastProcessedReorgId();
        // Pass the cursor marker's stored witness so getReorgsSince can catch an
        // out-of-band decoder rebuild that reused this cursor id for a different event
        // (under-cursor silent skip). Null for legacy markers -> the cursor-row existence
        // check still runs; only the time/hash match is skipped.
        let cursorWitness        = (lastProcessedReorgId != null)
                                    ? await indexerReorgView.getLastProcessedReorgWitness() : null;
        let unprocessedReorgs    = await this.decoderDb.getReorgsSince(lastProcessedReorgId, cursorWitness);
        // Keep the decoder-halt flag current on every poll (loud on transition, then
        // periodic). pollDecoderOnce reads it to stop advancing while the halt stands.
        await this.checkDecoderReorgHalt();

        // Get last processed block from Indexer and Decoder databases
        let lastDecoderBlock   = await this.decoderDb.getBlockIndex('decoder', 'last');
        this.lastDecoderBlock  = lastDecoderBlock;
        let lastIndexerBlock   = await indexerReorgView.getBlockIndex('indexer', 'last');
        return { lastProcessedReorgId: lastProcessedReorgId, unprocessedReorgs: unprocessedReorgs,
                 lastDecoderBlock: lastDecoderBlock, lastIndexerBlock: lastIndexerBlock };
    },

    // One pass of the block loop: read the cursors, roll back to any unprocessed decoder
    // reorg, catch up to the decoder tip, then fold the pass into the mirror-barrier hold
    // and the synced flag.
    async pollDecoderOnce(indexerReorgView, REORG_RECHECK_BLOCKS){
        let { lastProcessedReorgId, unprocessedReorgs, lastDecoderBlock, lastIndexerBlock } =
            await this.readPollCursors(indexerReorgView);
        // Define placeholders for block parsing status
        let firstDecoderBlock     = null;

        // Deepest-rollback reorg handling (applyPendingReorgs).
        if(unprocessedReorgs.length > 0){
            let rolled = await this.applyPendingReorgs(indexerReorgView, unprocessedReorgs, lastIndexerBlock);
            lastIndexerBlock     = rolled.lastIndexerBlock;
            lastProcessedReorgId = rolled.lastProcessedReorgId;
        }

        // A prior pass may have committed replay_to and stopped before appending the
        // terminal marker. Reconcile the durable committed tip before any early return.
        await this.completeRetroactiveReplay(indexerReorgView, lastIndexerBlock);

        // A diverged witness applies no block until a rewitness. The hold is named after
        // beginPollPass, which would otherwise clear it, so every pass reports it.
        if(await this.replayWitnessHoldsBlocks(indexerReorgView)){
            this.beginPollPass(null);
            this.holdRetroactiveReplayDiverged();
            return;
        }

        // A decoder carrying a durable REORG_HALT is condemned to a reset: its rows
        // above the fork point may be the abandoned branch (a decoder that halted before
        // finishing its rollback) or rows decoded forward on dispenser state that no
        // longer matches a fresh sync. So the pass stops here, after the rollbacks above
        // have landed, and indexes nothing new until the halt clears. Liveness only:
        // every block this indexer does commit is decided exactly as before. The pass
        // names no stall of its own, so the status surfaces publish upstream_halted,
        // never wedged. A probe fault keeps the last known halt state (checkDecoderReorgHalt).
        if(this.decoderReorgHalted === true){
            this.beginPollPass(null);
            return;
        }

        // If indexer has no parsed blocks, set last indexer block to first decoder block-1
        if(this.util.isNull(lastIndexerBlock)){
            firstDecoderBlock = await this.decoderDb.getBlockIndex('decoder', 'first');
            if(!this.util.isNull(firstDecoderBlock))
                lastIndexerBlock = this.util.bcsub(firstDecoderBlock,1);
        }

        // Print out status message about where parsing is resuming
        if(this.synced === false && !this.util.isNull(lastIndexerBlock)){
            let startBlock = this.util.bcadd(lastIndexerBlock,1)
            if(this.util.bclt(startBlock, lastDecoderBlock))
                getLogger().info('Resuming block parsing at block ' + startBlock + '...');
        }

        let nextBlock = this.util.isNull(lastIndexerBlock) ? null : Number(lastIndexerBlock) + 1;
        this.beginPollPass(nextBlock);
        let caughtUp = await this.catchUpToDecoder(indexerReorgView, REORG_RECHECK_BLOCKS,
                                                   lastProcessedReorgId, lastIndexerBlock, lastDecoderBlock);
        lastIndexerBlock = caughtUp.lastIndexerBlock;
        lastDecoderBlock = caughtUp.lastDecoderBlock;

        await this.completeRetroactiveReplay(indexerReorgView, lastIndexerBlock);

        // A diverged chunk stopped the catch-up; hold now rather than fold it into the
        // mirror-barrier ceiling, which would ask the mirror to resync over a data fault.
        if(this.replayWitnessPhase === 'diverged') return;

        // The witness pass reproduced its record through replay_to. The new rules apply
        // only from a fresh boot, so this process ends here and the supervisor restarts it.
        if(this.replayWitnessPhase === 'witnessed'){
            this.exitAfterReplayWitness(lastIndexerBlock);
            return;
        }

        // The catch-up loop has stopped, either caught up or because a barrier deferred
        // the block at the head of the queue. Fold that into the mirror-barrier hold so a
        // block that keeps being deferred across passes is measured against the named
        // ceiling instead of retrying forever behind identically-healthy-looking log
        // lines. A no-op when nothing is stalled; see noteBarrierHold.
        this.noteBarrierHold(this.util.isNull(lastIndexerBlock) ? null : Number(lastIndexerBlock) + 1);

        // Set flag to indicate fully synced and listening for block
        if(!this.synced && !this.util.bclt(lastIndexerBlock, lastDecoderBlock)){
            this.synced = true;
            getLogger().info('Listening for blocks...');
        }
    },

    // The witness rows of the open replay, read once and then kept current from the phase
    // rows this process writes. Null when the boot found no witness for the marker.
    async readReplayWitness(indexerReorgView){
        if(!this.replayWitnessPhase) return null;
        if(!this.replayWitness) this.replayWitness = await readLatestReplayWitness(indexerReorgView);
        return this.replayWitness;
    },

    // Witness reads and phase writes go through the committed-only view, like the reorg
    // markers, so no dry-run transaction can adopt or discard them.
    replayWitnessDeps(indexerReorgView){
        return {
            // Chain block hashes come from the decoder's committed-only view, the one the
            // getblockhashes RPC reads.
            readWitnessBlocks: (from, to) =>
                readReplayWitnessBlocks(indexerReorgView, this.decoderDb.apiView(), from, to),
            recordWitnessPhase: (batch, phase) => {
                this._passRestartOnFault = true;
                return recordReplayWitnessPhase(indexerReorgView, batch, phase);
            },
        };
    },

    async replayWitnessHoldsBlocks(indexerReorgView){
        const witness = await this.readReplayWitness(indexerReorgView);
        return witness !== null && witnessHoldsBlocks(witness.phase);
    },

    // Called by catchUpToDecoder after each committed block. Under the recorded rules,
    // the chunk that closes at this height is digested from the committed rows and held
    // against its record. True stops block application at this block: a mismatch writes
    // 'diverged' and holds, and the last chunk matching at replay_to writes 'witnessed'.
    async replayWitnessChunkCommitted(indexerReorgView, committedTip){
        if(this.replayWitnessPhase !== 'witness') return this.replayWitnessPhase === 'diverged';

        const witness = await this.readReplayWitness(indexerReorgView);
        const step = await stepWitnessChunk(witness, Number(committedTip),
            this.replayWitnessDeps(indexerReorgView));
        if(!step || !step.phase) return false;

        this.replayWitness = Object.assign({}, witness, { phase: step.phase });
        this.replayWitnessPhase = step.phase.phase;
        if(step.phase.phase === 'diverged'){
            getLogger().error('Retroactive replay witness diverged in chunk ' + step.chunk.from + '-' +
                step.chunk.to + ': recorded ' + step.chunk.d + ', replayed ' + step.digest +
                '. Holding block application; nothing is signed over this window.');
            this.holdRetroactiveReplayDiverged();
        }
        return true;
    },

    // Exit nonzero so an on-failure supervisor restarts the process as well as an
    // unless-stopped one. A method, like fatalExit, so a test can observe the decision.
    exitAfterReplayWitness(committedTip){
        getLogger().info('Retroactive replay witness reproduced the window through block ' +
            committedTip + '; restarting to replay it under the current rules.');
        process.exit(1);
    },

    // Persist the terminal state only after the committed cursor reaches replay_to and,
    // under a witness, only after the final pass has recorded whether the window changed.
    // Each append happens before the in-memory state changes, so a failed write leaves
    // the replay open and retryable on the next supervised pass.
    async completeRetroactiveReplay(indexerReorgView, committedTip){
        if(!replayReachedTip(this.replayMarker, committedTip)) return false;

        const witness = await this.readReplayWitness(indexerReorgView);
        if(witness){
            const final = await stepWitnessFinal(witness, Number(committedTip),
                this.replayWitnessDeps(indexerReorgView));
            if(final){
                this.replayWitness = Object.assign({}, witness, { phase: final.phase });
                getLogger().info('Retroactive replay final pass reached block ' + committedTip + '; the window ' +
                    (final.changed ? 'changed' : 'did not change') + ' under the current rules.');
            }
        }
        if(!replayMayComplete(this.replayMarker, committedTip,
            this.replayWitness ? this.replayWitness.phase : null)) return false;

        const replayed = advanceReplayMarker(this.replayMarker, 'replayed');
        this._passRestartOnFault = true;
        await recordReplayMarker(indexerReorgView, replayed);
        this.replayMarker = replayed;
        if(this.stallReason === 'retroactive_replay'){
            this.stallReason = null;
            this.stallClearsAt = null;
            this.stallBlock = null;
        }
        return true;
    },

    // Handle block reorgs. When two or more reorgs land between indexer iterations and a
    // newer event is SHALLOWER than an older one, processing only the latest leaves
    // orphaned rows below the older, deeper reorg point (a consensus-divergence and
    // double-count source). So roll back once to the DEEPEST (minimum) block index across
    // every unprocessed reorg, and record each event in id order so the processed-id cursor
    // advances to the newest decoder event. Always record; only roll back if the indexer
    // has already indexed past the deepest reorg block.
    // Returns the re-read resume cursor and the refreshed processed-reorg cursor.
    async applyPendingReorgs(indexerReorgView, unprocessedReorgs, lastIndexerBlock){
        let minReorgBlock = null;
        for(let reorg of unprocessedReorgs){
            if(minReorgBlock === null || reorg.block_index < minReorgBlock)
                minReorgBlock = reorg.block_index;
        }
        // The decoder writes one REORG event per orphaned block, so this is a block count, not a reorg count.
        getLogger().warn("Detected " + unprocessedReorgs.length + " orphaned block(s) from decoder reorg events; deepest at block #" + minReorgBlock);
        if(!this.util.isNull(lastIndexerBlock) && lastIndexerBlock >= minReorgBlock){
            this._passRestartOnFault = true;
            await this.rollback.rollback(minReorgBlock);
            // Re-read the resume cursor: rollback() deleted every block >=
            // the reorg point, and lastIndexerBlock was read BEFORE the
            // rollback. Resuming from the stale pre-rollback tip skips the
            // new chain's version of the rolled-back range permanently,
            // observed live as single missing blocks rows after depth-1
            // reorgs (DOGE mainnet 6241887 et al.), each of which also
            // silently restarts the ledger/actions/contract hash chains
            // (getBlockHashes hashes the next block with previous_hash
            // undefined, which JSON.stringify drops).
            lastIndexerBlock = await indexerReorgView.getBlockIndex('indexer', 'last');
        }
        // Record the processed-reorg markers ONLY after any rollback has committed.
        // The marker rows advance the processed-id cursor (getLastProcessedReorgId), so
        // writing them before rollback() meant a crash or thrown error inside the rollback
        // window left the cursor advanced and the rollback was never retried, stranding
        // orphaned old-chain rows below minReorgBlock (silent consensus divergence). Writing
        // strictly after the commit keeps the cursor un-advanced on failure, so the same
        // reorg is re-detected and retried after the supervisor restart. runBlockLoop rides out
        // only failures from a pass that has not started rollback or replay writes. The retry is idempotent because
        // the rollback is skipped once lastIndexerBlock has dropped below minReorgBlock.
        // Oldest-first so a partial-write crash only advances the cursor as far as is durable.
        for(let reorg of unprocessedReorgs){
            // Capture the decoder event's time + payload hash as the marker
            // witness, so a later out-of-band decoder rebuild that reuses this id for a
            // different event is caught (the fail-loud reorg-cursor-incoherent error) instead of silently skipped.
            let witness = await this.decoderDb.getReorgEventWitness(reorg.id);
            await indexerReorgView.createReorg(reorg.block_index, reorg.id,
                witness ? witness.time : null, witness ? witness.hash : null);
            this.reorgsProcessedSinceStart = (this.reorgsProcessedSinceStart || 0) + 1;
        }

        // Refresh the local cursor to the durable value just advanced by createReorg.
        // lastProcessedReorgId was read once at the top of the outer loop and is never
        // otherwise updated, so the mid-catch-up reorg recheck below would call
        // getReorgsSince() with the stale pre-processing id, re-select the reorg(s) we
        // just recorded (their event ids are all > the stale id), and break to the outer
        // loop once per processed reorg. Re-reading the newest recorded marker id (rather
        // than assuming getReorgsSince ordering) keeps the recheck comparing against the
        // true cursor. This never masks an unprocessed reorg: any reorg with id greater
        // than the refreshed cursor still selects on the next probe.
        let lastProcessedReorgId = await indexerReorgView.getLastProcessedReorgId();
        return { lastIndexerBlock: lastIndexerBlock, lastProcessedReorgId: lastProcessedReorgId };
    },

    // Bounded reorg-detection latency during long catch-up. Reorg events are
    // otherwise fetched only at the top of the OUTER loop, and the per-block decoder-tip
    // refresh keeps this inner loop running as long as the tip moves - so a decoder reorg
    // that lands mid-catch-up is not detected until the node is fully caught up, and until
    // then the loop commits hash-chained blocks built on old-chain state (served via
    // getblockhashes / pushed to the hub). Cheaply re-check every REORG_RECHECK_BLOCKS
    // blocks and break to the outer loop, which performs the deepest-rollback + replay.
    // Bounds the mixed-chain window to REORG_RECHECK_BLOCKS instead of the whole backlog;
    // convergence is unchanged (the eventual rollback unwinds every block >= the reorg).
    async reorgLandedMidCatchUp(indexerReorgView, lastProcessedReorgId, lastIndexerBlock, REORG_RECHECK_BLOCKS){
        if((Number(lastIndexerBlock) % REORG_RECHECK_BLOCKS) !== 0) return false;
        // Witness the cursor here too (same under-cursor protection).
        let midCursorWitness = (lastProcessedReorgId != null)
                                ? await indexerReorgView.getLastProcessedReorgWitness() : null;
        let midReorgs = await this.decoderDb.getReorgsSince(lastProcessedReorgId, midCursorWitness);
        if(midReorgs.length === 0) return false;
        getLogger().info('Detected a decoder reorg mid-catch-up; breaking to handle it before block ' + (Number(lastIndexerBlock) + 1));
        return true;
    }
};
