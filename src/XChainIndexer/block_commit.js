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
 * XChain Indexer - Block commit
 *
 * What follows a block's transaction: the post-commit steps (stall and hold cleared, the
 * block logged, the chain tip pushed, the staged hub pushes delivered, the decoder tip
 * refreshed) and, on a failure, the rollback that leaves the database at the end of the
 * previous block. Installed onto XChainIndexer.prototype by ../XChainIndexer.js.
 *
 ********************************************************************/

const { getLogger } = require('../observability/index.js');

module.exports = {

    // Deliver the hub pushes staged (and durably written via enqueueHubPushTx) during the block
    // transaction that just committed. Each push_type maps to the same HubClient method the
    // HubPushQueue drain uses; on success the durable pending_hub_pushes row is dropped, on any
    // failure it is left for HubPushQueue to retry with backoff. Never throws into the block loop.
    async deliverStagedHubPushes(){
        let staged = this.indexerDb.takeStagedHubPushes();
        if(!staged || staged.length === 0 || !this.hubClient) return;
        for(let entry of staged){
            try {
                if(entry.pushType === 'price_round'){
                    await this.hubClient.pushPriceRound(entry.payload);
                } else if(entry.pushType === 'oracle_price'){
                    await this.hubClient.pushOraclePrice(entry.payload);
                } else if(entry.pushType === 'price_batch'){
                    // PRICE v0: a signed window of rounds, delivered to pushpricebatch.
                    await this.hubClient.pushPriceBatch(entry.payload);
                } else if(entry.pushType === 'attest_batch'){
                    // ATTEST v5: a signed window of finalized attestation responses parsed
                    // off the DOGE rail, delivered to the hub's `pushattestbatch`, which
                    // re-verifies the batch quorum, inserts the carried rows into
                    // attestation_responses and broadcasts them. That road is how a
                    // chain-only node's mirror gets rebuilt from chain parse alone, which
                    // is why the row stays durable rather than best-effort.
                    //
                    // Payload shape (the hub destructures exactly these names):
                    //   source_chain, network, window_start, window_end, row_count,
                    //   btc_block_height, rows[], sigs[], action_index, block_index,
                    //   block_time, push_generation
                    await this.hubClient.pushAttestBatch(entry.payload);
                } else {
                    // Unknown type: leave the durable row for HubPushQueue rather than guess.
                    continue;
                }
                if(entry.id != null) await this.indexerDb.markHubPushDelivered(entry.id);
            } catch(err){
                // Live delivery failed; the durable row stays for HubPushQueue's backoff retry.
                getLogger().warn('Staged hub push ' + entry.pushType + ' row ' + entry.id +
                    ' live delivery failed; HubPushQueue will retry:', err && err.message);
                // A 429 says the hub is refusing this IP for the rest of its window, so the
                // remaining staged entries would each buy one more rejection and one more
                // log line. Stop here: every one of them is already durable in
                // pending_hub_pushes, and HubPushQueue holds off until the window clears.
                // This is the shape a chain-only node replaying a
                // batch-bearing chain against a REMOTE hub takes, where the block loop
                // outruns any per-IP cap by orders of magnitude.
                if(err && err.rateLimited) break;
            }
        }
    },

    // Post-commit steps for the block that just committed: end its stall and hold, log it,
    // push the chain tip, deliver its staged hub pushes and refresh the decoder tip, which
    // it returns.
    async afterBlockCommit({ blockToParse, rawBlockTime }, [ledger, actions, contracts], lastDecoderBlock, debugTimer){
        this.markBlockCommitted(blockToParse);

        // Log the total parse time for this block
        let parseTime = this.util.getTimer(debugTimer);
        getLogger().info('Block Parsed' + "\t: " + blockToParse + ' [ledger:' + ledger + ' actions:' + actions + ' contracts:' + contracts + '] (' + parseTime + ')');

        // Push chain tip to hub (fire-and-forget; never blocks indexing).
        // Network is included so multi-network hubs scope tips correctly
        // (older hubs ignore it; pre-network-aware behavior = 'mainnet').
        // Skip while catching up: during a bulk re-index, pushing a tip for every
        // historical block floods the hub's proxy / rate-limiter (HTTP 429) for no
        // value. The hub only wants the live tip. Only push within
        // CHAIN_TIP_PUSH_MAX_LAG blocks of the decoder tip (lastDecoderBlock here is
        // the prior iteration's value, i.e. at most one block stale, which is fine).
        if(!this.util.bcgt(this.util.bcsub(lastDecoderBlock, blockToParse), this.config['CHAIN_TIP_PUSH_MAX_LAG'])){
            // The chain identity rides the tip push that already exists rather than
            // a new RPC. Resolved here (not only at startup) because a chain that
            // was re-genesised has no block 1 to read when this process boots; the
            // memoized read costs one point query per block until it lands, and
            // nothing is sent until then, which leaves an older hub's wire intact.
            let chainId = await this.resolveBtcChainId();
            // rawBlockTime: the hub publishes this as the chain's tip timestamp to
            // other services, which compare it against wall clock for freshness.
            this.hubClient.pushChainTip(this.config['COIN'], this.config['NETWORK'], blockToParse, rawBlockTime, chainId);
        }

        // Deliver the PRICE hub pushes durably staged inside the just-committed block
        // transaction (mirrors rollback.js's post-commit retraction delivery). Each row
        // already survives a crash here (HubPushQueue drains the survivors on restart);
        // this is only an immediate live-delivery fast path that drops the durable row on
        // success and leaves it for the queue on any failure. Best-effort and never throws
        // into the block loop.
        await this.deliverStagedHubPushes();

        // Refresh the decoder tip after each committed block. Without this the
        // decoder tip is snapshotted once per outer-loop iteration and stays frozen
        // for the whole catch-up, so reported lag (decoderBlock - indexerBlock) shrinks
        // to zero as the indexer advances even while the decoder is still moving ahead.
        // Re-reading keeps the value live, so the /status, getlatestblock(), and health()
        // surfaces, plus pollDecoderOnce's synced check, which compares against this same
        // variable, reflect the true decoder tip throughout catch-up rather than a
        // false all-clear. An indexed last-block lookup is cheap enough to do per block.
        lastDecoderBlock      = await this.decoderDb.getBlockIndex('decoder', 'last');
        this.lastDecoderBlock = lastDecoderBlock;
        return lastDecoderBlock;
    },

    // The block committed, so nothing is stalled or held behind a barrier any more and no
    // price read may be attributed to it.
    markBlockCommitted(blockToParse){
        // A block advanced, so we are no longer stalled. Clear any deferral
        // reason set by a barrier timeout or host fault on a prior iteration, and
        // stamp the commit time so the /status healthcheck can tell an
        // advancing-but-barrier-deferring indexer from a wedged one.
        this.stallReason = null;
        this.stallClearsAt = null;              // the stall is over, so is its deadline
        this.lastBlockCommittedAt = Date.now();
        // Whatever this block was held behind, it is not held any more. Cleared here
        // as well as by nextBarrierHold's block-changed reset so a commit ends the
        // hold immediately, rather than at the next pass through the poll loop.
        this.barrierHold = null;

        // The block is committed, so nothing else may attribute a price
        // read to it. Clearing priceBarrierSkipped keeps the choke-point
        // assertion inert outside block processing, and clearing the force flag
        // (only when THIS block was the escalated one) keeps the escalation a
        // one-shot retry rather than a permanent return to waiting every block.
        this.priceBarrierSkipped = false;
        if(this.priceBarrierForceBlock === blockToParse)
            this.priceBarrierForceBlock = null;
    },

    // Roll back a block that failed after its transaction opened, then record why.
    // `lastIndexerBlock` is the loop's cursor at the fault: the previous block, or this
    // one when it had committed and a post-commit step threw.
    async abandonBlock(error, lastIndexerBlock){
        // Roll back all writes for this block so the DB stays at the end of the previous block
        await this.indexerDb.rollbackTransaction();

        // The block is no longer in flight, so no read can be attributed
        // to it. priceBarrierForceBlock is deliberately NOT cleared here: when
        // this rollback IS the price-barrier escalation, that flag is what makes
        // the retry take the barrier instead of skipping again and looping.
        this.priceBarrierSkipped = false;

        this.noteBlockFault(error, lastIndexerBlock);
    }
};
