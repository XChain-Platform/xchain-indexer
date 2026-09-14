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
 * XChain Indexer - Price barriers
 *
 * The mirror sync barrier chain and its two price-read members. The chain evaluates the
 * price-read predicate once per block; the price barriers (height and time) and the
 * oracle barrier are the ones a block that provably reads no price may skip. The other
 * members, in chain order, are in ./mirror_barriers.js. Installed onto XChainIndexer.prototype by ../XChainIndexer.js.
 *
 ********************************************************************/

const { getLogger } = require('../observability/index.js');

module.exports = {

    // The mirror sync barriers in block-loop order. Each returns true when it DEFERRED the
    // block (stallReason set, no transaction open); the first defer ends the chain and the
    // loop retries the block on its next pass.
    async deferOnSyncBarriers(blockToParse, blockTime, blockTransactions, anchorHorizonBound){
        // Only blocks that can actually READ the mirror take these waits.
        // The hub finalizes one price round per 600s, the same cadence as a BTC
        // block, so a tip block is essentially never covered by a round anchored at
        // or after it and burns the full timeout every time. A block that reads no
        // price is byte-identical against a current mirror and a stale one, so that
        // wait buys nothing. blockMayReadPrice is a deliberate over-approximation
        // (see price_read_predicate.js): any transaction at all means wait, and the
        // end-of-block passes, which can run the VM on a transaction-free block, are
        // caught fail-closed at the read itself by db.assertPriceBarrierNotSkipped().
        // Safe without a flag day because a skipped barrier changes no hashed value,
        // only whether this node paused first.
        let mayReadPrice = this.evaluatePriceBarrier(blockToParse, blockTransactions);
        return await this.deferOnPriceSync(blockToParse, blockTime, mayReadPrice)
            || await this.deferOnOracleSync(blockToParse, blockTime, mayReadPrice)
            || await this.deferOnMatchSync(blockToParse, blockTime)
            || await this.deferOnCallSync(blockToParse, blockTime)
            || await this.deferOnBridgeSync(blockToParse, blockTime)
            || await this.deferOnPolicySync(blockToParse, blockTime)
            || await this.deferOnDirectCallPresence(blockToParse, blockTime)
            || await this.deferOnAnchorAttestSync(blockToParse, blockTime, anchorHorizonBound)
            || await this.deferOnAttestResponseSync(blockToParse, blockTime)
            || await this.deferOnSnapshotSync(blockToParse, blockTime);
    },

    // Price-sync barrier: don't process this block until the local price mirror has
    // caught up to it. Native-coin fee validation reads the latest finalized price
    // round at or before the block height; if two operators hold different sync
    // states they can read different rounds, compute different fee thresholds, and
    // diverge the ledger. Waiting until the mirror covers this block closes that race.
    //
    // Price rounds are anchored to BTC block heights, so this height comparison is
    // only meaningful for a BTC indexer; other chains' block heights are not
    // comparable to the anchor. Non-BTC chains gate on the time-keyed barrier
    // instead, so the mirror must hold every round with block_timestamp <= this
    // block's time. No barrier when hub-db sync is disabled (single-host: the local
    // hub DB is the hub itself, always current).
    //
    // The time-keyed barrier is NOT conditioned on the
    // NATIVE_FEE_PRICE_TIME_GATE flag-day. It was first introduced as the
    // twin of that gate's fee-validation change (the time-keyed db.getLatestPrice
    // selectByTime), but native fees are not the only time-keyed reader of
    // price_snapshots. FIAT dispenser settlement reads the table bounded on
    // `block_timestamp <= this block's time` on EVERY chain from day one, in both
    // modes: reversePriceMatch directly, and reverseOraclePriceMatch for the
    // validator coin price behind a user oracle quote. Gating the barrier on the
    // fee flag-day therefore left LTC/DOGE mainnet settling FIAT dispenses against
    // an unbarriered mirror below 1786060800, where two operators with different
    // mirror states credit different token amounts for the same payment and fork
    // the chain. The barrier now runs whenever sync is enabled.
    //
    // Widening a barrier is safe in both directions that matter. It cannot fork:
    // it is a node-local WAIT decision, never persisted or hashed, so a reindex
    // (mirror far ahead of the tip) opens it immediately and replays byte-identically
    // (see the HUB_SYNC_WATERMARK_GRACE_S note in hub_db_sync.js on why barriers
    // need no activation gate). It cannot freeze a quiet chain either:
    // _priceTimeSyncSatisfied's second case opens on the hub's stream watermark, so
    // a chain with no rounds yet, or sitting in a round gap, proceeds once the hub
    // confirms it has sent everything through this instant. Only a genuinely-behind
    // mirror (hub unreachable, watermark frozen) defers, which is the intent.
    // Strictly-stricter than the fee query below the flag-day, which is the safe
    // direction: an extra wait can delay a block but can never change its verdict.
    // The two barriers are ADDITIVE on BTC, not alternatives. The height
    // barrier alone does NOT imply time coverage, and FIAT settlement reads by
    // time, so BTC needed the time barrier as much as LTC/DOGE did.
    //
    // Why the height check is not sufficient. `_priceSyncSatisfied`'s first case is
    // a pure `priceSyncHeight >= blockHeight` test, where priceSyncHeight is the max
    // `reference_block` in the local mirror. A round's `reference_block` is the BTC
    // height it anchors to; its `block_timestamp` is the wall-clock instant the
    // validators STAMPED it (xchain-hub PriceAggregator: both arrive together in the
    // round push, and the two are independent quantities). Bitcoin lets a miner
    // timestamp a block up to 2 hours ahead of network-adjusted time, so a
    // forward-dated block H is processed with a `blockTime` that real wall-clock has
    // not reached yet. One local round anchored at >= H satisfies the height barrier
    // immediately, while for the next two hours the hub keeps finalizing rounds whose
    // `block_timestamp` is still <= blockTime and therefore still INSIDE the
    // `[blockTime - FIAT_DISPENSER_PRICE_WINDOW, blockTime]` range that
    // getPricesInTimeRange scans, each one newer than the last under its
    // `block_timestamp DESC, round_number DESC` ordering. Two operators whose mirrors
    // stopped at different rounds in that window read a different newest price,
    // reversePriceMatch floors a different unit count, and the dispense credits a
    // different amount: a fork. A fresh resync is the worst case, because its mirror
    // holds every one of those rounds while the live node that first processed H
    // held none of them. That is exactly the live-node-vs-resync divergence the
    // mirror barriers exist to close, and the height-keyed one does not close it.
    //
    // The height barrier is RETAINED rather than replaced: below the
    // NATIVE_FEE_PRICE_TIME_GATE flag-day, native-fee validation still selects the
    // latest round by HEIGHT (db.getLatestPrice), so dropping it would un-barrier the
    // fee path and diverge a from-genesis replay. The two gate different readers of
    // the same table and both are needed.
    //
    async deferOnPriceSync(blockToParse, blockTime, mayReadPrice){
        if(this.hubDbSync && mayReadPrice && this.config['COIN'] === 'BTC'){
            try {
                await this.hubDbSync.waitForPriceSyncHeight(blockToParse, this.priceSyncTimeoutMs, blockTime);
            } catch(err){
                // Defer the block: lastIndexerBlock is not advanced, so the outer loop
                // retries this same block after the sleep interval rather than processing
                // it against a stale price copy. No transaction is open yet.
                getLogger().warn('Deferring block ' + blockToParse + ' (price sync): ', err);
                this.stallReason = 'price_sync_barrier';
                this.stallClearsAt = null;          // the height case can clear early
                return true;
            }
        }
        if(this.hubDbSync && mayReadPrice){
            try {
                await this.hubDbSync.waitForPriceSyncTime(blockTime, this.priceSyncTimeoutMs, blockToParse);
            } catch(err){
                // Same defer semantics as the height barrier above.
                getLogger().warn('Deferring block ' + blockToParse + ' (price time-sync): ', err);
                this.stallReason = 'price_sync_barrier';
                // This barrier waits on WALL CLOCK. It is satisfied once a
                // round at/past blockTime is mirrored, or the hub's stream watermark
                // passes blockTime + grace; both advance only as real time does. Record
                // that instant so a future-stamped block is not reported as a wedge
                // while the wait is expected and self-clearing.
                this.stallClearsAt = this.barrierClearsAtHeightAware(blockTime, 'priceWatermarkGraceS', blockToParse);
                return true;
            }
        }
        return false;
    },

    // Oracle-price sync barrier (ALL chains): FIAT dispenser settlement
    // (reverseOraclePriceMatch) reads oracle_prices gated by effective_at <= blockTime.
    // If two distributed indexers enter this block with different oracle_prices mirror
    // states they can settle the same FIAT dispenser at different amounts and silently
    // fork the ledger. Wait until the local oracle mirror holds every price effective
    // at or before this block's time. Oracle prices are keyed by wall-clock effective_at
    // (not BTC height), so unlike the price barrier this applies on every chain. The
    // barrier is a no-op when sync is disabled or the mirror holds no oracle prices at
    // all (deployments without FIAT oracles), so non-oracle chains never stall on it.
    // Same barrier gate as the price barriers above: oracle_prices has the same
    // reader set (FIAT settlement via reverseOraclePriceMatch, the DISPENSER
    // create's oracle-fee quote), so a block that reaches neither reads nothing
    // here either, and the choke-point assertion covers the rest.
    async deferOnOracleSync(blockToParse, blockTime, mayReadPrice){
        if(this.hubDbSync && mayReadPrice){
            try {
                await this.hubDbSync.waitForOracleSyncTimestamp(blockTime, this.priceSyncTimeoutMs, blockToParse);
            } catch(err){
                // Defer the block (same retry semantics as the price barrier above): the
                // counter is not advanced, so this block is retried rather than settled
                // against a stale oracle copy. No transaction is open yet.
                getLogger().warn('Deferring block ' + blockToParse + ' (oracle sync): ', err);
                this.stallReason = 'oracle_sync_barrier';
                this.stallClearsAt = this.barrierClearsAtHeightAware(blockTime, 'oracleWatermarkGraceS', blockToParse);
                return true;
            }
        }
        return false;
    }
};
