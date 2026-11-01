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
 * XChain Indexer - Hub DB Sync Client: oracle, match and call barriers
 *
 * The content-watermark barriers over oracle_prices, cross_chain_matches and
 * cross_chain_calls: each a refresh, a predicate, a waiter release and a wait.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const { getLogger } = require('../../../observability/index.js');
const { strictHubRead } = require('../mirror_write.js');
const { RELAY_MARGIN_FLOOR_S, MATCH_FINALIZED_AT_SQL } = require('./relay_margin.js');

module.exports = {

    // Recompute the highest effective_at present in the local oracle_prices copy and release
    // any barrier waiters that are now satisfied. Called after every successful sync of the
    // table (bootstrap, poll, live insert, reorg retraction). A NULL max (empty mirror) is a
    // valid result; it means this deployment has no oracle prices, which oracleBootstrapped
    // distinguishes from "not synced yet".
    async refreshOracleSyncTimestamp(armBootstrap = this._bootstrapDrained) {
        let ts = null;
        try {
            let rows = await strictHubRead(this.hubDb, 'SELECT MAX(effective_at) AS ts FROM oracle_prices');
            if (rows.length > 0 && rows[0].ts !== null) ts = Number(rows[0].ts);
        } catch (e) {
            return;                                         // table not ready yet; leave state untouched
        }
        this.oracleSyncTimestamp = ts;                      // number, or null when the mirror holds no oracle prices
        // Arm the empty-mirror barrier flag only when a full bootstrap drain is in
        // effect. A refresh from the reconnect edge (refreshAllSyncHeights, before
        // re-bootstrap) or a single live row arriving mid-partial-bootstrap defaults
        // armBootstrap to _bootstrapDrained (false then), so it cannot arm the NULL
        // fast path in oracleSyncSatisfied against a holed mirror and fork (#1788).
        if (armBootstrap) this.oracleBootstrapped = true;   // read at least once AND fully drained
        this.releaseOracleWaiters();
    },

    // Whether the local oracle mirror is caught up enough to safely settle a block at blockTime.
    // Two distinct "satisfied" cases:
    //   1. The mirror has been read and holds no oracle prices at all; nothing to gate on.
    //   2. The mirror holds prices whose newest effective_at is at or past this block's time,
    //      so every price effective at or before blockTime is already local.
    //   3. ADMISSION ERA: either the oracle_prices height watermark has reached B - 1, or
    //      a hub that has published admission evidence has streamed through blockTime plus
    //      grace without producing another row. The latter keeps a quiet table from making
    //      its last content timestamp an indefinite barrier.
    oracleSyncSatisfied(blockTime, blockHeight = null) {
        const certified = this.oracleBootstrapped &&
            this.tableCertifiedOnCurrentConnection('oracle_prices');
        if (!certified) return false;
        if (this.oracleSyncTimestamp === null) return true;
        const streamSatisfied = this.tableWatermark('oracle_prices') >= blockTime + this.oracleWatermarkGraceS;
        if (this.admissionActiveAt(blockHeight)) {
            if (this.admissionStreamSatisfied('oracle_prices', streamSatisfied)) return true;
            return this.heightSatisfied('oracle_prices', blockHeight);
        }
        if (this.oracleSyncTimestamp !== null && this.oracleSyncTimestamp >= blockTime) return true;
        // Stream watermark: the hub has sent us every row it produced through
        // blockTime + grace, so the set of prices effective at or before this
        // block is final, so quiet oracles must not stall the chain (#1984). PRICE
        // v1 rows are stamped 24 hours forward, so the grace only needs to cover
        // ordinary hub-to-mirror stream lag, like the match and call barriers.
        if (streamSatisfied) return true;
        return false;
    },

    // Resolve any pending waiters whose target time is now covered.
    releaseOracleWaiters() {
        if (this._oracleWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._oracleWaiters) {
            if (this.oracleSyncSatisfied(w.ts, w.height)) {
                clearTimeout(w.timer);
                w.resolve(this.oracleSyncTimestamp);
            } else {
                stillWaiting.push(w);
            }
        }
        this._oracleWaiters = stillWaiting;
    },

    // Block-processing sync barrier for FIAT dispenser settlement. Resolves once the local
    // oracle_prices copy holds every price effective at or before this block's median time
    // (block_time), so reverseOraclePriceMatch() reads the same effective price set on every
    // indexer. Rejects after timeoutMs so the caller can DEFER the block and retry; never
    // settle a FIAT dispenser against a stale local oracle mirror.
    //
    // Oracle prices are keyed by wall-clock effective_at (not a chain block height), so unlike
    // waitForPriceSyncHeight this comparison is meaningful (and required) on every chain.
    // Resolves immediately when sync is disabled (single-host: the local hub DB is the hub
    // itself, always current) or when the mirror is known to hold no oracle prices at all.
    waitForOracleSyncTimestamp(blockTime, timeoutMs, blockHeight = null) {
        blockTime = Number(blockTime);
        if (!this.enabled || !Number.isFinite(blockTime)) return Promise.resolve(this.oracleSyncTimestamp);
        if (this.oracleSyncSatisfied(blockTime, blockHeight)) return Promise.resolve(this.oracleSyncTimestamp);

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { ts: blockTime, height: blockHeight, resolve: resolve, timer: null };
            waiter.timer = setTimeout(async () => {
                // Self-heal before giving up, same as waitForPriceSyncHeight: the in-memory
                // oracleSyncTimestamp only advances when a stream/bootstrap event drives
                // refreshOracleSyncTimestamp, so a missed refresh on a stream/reconnect
                // edge can leave it stale behind a local mirror that is actually current,
                // and then every block deferred the full timeout even though the data was
                // present. Re-read the DB here; refreshOracleSyncTimestamp resolves+clears
                // this waiter via releaseOracleWaiters if the mirror has since caught up.
                try { await this.refreshOracleSyncTimestamp(); } catch (e) { /* fall through to reject */ }
                if (this.oracleSyncSatisfied(blockTime, blockHeight)) return;   // already resolved by the refresh
                this._oracleWaiters = this._oracleWaiters.filter(w => w !== waiter);
                reject(new Error('oracle sync barrier timed out after ' + ms + 'ms waiting for block_time ' +
                                 blockTime + ' (oracle mirror at ' + this.oracleSyncTimestamp + ')' +
                                 (this.admissionActiveAt(blockHeight)
                                     ? this.heightTail('oracle_prices', blockHeight) : '')));
            }, ms);
            this._oracleWaiters.push(waiter);
        });
    },

    // ── Cross-chain match sync barrier (mirrors the oracle_prices barrier) ──────

    // Recompute the highest effective_time present in the local cross_chain_matches copy
    // (finalized only) and release satisfied waiters. A NULL max (empty mirror) is valid.
    async refreshMatchSyncTimestamp(armBootstrap = this._bootstrapDrained) {
        let ts = null, finalizedTs = null;
        try {
            // Scope the watermark to matches that touch THIS coin (either leg), matching
            // the settlement query (src/db/cross_chain/index.js: WHERE ... AND (a_chain = ? OR b_chain = ?)) and
            // the snapshot-presence barrier. A global MAX(effective_time) could be bumped
            // past this block's time by an unrelated other-chain match (both legs on other
            // chains, still mirrored here because the hub broadcasts every match), letting
            // waitForMatchSync pass before every match effective for this coin is mirrored
            // locally, so two indexers settling the same chain could settle the same match at
            // divergent blocks and fork. Symmetric to the cross_chain_calls fix (item 4573).
            //
            // finalized_ts feeds the content shortcut (see matchContentCoverage): a
            // MAX(effective_time) over matches with different margins proves nothing about
            // the matches with the smaller one, since a DOGE/BTC match finalized first is
            // effective 1800 s after a DOGE/LTC match finalized a moment later.
            let where = "WHERE status = 'finalized'";
            let args  = [];
            let select = 'SELECT MAX(effective_time) AS ts';
            if (this.coin) {
                where += " AND (a_chain = ? OR b_chain = ?)";
                args = [this.coin, this.coin];
                select += ', ' + MATCH_FINALIZED_AT_SQL;
            }
            let rows = await strictHubRead(this.hubDb, select + " FROM cross_chain_matches " + where, args);
            if (rows.length > 0 && rows[0].ts !== null && rows[0].ts !== undefined) ts = Number(rows[0].ts);
            if (rows.length > 0 && rows[0].finalized_ts !== null && rows[0].finalized_ts !== undefined)
                finalizedTs = Number(rows[0].finalized_ts);
        } catch (e) {
            return;                                             // table not ready yet
        }
        this.matchSyncTimestamp = ts;
        this.matchCoveredTimestamp = this.matchContentCoverage(ts, finalizedTs);
        // Arm only under a full bootstrap drain; reconnect / live-row refreshes
        // default armBootstrap to _bootstrapDrained so they cannot arm the NULL
        // fast path from a holed mirror and fork (#1788).
        if (armBootstrap) this.matchBootstrapped = true;
        this.releaseMatchWaiters();
    },

    // The block time through which every match touching this chain is provably local,
    // or null when nothing proves it. With the local rows a prefix of the hub's
    // finalization order, a match still missing finalized no earlier than finalizedTs and
    // carries at least this chain's own margin floor (its margin is the larger of its two
    // legs' floors), so it is effective no earlier than finalizedTs plus that floor.
    // Without a coin (the explorer's display mirror) the unscoped MAX stands, as before.
    matchContentCoverage(ts, finalizedTs) {
        if (!this.coin) return ts;
        let floor = RELAY_MARGIN_FLOOR_S[this.coin];
        if (floor === undefined || finalizedTs === null) return null;
        return finalizedTs + floor;
    },

    // ADMISSION ERA: the cross_chain_matches height watermark for this chain has reached
    // B - 4, or a hub that has published admission evidence has streamed through blockTime
    // plus grace without producing another row. The empty-mirror escape survives unchanged,
    // except that it needs a drained connection: matchBootstrapped outlives a socket close,
    // and an empty scope proves nothing about a match finalized while the socket was down.
    matchSyncSatisfied(blockTime, blockHeight = null) {
        const certified = this.matchBootstrapped &&
            this.tableCertifiedOnCurrentConnection('cross_chain_matches');
        if (!certified) return false;
        if (this.matchSyncTimestamp === null) return true;
        const streamSatisfied = this.tableWatermark('cross_chain_matches') >= blockTime + this.matchWatermarkGraceS;
        if (this.admissionActiveAt(blockHeight)) {
            if (this.admissionStreamSatisfied('cross_chain_matches', streamSatisfied)) return true;
            return this.heightSatisfied('cross_chain_matches', blockHeight);
        }
        if (this.matchCoveredTimestamp !== null && this.matchCoveredTimestamp !== undefined &&
            this.matchCoveredTimestamp >= blockTime) return true;
        // Stream watermark: matches are stamped with the hub's wall clock at
        // finalization and broadcast immediately, so a watermark past this
        // block's time (plus clock-skew grace) means every match effective at
        // or before it is already local. Without this, the FIRST finalized
        // cross-chain match anywhere froze every distributed replica on every
        // chain until the next match arrived (#1984, live-repro'd: an LTC⇄DOGE
        // match stalled the BTC replica for 6+ cycles).
        if (streamSatisfied) return true;
        return false;
    },

    releaseMatchWaiters() {
        if (this._matchWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._matchWaiters) {
            if (this.matchSyncSatisfied(w.ts, w.height)) {
                clearTimeout(w.timer);
                w.resolve(this.matchSyncTimestamp);
            } else {
                stillWaiting.push(w);
            }
        }
        this._matchWaiters = stillWaiting;
    },

    // Block-processing barrier for the cross-chain settlement pass. Resolves once the local
    // cross_chain_matches copy holds every match effective at or before this block's time, so
    // every operator of this chain settles the same matches at the same block. Rejects after
    // timeoutMs so the caller can DEFER the block and retry; never settle against a stale
    // match mirror. Resolves immediately when sync is disabled or the mirror holds no matches.
    waitForMatchSync(blockTime, timeoutMs, blockHeight = null) {
        blockTime = Number(blockTime);
        if (!this.enabled || !Number.isFinite(blockTime)) return Promise.resolve(this.matchSyncTimestamp);
        if (this.matchSyncSatisfied(blockTime, blockHeight)) return Promise.resolve(this.matchSyncTimestamp);

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { ts: blockTime, height: blockHeight, resolve: resolve, timer: null };
            waiter.timer = setTimeout(async () => {
                // Self-heal before giving up, same as waitForPriceSyncHeight: a missed
                // refresh on a stream/reconnect edge can leave matchSyncTimestamp stale
                // behind a local mirror that is actually current. Re-read the DB here;
                // refreshMatchSyncTimestamp resolves+clears this waiter via
                // releaseMatchWaiters if the mirror has since caught up.
                try { await this.refreshMatchSyncTimestamp(); } catch (e) { /* fall through to reject */ }
                if (this.matchSyncSatisfied(blockTime, blockHeight)) return;   // already resolved by the refresh
                this._matchWaiters = this._matchWaiters.filter(w => w !== waiter);
                reject(new Error('match sync barrier timed out after ' + ms + 'ms waiting for block_time ' +
                                 blockTime + ' (match mirror at ' + this.matchSyncTimestamp + ')' +
                                 (this.admissionActiveAt(blockHeight)
                                     ? this.heightTail('cross_chain_matches', blockHeight) : '')));
            }, ms);
            this._matchWaiters.push(waiter);
        });
    },

    // ── Cross-chain call sync barrier (mirrors the match barrier exactly) ──────

    async refreshCallSyncTimestamp(armBootstrap = this._bootstrapDrained) {
        let ts = null, gated = null;
        try {
            // Scope the watermark to calls that touch THIS coin (target or source),
            // matching the snapshot-presence barrier below. A global MAX(effective_time)
            // could be bumped past this block's time by an unrelated other-chain call,
            // letting the barrier pass before every call effective for this coin is
            // mirrored locally, so two indexers settling the same chain could inject the
            // same XEXEC at divergent positions and fork (item 4573).
            //
            // gated_ts is the content shortcut's own watermark: only the rows this chain
            // APPLIES, a dispatch it is the target of and a result it is the source of
            // (getEffectiveUndispatchedCalls, getEffectiveUnprocessedCallResults). The
            // hub's call engine stamps each row with the margin of the chain that applies
            // it (xchain-hub src/cross_chain/call/plumbing.js relayEffectiveTime), so those
            // rows share this chain's margin and grow in finalization order, while a
            // dispatch this chain sent to BTC runs 2400 s ahead and vouches for nothing
            // here. Without a coin (the explorer's display mirror) the unscoped MAX stands.
            let where = "WHERE status = 'finalized'";
            let args  = [];
            let select = 'SELECT MAX(effective_time) AS ts';
            if (this.coin) {
                where += " AND (target_chain = ? OR source_chain = ?)";
                select += ", MAX(CASE WHEN (phase = 'dispatch' AND target_chain = ?) OR (phase = 'result' AND source_chain = ?)" +
                          ' THEN effective_time END) AS gated_ts';
                args = [this.coin, this.coin, this.coin, this.coin];
            }
            let rows = await strictHubRead(this.hubDb, select + " FROM cross_chain_calls " + where, args);
            if (rows.length > 0 && rows[0].ts !== null && rows[0].ts !== undefined) ts = Number(rows[0].ts);
            if (rows.length > 0 && rows[0].gated_ts !== null && rows[0].gated_ts !== undefined) gated = Number(rows[0].gated_ts);
        } catch (e) {
            return;                                             // table not ready yet
        }
        this.callSyncTimestamp = ts;
        this.callGatedSyncTimestamp = this.coin ? gated : ts;
        // Arm only under a full bootstrap drain; reconnect / live-row refreshes
        // default armBootstrap to _bootstrapDrained so they cannot arm the NULL
        // fast path from a holed mirror and fork (#1788).
        if (armBootstrap) this.callBootstrapped = true;
        this.releaseCallWaiters();
    },

    // ADMISSION ERA: the cross_chain_calls height watermark for this chain has reached
    // B - 4, or a hub that has published admission evidence has streamed through blockTime
    // plus grace without producing another row. The empty-mirror escape needs a drained
    // connection and the content shortcut reads the rows this chain applies, both for the
    // reasons given at the match member and refreshCallSyncTimestamp.
    callSyncSatisfied(blockTime, blockHeight = null) {
        const certified = this.callBootstrapped &&
            this.tableCertifiedOnCurrentConnection('cross_chain_calls');
        if (!certified) return false;
        if (this.callSyncTimestamp === null) return true;
        const streamSatisfied = this.tableWatermark('cross_chain_calls') >= blockTime + this.callWatermarkGraceS;
        if (this.admissionActiveAt(blockHeight)) {
            if (this.admissionStreamSatisfied('cross_chain_calls', streamSatisfied)) return true;
            return this.heightSatisfied('cross_chain_calls', blockHeight);
        }
        if (this.callGatedSyncTimestamp !== null && this.callGatedSyncTimestamp !== undefined &&
            this.callGatedSyncTimestamp >= blockTime) return true;
        // Stream watermark escape: a relay row is broadcast the moment the hub
        // finalizes it, so a watermark past this block's time plus the grace means
        // every relay row effective at/before it is already local. Without this
        // the FIRST cross-chain call anywhere would freeze every replica until
        // the next one arrived (the #1984 bug class).
        //
        // Uses callWatermarkGraceS, NOT the match grace it once borrowed: the two
        // producers stamp effective_time differently (CrossChainCallEngine stamps
        // now + a forward relay margin, so a call row lands ahead of the time it
        // applies at; CrossChainDexEngine stamps the finalization instant), so the
        // two barriers must be tunable apart even while the values are equal.
        if (streamSatisfied) return true;
        return false;
    },

    releaseCallWaiters() {
        if (this._callWaiters.length === 0) return;
        let stillWaiting = [];
        for (let w of this._callWaiters) {
            if (this.callSyncSatisfied(w.ts, w.height)) {
                clearTimeout(w.timer);
                w.resolve(this.callSyncTimestamp);
            } else {
                stillWaiting.push(w);
            }
        }
        this._callWaiters = stillWaiting;
    },

    // Block-processing barrier for the cross-chain call passes. Resolves once the local
    // cross_chain_calls copy holds every relay row effective at or before this block's
    // time, so every operator injects/delivers the same calls at the same block. Rejects
    // after timeoutMs so the caller can DEFER the block and retry.
    waitForCallSync(blockTime, timeoutMs, blockHeight = null) {
        blockTime = Number(blockTime);
        if (!this.enabled || !Number.isFinite(blockTime)) return Promise.resolve(this.callSyncTimestamp);
        if (this.callSyncSatisfied(blockTime, blockHeight)) return Promise.resolve(this.callSyncTimestamp);

        let ms = parseInt(timeoutMs);
        if (!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            let waiter = { ts: blockTime, height: blockHeight, resolve: resolve, timer: null };
            waiter.timer = setTimeout(async () => {
                // Self-heal before giving up, same as waitForPriceSyncHeight: a missed
                // refresh on a stream/reconnect edge can leave callSyncTimestamp stale
                // behind a local mirror that is actually current. Re-read the DB here;
                // refreshCallSyncTimestamp resolves+clears this waiter via
                // releaseCallWaiters if the mirror has since caught up.
                try { await this.refreshCallSyncTimestamp(); } catch (e) { /* fall through to reject */ }
                if (this.callSyncSatisfied(blockTime, blockHeight)) return;   // already resolved by the refresh
                this._callWaiters = this._callWaiters.filter(w => w !== waiter);
                reject(new Error('call sync barrier timed out after ' + ms + 'ms waiting for block_time ' +
                                 blockTime + ' (call mirror at ' + this.callSyncTimestamp + ')' +
                                 (this.admissionActiveAt(blockHeight)
                                     ? this.heightTail('cross_chain_calls', blockHeight) : '')));
            }, ms);
            this._callWaiters.push(waiter);
        });
    },

};
