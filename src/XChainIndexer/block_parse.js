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
 * XChain Indexer - Block parse
 *
 * Parsing one block: the train gate and the block's inputs ahead of the mirror sync
 * barriers (./price_barriers.js, ./mirror_barriers.js), then the block's own indexer
 * transaction under the block watchdog, running the passes in ./block_passes.js and
 * committed or abandoned as a unit (./block_commit.js). Installed onto XChainIndexer.prototype by ../XChainIndexer.js.
 *
 ********************************************************************/

const fs           = require('fs');
const protocolTime = require('../consensus/protocol_time.js');
const stateCommitAct = require('../state_commitment_activation.js');
const { collapseOutputFanout } = require('../chain/output_fanout.js');
const { getLogger } = require('../observability/index.js');

module.exports = {

    // Parse one block: the train gate, its inputs, the mirror barriers, then the block
    // transaction. Returns { committed, stop, lastDecoderBlock } to the catch-up loop; a
    // gate or barrier defer commits nothing and stops the pass, and the block is retried.
    async parseBlock(blockToParse, lastIndexerBlock, lastDecoderBlock, debugTimer){
        let deferred = { committed: false, stop: true, lastDecoderBlock: lastDecoderBlock };

        // PLATFORM-TRAIN ACTIVATION GATE. Runs
        // BEFORE anything about this block is read, because the decision is "may this
        // node apply block N at all", not "what does block N contain". A node whose
        // code carries no entry for the rule set its signed release manifest requires
        // STOPS here rather than applying the block under the old rules: continue-old
        // writes forked state and answers queries from it, and the sync followers would
        // halt on the divergence one block later anyway, after the damage.
        if(await this.checkTrainActivation(blockToParse)){
            // Defer with the same semantics as the sync barriers: lastIndexerBlock is
            // not advanced, no transaction is open, and the outer loop retries. Unlike a
            // barrier this does NOT self-clear; only a build that implements the required
            // rule set clears it, which is what `xchain-node update` installs.
            return deferred;
        }

        let { blockTransactions, anchorHorizonBound, blockTime, rawBlockTime } = await this.readBlockInputs(blockToParse);
        if(await this.deferOnSyncBarriers(blockToParse, blockTime, blockTransactions, anchorHorizonBound))
            return deferred;
        return await this.processBlock({ blockToParse, blockTime, rawBlockTime, blockTransactions },
                                       lastIndexerBlock, lastDecoderBlock, debugTimer);
    },

    // The block's transactions and its two clocks, read before any barrier or transaction.
    async readBlockInputs(blockToParse){
        // Get a list of any transactions in this block from the decoder database
        let blockTransactions = await this.decoderDb.getDecoderBlockData(blockToParse);

        // Collapse the reader-side per-output fan-out (see src/chain/output_fanout.js).
        // getDecoderBlockData emits one row per stored native-coin output, each carrying
        // the same tx data; without this, a data-bearing action whose transaction also
        // pays a dispenser and/or a fee-destination output would be executed once per
        // output row (duplicate credits/debits). COINPAY payment settlement and empty-data
        // DISPENSE triggers keep their per-output fan-out. Consensus-gated on
        // FIX_OUTPUT_FANOUT; below activation a multi-output data-bearing tx aborts the
        // block loudly (via the watchdog/rollback path) instead of double-executing.
        let fanoutFixActive = await this.protocolChanges.isEnabled('FIX_OUTPUT_FANOUT', blockToParse);
        blockTransactions = collapseOutputFanout(blockTransactions, fanoutFixActive, (m) => this.util.logError(m));

        // Lookup the block time for a given block (read from decoder DB before opening transaction).
        //
        // TWO values, deliberately. blockTime is PROTOCOL time (median-time-past on
        // the networks switched to it) and drives every barrier and time-keyed read
        // after it, so that a miner-chosen stamp dated into the future cannot make this
        // node wait for wall clock or read a still-growing mirror window. rawBlockTime
        // is the block's own stamp, and is what gets PERSISTED and published, so the
        // timestamp a user sees on a block stays the real one.
        // The anchor-attest barrier's maturity-horizon bound, resolved BEFORE the
        // block's own protocol-time read below: getBlockTime memoizes exactly one
        // height, and taking the horizon afterwards would evict the memo that
        // protocol_changes.js re-reads later in this same block.
        let anchorHorizonBound = await this.anchorAttestHorizonBound(blockToParse);

        let blockTime    = await this.decoderDb.getBlockTime(blockToParse);
        let rawBlockTime = await this.decoderDb.getRawBlockTime(blockToParse);

        // Re-stamp the transaction rows with protocol time before anything reads
        // them. getDecoderBlockData carries block_time straight from the decoder's
        // blocks table, and actions.js processTransaction lifts tx.block_time into
        // data['BLOCK_TIME'], which every handler hands to the time-ranged price and
        // oracle reads. Leaving the raw stamp there while the sync barriers run on
        // protocol time is the forking combination: the block would be released up
        // to ~2h before wall clock reached its stamp, and the price window scanned
        // for it would still be gaining rounds, so two nodes reading at different
        // instants credit different amounts. Barriers and reads move together or
        // not at all.
        protocolTime.stampProtocolTime(blockTransactions, blockTime);
        return { blockTransactions: blockTransactions, anchorHorizonBound: anchorHorizonBound,
                 blockTime: blockTime, rawBlockTime: rawBlockTime };
    },

    // Open the block's transaction and install its per-block write state. Returns whether
    // the light-client state commitment is active for this block.
    async openBlockTransaction(blockToParse){
        // Begin a transaction: all indexer DB writes for this block are atomic.
        await this.indexerDb.beginTransaction();
        // Record the block being processed so createAddress/createTicker stamp
        // index_addresses/index_tickers.block_index with the block at which each
        // id is first assigned (used by rollback to delete + deterministically
        // reassign ids on reorg, keeping wire ^<id> references fork-safe).
        this.indexerDb.blockIndex = blockToParse;
        // Mark that deterministic, block-stamped id assignment has begun. The
        // out-of-band createAddress/createTicker branch (NULL block_index, legacy
        // AUTO_INCREMENT) warns if it ever runs after this point, since an out-of-band
        // insert would bump MAX(id) and silently offset the dense counter.
        this.indexerDb.deterministicIndexingStarted = true;
        // Light-client state commitment: when active, install a
        // fresh per-block touched-key set so the ledger choke point
        // (db.createLedgerChangeRecord) records every (address, tick) mutated
        // this block; cleared/null when inactive so the hook is inert.
        let stateCommitActive = stateCommitAct.isStateCommitmentActive(blockToParse, this.config['NETWORK'], this.config['COIN']);
        this.indexerDb._smtTouched = stateCommitActive ? new Set() : null;
        // Install a fresh per-block staged-hub-push buffer. PRICE actions write their hub
        // push durably inside this transaction (enqueueHubPushTx) and stage the row here for
        // an immediate post-commit live delivery. Replaced each block, so a rolled-back
        // block's staged (and rolled-back) rows are simply discarded, never delivered.
        this.indexerDb._stagedHubPushes = [];
        return stateCommitActive;
    },

    // Apply one block in its own indexer transaction: open it, run every pass under the
    // block watchdog, commit, then the post-commit steps. Returns { committed, stop,
    // lastDecoderBlock } to the catch-up loop. Any failure rolls the block back and stops
    // the pass (abandonBlock); `committed` stays true when only a post-commit step threw.
    async processBlock(blk, lastIndexerBlock, lastDecoderBlock, debugTimer){
        let blockToParse = blk.blockToParse;
        let stateCommitActive = await this.openBlockTransaction(blockToParse);
        let committed = false;
        try {

            // Fence the block's writes to THIS transaction's epoch. Read the
            // epoch that beginTransaction just assigned, then run all block processing
            // under it (runInTxEpoch) so every DB write it issues carries this epoch.
            // If the watchdog below fires, the outer catch rolls back and bumps the
            // epoch; the abandoned promise (which may still resume and try to write on
            // the shared connection now owned by a later block) then carries a stale
            // epoch and is rejected inside the db layer before touching the driver.
            let txEpoch = this.indexerDb.currentTxEpoch();

            // Process the block with a watchdog timeout to detect deadlocks or infinite loops
            let blockProcessing = this.indexerDb.runInTxEpoch(txEpoch, () => this.runBlockPasses(blk, stateCommitActive));

            // Watchdog-timeout safety. If the watchdog rejects below, we stop
            // awaiting blockProcessing but the promise stays pending and may settle
            // later (typically the epoch fence rejecting a zombie write, or the block
            // finally finishing). Attach a swallow handler so that late settlement can
            // never surface as an unhandledRejection that crashes the process. The
            // epoch fence, not this handler, is what prevents the zombie's writes from
            // landing; this only keeps the abandoned promise's rejection quiet.
            blockProcessing.catch((e) => {
                getLogger().warn('Abandoned block-processing promise for block ' + blockToParse +
                    ' settled after watchdog: ' + (e && e.message ? e.message : e));
            });

            let blockTimeout = this.blockWatchdogTimeout(blockToParse);
            let [ledger, actions, contracts] = await this.util.withTimeout(blockProcessing, blockTimeout, 'block ' + blockToParse);

            // Commit the block data to the database
            await this.indexerDb.commitTransaction();
            committed = true;

            lastDecoderBlock = await this.afterBlockCommit(blk, [ledger, actions, contracts], lastDecoderBlock, debugTimer);
            return { committed: committed, stop: false, lastDecoderBlock: lastDecoderBlock };
        } catch(error){
            await this.abandonBlock(error, committed ? blockToParse : lastIndexerBlock);

            // Exit the inner catch-up loop on failure. lastIndexerBlock was not advanced
            // (the assignment above only runs after a successful commit), so the outer loop
            // re-fetches it from the DB and retries this same block after the sleep interval,
            // instead of falling through and silently skipping the failed block.
            return { committed: committed, stop: true, lastDecoderBlock: lastDecoderBlock };
        }
    },

    // The genesis block does far more than a normal block, so it gets its own
    // watchdog. The budget follows the PATH it will take (see genesis.inject):
    // importing the precomputed dump finishes in seconds, so it uses the tight
    // GENESIS_DUMP_TIMEOUT_MS; only the CSV re-derivation fallback (~1-2h) needs
    // the generous GENESIS_BLOCK_TIMEOUT_MS. This keeps a tight liveness signal on
    // the normal (dump) path without false-tripping a no-dump node.
    blockWatchdogTimeout(blockToParse){
        let isGenesisBlock = Number(blockToParse) === Number(this.config['GENESIS_BLOCK']) && this.config['GENESIS_BLOCK'];
        let blockTimeout   = this.config['BLOCK_PROCESS_TIMEOUT'];
        if(isGenesisBlock){
            let dumpPath = this.config['GENESIS_DUMP_PATH'];
            blockTimeout = (dumpPath && fs.existsSync(dumpPath))
                ? this.config['GENESIS_DUMP_TIMEOUT_MS']
                : this.config['GENESIS_BLOCK_TIMEOUT_MS'];
        }
        return blockTimeout;
    }
};
