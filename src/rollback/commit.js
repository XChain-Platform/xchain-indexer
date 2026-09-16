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
 * XChain Indexer - Rollback: projections, commit and hub retractions
 *
 * The end of the rollback transaction and what follows it: the projection refresh,
 * the push-generation bump and retraction write-aheads, the commit with every memo
 * it invalidates, the live retraction delivery and the completion summary. No
 * statement text of its own. Installed onto Rollback.prototype by ./index.js.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../observability/index.js');

module.exports = {

    // Recompute the cached projections (balances, token supplies, market stats) for the
    // entities the orphaned range touched, then sanity-check supplies, with index-id
    // creation suppressed for the duration so a refresh cannot resurrect a deleted id.
    // DEBUG : Full balances and token updates
    // await this.indexerDb.updateBalances(true, true);
    // await this.indexerDb.updateTokens(true, true);

    // The refresh helpers below resolve addresses/tickers collected from the
    // orphaned range (the read phase ran before the deletes). An entity that
    // existed ONLY in rolled-back blocks has just had its index_addresses /
    // index_tickers row removed by the indexTables delete above. Without this
    // guard, createAddress/createTicker (reached via updateAddressBalance and
    // updateTokenInfo -> getTokenInfo) would RE-CREATE that lookup row, resurrecting
    // the just-deleted id at the surviving MAX(id)+1. A fresh-from-genesis node
    // never had that entity, so the same id stays free there and a wire ^<id>
    // reference resolves to a different entity -> the exact consensus fork this
    // rollback delete set out to close. suppressIndexIdCreation makes the create
    // helpers resolve-only for the duration: surviving entities still resolve to
    // their existing id; orphaned-only entities resolve to null and the refresh is
    // a harmless no-op (their data rows are already gone). Reset in finally so a
    // throw (e.g. sanityCheck supply mismatch) never leaks the read-only mode into
    // the next forward block.
    async refreshDerivedProjections(block_index, addresses, tickers, markets){
        this.indexerDb.suppressIndexIdCreation = true;
        try {

            // Update address balances to get back to sane balances based on credits/debits
            await this.indexerDb.updateBalances(Object.keys(addresses), true);

            // Update token information
            await this.indexerDb.updateTokens(tickers, true);

            // Update market information
            await this.indexerDb.updateMarkets(markets, block_index);

            // Do a sanity check to verify that token supplies match data in credits/debits/escrows/balances tables
            await this.indexerDb.sanityCheck(block_index);

        } finally {
            this.indexerDb.suppressIndexIdCreation = false;
        }
    },

    // Source-chain reorg fence (item 5308): this chain's monotonic push generation is bumped so
    // that rows re-published by forward replay carry the NEW generation while the orphaned rows
    // keep the prior one, and the retractions below carry the PRE-bump generation (bumped - 1) so
    // the hub fence deletes only the orphans (push_generation <= pre) while a re-published row at a
    // recycled action_index (new generation) survives. push_generations is NEVER a rollback
    // dataTable (monotonic).
    //
    // The bump is issued INSIDE the rollback transaction (just before commit, below), NOT here,
    // for two reasons (HUB-RETRACT-1): (a) fail-closed - a bump failure throws into the
    // transaction's catch, rolling back every delete, so the reorg is retried idempotently rather
    // than shipping an un-fenced rollback; (b) atomicity vs concurrent hub PULLs - the hub stamps
    // getpendingcrosschaincalls / getopencrosschainorders results with the CURRENT generation at
    // serve time, so if the generation flipped to bumped while the orphaned rows were still
    // committed and visible, a pull would stamp an orphan with the NEW generation and it would
    // escape the fence forever. Bumping in-transaction means another connection sees either
    // (pre-commit) old generation + orphaned rows, stamped with the old generation the fence
    // covers, or (post-commit) new generation + rows already gone - never orphans + new generation.
    // Retraction rows written ahead inside the transaction (HUB-RETRACT-2); the post-commit block
    // attempts immediate live delivery and drops each on success, else leaves it for HubPushQueue.
        // Bump the push-generation fence (HUB-RETRACT-1) and write-ahead the hub retractions
        // (HUB-RETRACT-2), both INSIDE this transaction so they commit atomically with the
        // deletes above. Placed last (after sanityCheck) so any earlier failure rolls the bump
        // back and the reorg is retried cleanly. bumpPushGeneration routes through the open
        // transaction connection (doQuery), so a failure throws into the catch below.
    async stageHubRetractions(firstActionIndex, lastActionIndex, unlandedAttestBatches){
        let retractionGeneration = null;
        let stagedRetractions = [];
        let bumpedGeneration = await this.indexerDb.bumpPushGeneration(this.config['COIN']);
        retractionGeneration = bumpedGeneration - 1;

        // Write-ahead the four range retraction intents as durable pending_hub_pushes rows, committed
        // atomically with the rollback. Enqueuing the retractions only in the post-commit failure
        // path drops them permanently when a crash (or DB-pool blip) lands between commit and the
        // live RPC: the retried reorg skips rollback() (lastIndexerBlock already below
        // minReorgBlock), so they are never re-issued, leaving orphaned 'finalized' hub rows
        // serving fleet-wide. The bridge retraction rides the same range because a lock or burn
        // orphaned before its effective_time would otherwise stay 'finalized' on every hub and
        // mirror and the destination chain would mint from a lock that is no longer on this chain.
        // The rows are inserted AFTER the dataTables purge, so this
        // rollback's own orphan delete cannot remove them; and a deeper later reorg's purge
        // deliberately EXCLUDES these retraction push_types (HUB-RETRACT-2 nested-reorg guard,
        // see the pending_hub_pushes delete above), so they are never superseded by a later
        // purge and instead drain idempotently under the generation fence. The
        // durable rows are CLOSED-range (bounded by lastActionIndex): a queued drain runs after
        // replay may have re-published rows above lastActionIndex, which must be preserved.
        if(firstActionIndex !== null && this.hubClient && this.hubClient.enabled){
            for(let pushType of ['price_retraction', 'xcall_retraction', 'match_retraction', 'bridge_retraction']){
                let id = await this.indexerDb.enqueueHubPushTx(pushType, {
                    coin: this.config['COIN'], action_index: firstActionIndex,
                    last_action_index: lastActionIndex, retraction_generation: retractionGeneration });
                stagedRetractions.push({ pushType, id });
            }

            // One durable row per ATTEST batch this reorg un-landed, on the same
            // write-ahead reasoning: the landing push already told a hub to stamp a batch
            // link on every response the batch carried, and after the purge below this node
            // holds nothing that could re-derive which batch that was. The payload names ONE
            // batch rather than an action range, because the hub-side effect is a link
            // cleared and never a row deleted (HubClient.retractAttestBatch says why).
            for(let batch of unlandedAttestBatches){
                let payload = {
                    coin:         this.config['COIN'],
                    network:      this.config['NETWORK'],
                    batch_key:    batch.batch_key,
                    window_start: batch.window_start,
                    window_end:   batch.window_end,
                    // The link the hub stamped is the HEAD's action index (row 52), so that
                    // is the value the retraction has to name, never the chunk that
                    // completed the batch or the lowest rolled-back action.
                    action_index: batch.action_index
                };
                // Keyed at the head's action index like every other queue row, so a deeper
                // reorg's purge would carry it away were the retraction types not excluded
                // from that delete.
                let id = await this.indexerDb.enqueueHubPushTx('attest_batch_retraction', payload,
                    batch.action_index);
                stagedRetractions.push({ pushType: 'attest_batch_retraction', id, payload });
            }
        }
        return { retractionGeneration, stagedRetractions };
    },

    // Commit the reorg, then drop every memo the commit just invalidated. Each clear
    // states its own hazard below; all of them must run on the committed rollback, so
    // they sit here rather than at the end of rollback(), where a throw would skip them.
    // Commit: the rollback is now atomically applied
    async commitAndInvalidateCaches(){
        await this.indexerDb.commitTransaction();

        // Invalidate the height-keyed getBlockTime() memo on BOTH DB instances. This reorg
        // just changed the content of every height >= block_index: the decoder re-inserted
        // the new-chain block(s) with new block_time(s), and the indexer's blocks rows were
        // deleted above. The memo is keyed by height only and is never otherwise cleared, so
        // without this a depth-1 reorg replay of the same height would hit a stale cache and
        // drive the block with the orphaned chain's timestamp (a unilateral consensus fork on
        // any straddling time gate). Clearing after commit guarantees the forward replay
        // re-reads the new chain's block_time.
        if(this.decoderDb && typeof this.decoderDb.clearBlockTimeCache === 'function') this.decoderDb.clearBlockTimeCache();
        if(this.indexerDb && typeof this.indexerDb.clearBlockTimeCache === 'function') this.indexerDb.clearBlockTimeCache();

        // Same reorg, same class of stale memo, same place for the same reason:
        // drop the light-client touched-key resolver caches. They map a
        // surrogate id to its canonical name and were cached for the connection
        // lifetime on the premise that the mapping is immutable. A rollback is
        // exactly where that premise fails, because it deletes index_tickers /
        // index_addresses rows above the reorg point and FREES their dense ids for
        // createTicker/createAddress to reassign to whatever the new chain interns.
        // (createTicker documents the same hazard from the other side: it refuses
        // to mint under suppressIndexIdCreation because resurrecting a deleted id
        // would re-open the wire ^<id> fork.)
        //
        // A stale entry yields NO leaf and no error rather than a wrong one: the
        // touched key is recorded under the OLD name, getNetBalance matches
        // nothing, _leafOrNull turns 0 into null, and the commitment deletes a key
        // that never existed. The block's balances_root then comes out
        // byte-identical to its predecessor's and the real leaf is never written.
        //
        // Cleared HERE, immediately after commit and beside the block-time memo,
        // not at the end of rollback(): a throw between here and there would skip
        // it on an already-committed rollback, which is precisely the stale-cache
        // state this prevents. Clearing is cheap (pure memoisation, refilled on
        // demand); invalidating per deleted id would mean enumerating rows this
        // pass has already deleted.
        if(this.indexerDb){
            this.indexerDb._smtTickNameCache    = null;
            this.indexerDb._smtAddressNameCache = null;
        }
        // Still needed on its own after db.clearSmtNameCaches() was wired into
        // every transaction ABORT: this frees ids by COMMITTING deletes, an abort
        // frees them by un-assigning them, and neither implies the other.

        // Invalidate the early-decide tally watermark. This reorg may have deleted
        // and re-added ledger, vote, and delegation rows at or above block_index (and reused
        // action_index values), so any cached poll fingerprint could now match spuriously and
        // wrongly skip a re-tally on the replay. Drop them all; the forward replay re-tallies
        // each armed poll on first sight, exactly as on a fresh process.
        if(this.indexerDb && typeof this.indexerDb.clearPollTallyWatermark === 'function') this.indexerDb.clearPollTallyWatermark();

        // Destructive rollback is done and committed; clear the in-progress marker so
        // /health reflects a caught-up node again (#1812).
        if(this.indexer) this.indexer.stallReason = null;
    },

    // Deliver the write-ahead hub retractions committed above (HUB-RETRACT-2). Each was already
    // durably staged in pending_hub_pushes inside the rollback transaction, so even a crash right
    // here loses nothing: HubPushQueue drains the surviving rows on restart. Here we just try an
    // IMMEDIATE live delivery to prune the hub's orphaned oracle_prices / cross_chain_calls /
    // cross_chain_matches / bridge_transfers rows without waiting for the queue's backoff, and drop the durable row
    // on success. Any failure simply leaves the row for the queue (retractions are idempotent and
    // generation-fenced, so re-delivery is safe).
    //
    // The immediate delivery is OPEN-ENDED (last_action_index = null): it runs before any forward
    // replay re-publishes rows, so an open-ended delete hits only orphans. The durable fallback
    // row is CLOSED-range (bounded by lastActionIndex) because a queued drain runs later, after
    // replay may have re-published rows above lastActionIndex that must be preserved.
    //
    // Quiesce the durable queue across delivery so an in-flight drain cannot race these rows (item
    // 5297); resume() is in the finally so the queue always restarts even if a delivery throws.
    async deliverStagedRetractions(firstActionIndex, retractionGeneration, stagedRetractions){
        if(stagedRetractions.length > 0){
            // await: pause() now waits for any in-flight drain to finish (HUB-RETRACT-3), so a
            // pre-fetched stale forward push cannot land on the hub after our retraction below.
            if(this.hubPushQueue) await this.hubPushQueue.pause();
            try {
                let coin       = this.config['COIN'];
                let liveByType = {
                    price_retraction: (last) => this.hubClient.retractPriceRange(coin, firstActionIndex, last, retractionGeneration),
                    xcall_retraction: (last) => this.hubClient.retractXcallRange(coin, firstActionIndex, last, retractionGeneration),
                    match_retraction: (last) => this.hubClient.retractMatchRange(coin, firstActionIndex, last, retractionGeneration),
                    bridge_retraction: (last) => this.hubClient.retractBridgeRange(coin, firstActionIndex, last, retractionGeneration),
                    // Takes the staged PAYLOAD rather than a range ceiling: this retraction names
                    // one batch, and the live and deferred deliveries are byte-identical because
                    // there is no open-ended form to narrow. It is the same payload the durable
                    // row carries, so a queued retry cannot diverge from what was tried here.
                    attest_batch_retraction: (last, payload) => this.hubClient.retractAttestBatch(coin, payload),
                };
                for(let r of stagedRetractions){
                    try {
                        await liveByType[r.pushType](null, r.payload);
                        await this.indexerDb.markHubPushDelivered(r.id);
                    } catch(err) {
                        // Live delivery failed; the durable (closed-range) write-ahead row stays for
                        // HubPushQueue to retry with backoff. A dropped retraction would otherwise
                        // leave orphaned 'finalized' hub rows serving fleet-wide (stale prices, XCALL
                        // relay rows eligible for re-injection, matches eligible for settlement,
                        // bridge transfers eligible to mint on the destination chain).
                        getLogger().warn('Rollback: live ' + r.pushType + ' failed; durable row ' + r.id +
                            ' will be retried by HubPushQueue:', err && err.message);
                    }
                }
            } finally {
                if(this.hubPushQueue) this.hubPushQueue.resume();
            }
        }
    },

    // Structured completion summary so a successful rollback is distinguishable
    // from a hung/partial one in the log stream (#1812): target block, the rolled-
    // back action range, the staged hub retractions, and elapsed time.
    logRollbackSummary(block_index, firstActionIndex, lastActionIndex, stagedRetractions, rollbackStartedAt){
        const elapsedMs     = Date.now() - rollbackStartedAt;
        const retractionIds = stagedRetractions.map(r => r.pushType + '#' + r.id);
        getLogger().info('Rollback complete: to block ' + block_index +
            ', action range [' + firstActionIndex + ', ' + lastActionIndex + ']' +
            ', staged retractions ' + (retractionIds.length ? retractionIds.join(', ') : 'none') +
            ', elapsed ' + elapsedMs + 'ms');
    },

};
