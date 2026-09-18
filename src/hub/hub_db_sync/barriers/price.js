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
 * XChain Indexer - Hub DB Sync Client: price barriers
 *
 * The height-keyed and time-keyed price_snapshots barriers and the refresh that
 * feeds both, plus the reconnect-edge refresh of every barrier.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const { getLogger } = require('../../../observability/index.js');
const { isPreBatchEraFloor } = require('../../../consensus/gates/price_batching_floor_gate.js');

module.exports = {

    // Re-read EVERY barrier height/timestamp from the local mirror and release the
    // now-satisfied waiters. The in-memory heights only advance on stream/bootstrap
    // events, so a dropped socket can leave them frozen behind a mirror that is
    // actually current, so deferred blocks wait out the full 60s self-heal
    // timeout (per-block, biting faster chains hardest). Calling this on the
    // reconnect edge clears those waiters immediately from data already local.
    // Cheap (MAX()/MAX-timestamp reads) and idempotent; each refresh is internally
    // guarded so one failure can't abort the others.
    async refreshAllSyncHeights() {
        try { await this.refreshPriceSyncHeight(); }     catch (e) { /* internally guarded */ }
        try { await this.refreshOracleSyncTimestamp(); } catch (e) { /* internally guarded */ }
        try { await this.refreshMatchSyncTimestamp(); }  catch (e) { /* internally guarded */ }
        try { await this.refreshCallSyncTimestamp(); }   catch (e) { /* internally guarded */ }
        try { await this.refreshBridgeSyncTimestamp(); } catch (e) { /* internally guarded */ }
        try { await this.refreshPolicySyncTimestamp(); } catch (e) { /* internally guarded */ }
        try { await this.releaseSnapshotWaiters(); }     catch (e) { /* internally guarded */ }
    },

    // Recompute the highest finalized price block present in the local price_snapshots
    // copy and release any barrier waiters that are now satisfied. Called after every
    // successful sync of the table (bootstrap, poll, live insert, reorg retraction).
    async refreshPriceSyncHeight() {
        let height = 0, maxTs = 0;
        try {
            // Two separate single-MAX queries, not one SELECT carrying both. A single
            // statement with two MAX()s over different columns defeats MariaDB's index-only
            // min/max optimization (it needs one clean index range per aggregate) and falls
            // back to a full scan of price_snapshots - unbounded and hub-mirrored, so this
            // is the one mirrored table a fleet-wide scan actually shows up on (ATTEST lane
            // 2026-09-05: 126MB/s reads at innodb_buffer_pool_size=128MB). Split, each query
            // leads on `status` into its own covering index (idx_status_block_round for
            // reference_block, idx_status_timestamp_round for block_timestamp - both defined
            // in src/sql/price_snapshots.sql) and MariaDB resolves it as a single index
            // lookup ("Select tables optimized away") instead of a table scan.
            let hRow  = await this.hubDb.doQuery(
                "SELECT MAX(reference_block) AS h FROM price_snapshots WHERE status = 'finalized'"
            );
            let tsRow = await this.hubDb.doQuery(
                "SELECT MAX(block_timestamp) AS ts FROM price_snapshots WHERE status = 'finalized'"
            );
            if (hRow.length  > 0 && hRow[0].h   != null) height = Number(hRow[0].h);
            if (tsRow.length > 0 && tsRow[0].ts != null) maxTs  = Number(tsRow[0].ts);
        } catch (e) {
            return;                                         // table not ready yet; leave height untouched
        }
        this.priceSyncHeight       = height;
        this.priceSyncMaxTimestamp = maxTs;
        this.priceBootstrapped     = true;                  // mirror read successfully at least once
        this.releasePriceWaiters();
        this.releasePriceTimeWaiters();
    },

    // Whether the price mirror is caught up enough to safely process a block at
    // (blockHeight, blockTime). Two satisfied cases:
    //   1. A finalized round anchored at or past this height is local; every round
    //      eligible at this height is therefore local (rows arrive id-ordered, and
    //      live rows are buffered until the bootstrap drain completes, so the
    //      local mirror is always a CONTIGUOUS run of the hub's table ending at its
    //      newest row; a fresh round streamed mid-drain can no longer raise the
    //      height over still-missing earlier rounds. See bufferPriceEvent, #2422).
    //      Under the bootstrap bound that run starts at the mirror floor
    //      rather than at the hub's first row, which is sound for exactly the blocks
    //      the floor was derived from and no others - hence notePriceMirrorFloor,
    //      which vetoes this case outright once a block below the floor turns up.
    //   2. The hub's stream watermark has passed this block's time plus a grace
    //      margin covering PBFT finalization lag (the hub has told us everything
    //      it produced through that instant, so the set of rounds at or before this
    //      height is FINAL (a round anchored ≤ H is finalized within grace of
    //      time(H); none can appear later). This is what lets a fresh distributed
    //      BTC indexer bootstrap on a chain with no rounds yet (#1986) and lets
    //      the tip proceed deterministically through an oracle round gap, while a
    //      genuinely-behind mirror (hub unreachable → watermark frozen) still
    //      defers). blockTime may be absent (legacy callers), so then only case 1.
    //   3. ADMISSION ERA (the mirror-admission family's consumer flag day): the hub's height
    //      watermark for price_snapshots on this chain has reached B - ADMIT_MARGIN_BLOCKS,
    //      so every round whose admission height can be at or below B has terminated and been
    //      broadcast. Above the activation this REPLACES case 2 rather than joining it: case 2
    //      is the one clause in this predicate that reads t(B), and removing t(B) from every
    //      member's predicate is the entire point of the change. Case 1 is untouched, because
    //      it was already a height comparison.
    priceSyncSatisfied(blockHeight, blockTime) {
        // A mirror that was bounded and has since been asked for a block below its
        // floor holds neither case: its height says "caught up" while rounds that block can
        // read are absent. Defer until the full re-mirror lands. Never set on an unbounded
        // mirror, so this costs nothing on the default path.
        if (this._priceMirrorRefloor) return false;
        if (this.priceSyncHeight >= blockHeight) return true;
        if (this.admissionActiveAt(blockHeight))
            return this.priceBootstrapped && this.heightSatisfied('price_snapshots', blockHeight);
        if (this.priceBootstrapped && Number.isFinite(blockTime) &&
            this.streamWatermark >= blockTime + this.priceWatermarkGraceS) return true;
        return false;
    },

    // Resolve any pending waiters whose target is now covered.
    releasePriceWaiters() {
        if (this._priceWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._priceWaiters) {
            if (this.priceSyncSatisfied(w.height, w.blockTime)) {
                clearTimeout(w.timer);
                w.resolve(this.priceSyncHeight);
            } else {
                stillWaiting.push(w);
            }
        }
        this._priceWaiters = stillWaiting;
    },

    // Block-processing sync barrier. Resolves once the local price_snapshots copy holds a
    // finalized round anchored at reference_block >= blockHeight (i.e. this node has caught
    // up to the hub for that block, so every round eligible at this block is already local).
    // Rejects after timeoutMs so the caller can DEFER the block and retry; never validate
    // native-coin fees against a stale local mirror.
    //
    // Price rounds are anchored to the oracle reference chain's block height (reference_block),
    // so this comparison is only meaningful for an indexer whose own chain IS that reference
    // chain. Callers on other chains must not gate on this; see XChainIndexer.
    waitForPriceSyncHeight(blockHeight, timeoutMs, blockTime) {
        blockHeight = Number(blockHeight);
        blockTime   = Number(blockTime);
        // Nothing to wait on when sync is disabled (single-host: the local hub DB is the hub
        // itself, always current) or the target is not a finite height.
        if (!this.enabled || !Number.isFinite(blockHeight)) return Promise.resolve(this.priceSyncHeight);
        // PRE-BATCH ERA. No price round existed on this network at this block's time, so
        // the eligible set is empty on every node and there is nothing to wait for: the
        // barrier resolves rather than paying its full timeout on a block no round can
        // ever cover (the chain-only replay cost, measured 2026-09-09). This precedes
        // notePriceMirrorFloor deliberately - such a block reads no round at all, so it
        // is not evidence that a bounded mirror is short, and tripping a full re-mirror on
        // it is part of the same replay cost.
        if (isPreBatchEraFloor(blockTime, this._priceEraFloorS)) return Promise.resolve(this.priceSyncHeight);
        // Before judging the block, judge the mirror against the block.
        this.notePriceMirrorFloor(blockTime);
        if (this.priceSyncSatisfied(blockHeight, blockTime)) return Promise.resolve(this.priceSyncHeight);

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { height: blockHeight, blockTime: blockTime, resolve: resolve, timer: null };
            waiter.timer = setTimeout(async () => {
                // Self-heal before giving up: the in-memory priceSyncHeight only
                // advances when a stream/bootstrap event drives refreshPriceSyncHeight,
                // so a missed refresh on a stream/reconnect edge can leave it frozen
                // behind a local mirror DB that is actually current, and then EVERY
                // tip block deferred the full timeout even though the data was present
                // (BTC mainnet 2026-06-13: in-memory stuck at the restart block while
                // price_snapshots had caught up; only a process restart cleared it).
                // Re-read the DB here; refreshPriceSyncHeight resolves+clears this
                // waiter via releasePriceWaiters if the mirror has since caught up.
                try { await this.refreshPriceSyncHeight(); } catch (e) { /* fall through to reject */ }
                if (this.priceSyncSatisfied(blockHeight, blockTime)) return;   // already resolved by the refresh
                this._priceWaiters = this._priceWaiters.filter(w => w !== waiter);
                reject(new Error('price sync barrier timed out after ' + ms + 'ms waiting for block ' +
                                 blockHeight + ' (price mirror at ' + this.priceSyncHeight +
                                 ', stream watermark at ' + this.streamWatermark + ')' +
                                 (this.admissionActiveAt(blockHeight)
                                     ? this.heightTail('price_snapshots', blockHeight) : '')));
            }, ms);
            this._priceWaiters.push(waiter);
        });
    },

    // Whether the price mirror is caught up enough to safely process a block at
    // blockTime. Applies on EVERY chain (BTC included, additively with the
    // height-keyed barrier) and is not gated on the NATIVE_FEE_PRICE_TIME_GATE
    // flag-day; H-3 named the fee-query half of that work, not this barrier.
    // Two satisfied cases, mirroring priceSyncSatisfied:
    //   1. The mirror already holds a finalized round whose consensus timestamp
    //      is at/past this block's time, so every round eligible at this block
    //      (block_timestamp <= blockTime) is already local.
    //   2. The hub's stream watermark has passed this block's time plus the
    //      grace margin: the hub has sent everything it produced through that
    //      instant, so the eligible set is FINAL. This is also what lets a
    //      chain proceed deterministically when no rounds exist yet, while a
    //      genuinely-behind mirror (hub unreachable → watermark frozen) defers.
    //   3. ADMISSION ERA: the price_snapshots height watermark for this chain has reached
    //      B - margin. This member has NO height case below the activation at all (that is
    //      what makes it the one that runs on every chain while member 1 is BTC-gated), so
    //      above it BOTH clock cases are replaced: a round's block_timestamp is a time, and
    //      comparing one against t(B) is exactly the question the binding-rule change retires.
    priceTimeSyncSatisfied(blockTime, blockHeight = null) {
        // Evaluated BEFORE the blockTime guard below, deliberately: above the activation an
        // unreadable t(B) is not a reason to certify anything, and falling through to that
        // `return true` would be a fail-OPEN on the one axis that may never have one.
        if (this.admissionActiveAt(blockHeight))
            return !this._priceMirrorRefloor && this.priceBootstrapped &&
                   this.heightSatisfied('price_snapshots', blockHeight);
        if (!Number.isFinite(blockTime)) return true;       // nothing to gate on
        if (this._priceMirrorRefloor)    return false;      // see priceSyncSatisfied
        if (this.priceBootstrapped && this.priceSyncMaxTimestamp >= blockTime) return true;
        if (this.priceBootstrapped &&
            this.streamWatermark >= blockTime + this.priceWatermarkGraceS) return true;
        return false;
    },

    // Resolve any pending time-keyed waiters whose target is now covered.
    releasePriceTimeWaiters() {
        if (this._priceTimeWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._priceTimeWaiters) {
            if (this.priceTimeSyncSatisfied(w.ts, w.height)) {
                clearTimeout(w.timer);
                w.resolve(this.priceSyncMaxTimestamp);
            } else {
                stillWaiting.push(w);
            }
        }
        this._priceTimeWaiters = stillWaiting;
    },

    // Block-processing sync barrier for every time-keyed reader of price_snapshots:
    // native-coin fee validation on non-reference chains (H-3) AND FIAT dispenser
    // settlement, which reads by time on all chains. Resolves once the local
    // price_snapshots copy holds every finalized round with block_timestamp <= this
    // block's time, so a time-gated selection reads the same round on every indexer of
    // this chain. Rejects after timeoutMs so the caller can DEFER the block and retry;
    // never settle or validate against a stale local mirror. Runs on BTC too, ADDITIVELY
    // with the height-keyed waitForPriceSyncHeight barrier above, which is retained for
    // the height-selected fee query below the flag-day (XChainIndexer.js:877-932).
    //
    // `blockHeight` is B, the block being processed on THIS chain, and it is what the
    // admission-era predicate compares. Optional so the six single-argument unit callers and
    // any hand-built caller keep today's behaviour exactly.
    waitForPriceSyncTime(blockTime, timeoutMs, blockHeight = null) {
        blockTime = Number(blockTime);
        if (!this.enabled || !Number.isFinite(blockTime)) return Promise.resolve(this.priceSyncMaxTimestamp);
        // PRE-BATCH ERA, same escape and same ordering as the height barrier above.
        if (isPreBatchEraFloor(blockTime, this._priceEraFloorS)) return Promise.resolve(this.priceSyncMaxTimestamp);
        this.notePriceMirrorFloor(blockTime);            // same check as the height barrier
        if (this.priceTimeSyncSatisfied(blockTime, blockHeight)) return Promise.resolve(this.priceSyncMaxTimestamp);

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { ts: blockTime, height: blockHeight, resolve: resolve, timer: null };
            waiter.timer = setTimeout(async () => {
                // Same self-heal as waitForPriceSyncHeight: re-read the mirror
                // before giving up, in case a refresh was missed on a stream edge.
                try { await this.refreshPriceSyncHeight(); } catch (e) { /* fall through to reject */ }
                if (this.priceTimeSyncSatisfied(blockTime, blockHeight)) return;   // resolved by the refresh
                this._priceTimeWaiters = this._priceTimeWaiters.filter(w => w !== waiter);
                reject(new Error('price time-sync barrier timed out after ' + ms + 'ms waiting for block time ' +
                                 blockTime + ' (mirror max round timestamp ' + this.priceSyncMaxTimestamp +
                                 ', stream watermark at ' + this.streamWatermark + ')' +
                                 (this.admissionActiveAt(blockHeight)
                                     ? this.heightTail('price_snapshots', blockHeight) : '')));
            }, ms);
            this._priceTimeWaiters.push(waiter);
        });
    },

};
