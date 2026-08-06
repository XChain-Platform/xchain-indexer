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
 * XChain Indexer - Hub Push Queue
 *
 * Durable retry queue for best-effort pushes to xchain-hub.
 *
 * The PRICE handlers push validated rounds (PRICE v0) and oracle prices
 * (PRICE v1) to the hub. Those pushes are network calls and can fail when the
 * hub is restarting, overloaded, or partitioned. The raw on-chain action is
 * always retained locally in the `prices` table, but the hub never reads that
 * table, so a dropped push used to permanently remove the row from the hub's
 * oracle_prices / price_snapshots and from every indexer that mirrors the hub.
 *
 * To make those pushes durable, a failed push is persisted to the
 * `pending_hub_pushes` table. This poller drains that table on a fixed interval,
 * re-sending each row with exponential backoff until the hub accepts it (the
 * hub's pushpriceround / pushoracleprice handlers dedupe, so a replay the hub
 * already has returns cleanly). A row that keeps failing past the attempt cap is
 * marked `failed`, which stops the retries, and the same drain tick sweeps
 * terminal rows once they pass the retention window so the table stays bounded.
 *
 ********************************************************************/

class HubPushQueue {

    constructor(indexer, opts){
        opts = opts || {};
        this.indexer   = indexer;
        this.indexerDb = indexer.indexerDb;
        this.hubClient = indexer.hubClient;

        // How often the poller wakes to drain due rows.
        this.intervalMs    = opts.intervalMs    || parseInt(process.env.HUB_PUSH_RETRY_INTERVAL_MS) || 30000;
        // Backoff schedule: wait grows as base * 2^(attempts-1), capped at max.
        this.baseBackoffMs = opts.baseBackoffMs || parseInt(process.env.HUB_PUSH_RETRY_BASE_MS)     || 30000;
        this.maxBackoffMs  = opts.maxBackoffMs  || parseInt(process.env.HUB_PUSH_RETRY_MAX_MS)      || 600000;  // 10 min cap
        // Stop retrying a row after this many attempts (~30 min with defaults).
        this.maxAttempts   = opts.maxAttempts   || parseInt(process.env.HUB_PUSH_MAX_ATTEMPTS)      || 10;
        // Rows pulled per drain tick.
        this.batchSize     = opts.batchSize     || 50;
        // How long a terminal `failed` row survives before the drain sweeps it, and
        // how often that sweep runs. A retired row is out of the poller's reach but
        // still in the table, so without the sweep a long hub outage grows an
        // operational table with no ceiling (item 3462). The window is wide enough
        // that the failed count getStats publishes still describes recent reality.
        // Set HUB_PUSH_FAILED_RETENTION_SECONDS=0 to keep terminal rows forever.
        let retentionEnv = parseInt(process.env.HUB_PUSH_FAILED_RETENTION_SECONDS);
        this.failedRetentionSec = (opts.failedRetentionSec != null) ? opts.failedRetentionSec
            : (Number.isFinite(retentionEnv) ? retentionEnv : 7 * 24 * 3600);
        this.pruneIntervalMs = opts.pruneIntervalMs || parseInt(process.env.HUB_PUSH_PRUNE_INTERVAL_MS) || 3600000;
        this._lastPruneMs = 0;

        this.timer    = null;
        this.draining = false;
        // Promise that resolves when the currently in-flight drain() finishes; null when idle. Lets
        // pause() await an in-flight drain instead of returning while it is still mid-batch.
        this._drainDone = null;
        // Set by rollback.js around its post-commit retraction block so a deferred drain cannot
        // re-issue a stale open-ended retraction against the just-rolled-back range (item 5297).
        // Independent of `draining` (which only prevents overlapping drains).
        this.paused   = false;
    }

    // Pause the queue and WAIT for any in-flight drain to finish (HUB-RETRACT-3). Setting `paused`
    // stops any NEW drain tick, but a drain already mid-batch holds a pre-fetched set of rows in
    // memory and could deliver a stale forward push AFTER the caller's retraction runs, re-creating
    // an orphaned hub row the fence can no longer delete. Awaiting `_drainDone` closes that race: by
    // the time pause() resolves, no drain is running and none can start. Returns a promise so callers
    // do `await queue.pause()`. Safe to call when idle (resolves immediately).
    async pause(){
        this.paused = true;
        // A drain that already passed its paused-check and set draining=true has a live _drainDone;
        // await it. A drain starting after this line sees paused=true and returns before draining.
        if(this._drainDone) await this._drainDone;
    }
    resume(){ this.paused = false; }

    // Begin draining on an interval. No-op when no hub is configured; in that
    // case the PRICE handlers never enqueue, so there is nothing to drain.
    start(){
        if(this.timer) return;
        if(!this.hubClient || !this.hubClient.enabled){
            console.log('HubPushQueue: no hub configured, retry queue idle');
            return;
        }
        this.timer = setInterval(() => {
            this.drain().catch(err => console.warn('HubPushQueue: drain error:', err.message || err));
        }, this.intervalMs);
        // Never keep the process alive on the timer alone.
        if(this.timer.unref) this.timer.unref();
        console.log('HubPushQueue: started (interval ' + this.intervalMs + 'ms, max ' + this.maxAttempts + ' attempts)');
    }

    stop(){
        if(this.timer){ clearInterval(this.timer); this.timer = null; }
    }

    // A pending row is due when enough time has elapsed since its last attempt,
    // per the exponential-backoff schedule. Rows never tried are immediately due.
    _isDue(row, now){
        if(!row.last_attempted_at) return true;
        let last    = new Date(row.last_attempted_at).getTime();
        let attempts = Number(row.attempts) || 0;
        let backoff = Math.min(this.baseBackoffMs * Math.pow(2, Math.max(0, attempts - 1)), this.maxBackoffMs);
        return now >= last + backoff;
    }

    // Drain one batch of due rows. Guarded against overlapping runs so a slow
    // hub can't pile up concurrent drains on top of each other.
    async drain(){
        if(this.draining) return;
        if(this.paused) return;
        this.draining = true;
        // Publish a completion promise so pause() can await this in-flight drain (HUB-RETRACT-3).
        let resolveDone;
        this._drainDone = new Promise(resolve => { resolveDone = resolve; });
        try {
            // Sweep aged terminal rows before fetching. It rides the existing drain
            // timer rather than owning one, so it inherits start/stop/pause and adds
            // no lifecycle: the throttle below is what keeps it off every 30s tick.
            await this._pruneFailed();
            // The due-time predicate is pushed into SQL (db.js getPendingHubPushes) so
            // parked-in-backoff rows no longer occupy the LIMIT batch slots (review
            // finding 01178748: head-of-line blocking). Pass the SAME backoff params
            // used below by _isDue, which stays as a cheap belt-and-braces re-check.
            let rows = await this.indexerDb.getPendingHubPushes(this.batchSize, {
                baseBackoffMs: this.baseBackoffMs,
                maxBackoffMs:  this.maxBackoffMs
            });
            if(!rows || rows.length === 0) return;
            let now = Date.now();
            for(let row of rows){
                if(!this._isDue(row, now)) continue;
                await this._attempt(row);
            }
        } finally {
            this.draining = false;
            this._drainDone = null;
            resolveDone();
        }
    }

    // Delete terminal `failed` rows past the retention window, at most once per
    // pruneIntervalMs. Never throws into drain(): a sweep that cannot run is a
    // housekeeping miss, not a delivery failure, and the next tick retries. The
    // typeof guard keeps minimal test doubles (indexerDb stubs without the method)
    // working. Returns the number of rows removed, 0 when it did not run.
    async _pruneFailed(){
        if(!(this.failedRetentionSec > 0)) return 0;
        let now = Date.now();
        if(now - this._lastPruneMs < this.pruneIntervalMs) return 0;
        this._lastPruneMs = now;
        if(typeof this.indexerDb.pruneFailedHubPushes !== 'function') return 0;
        try {
            let removed = await this.indexerDb.pruneFailedHubPushes(this.failedRetentionSec);
            if(removed > 0)
                console.log('HubPushQueue: pruned ' + removed + ' failed row(s) older than ' +
                    this.failedRetentionSec + 's');
            return removed;
        } catch (err){
            console.warn('HubPushQueue: failed-row prune error:', err.message || err);
            return 0;
        }
    }

    // Return aggregate queue stats for the health endpoint. Runs a single
    // pooled query so it is safe to call concurrently with drain(). Returns
    // null when the hub is unconfigured (queue never populated).
    async getStats(){
        if(!this.hubClient || !this.hubClient.enabled) return null;
        let rows = await this.indexerDb._poolQuery(
            `SELECT status, COUNT(*) AS cnt FROM pending_hub_pushes GROUP BY status`
        );
        let pending = 0, failed = 0;
        for(let r of (rows || [])){
            if(r.status === 'pending') pending = Number(r.cnt);
            else if(r.status === 'failed')  failed  = Number(r.cnt);
        }
        return { pending, failed };
    }

    async _attempt(row){
        let payload;
        try {
            payload = (typeof row.payload === 'string') ? JSON.parse(row.payload) : row.payload;
        } catch (e){
            // A payload that can't be parsed can never be delivered; mark it
            // failed immediately so it stops cycling through the queue.
            console.warn('HubPushQueue: row ' + row.id + ' has unparseable payload, marking failed');
            await this.indexerDb.recordHubPushAttempt(row.id, 'unparseable payload', 1);
            return;
        }

        let attemptNo = (Number(row.attempts) || 0) + 1;
        try {
            if(row.push_type === 'price_round'){
                await this.hubClient.pushPriceRound(payload);
            } else if(row.push_type === 'oracle_price'){
                await this.hubClient.pushOraclePrice(payload);
            } else if(row.push_type === 'price_retraction'){
                // Reorg retraction parked by rollback.js when the live RPC failed.
                // pushpricereorg is idempotent over a replayed range. A deferred drain bounds the
                // delete to the CLOSED range [action_index, last_action_index] so a row re-published
                // at A' inside the original open-ended range is not wiped (item 5296). Old queued
                // rows (no last_action_index) fall back to open-ended via undefined. retraction_generation
                // (item 5308) fences the delete to push_generation <= it; absent on old queued rows.
                await this.hubClient.retractPriceRange(payload.coin, payload.action_index, payload.last_action_index, payload.retraction_generation);
            } else if(row.push_type === 'xcall_retraction'){
                // Reorg XCALL relay retraction parked by rollback.js when the live RPC
                // failed. retractXcallRange is idempotent over a replayed range; closed-range bounded + gen-fenced.
                await this.hubClient.retractXcallRange(payload.coin, payload.action_index, payload.last_action_index, payload.retraction_generation);
            } else if(row.push_type === 'match_retraction'){
                // Reorg DEX cross-chain match retraction parked by rollback.js when the
                // live RPC failed. retractMatchRange is idempotent over a replayed range; closed-range bounded + gen-fenced.
                await this.hubClient.retractMatchRange(payload.coin, payload.action_index, payload.last_action_index, payload.retraction_generation);
            } else {
                console.warn('HubPushQueue: row ' + row.id + ' has unknown push_type "' + row.push_type + '", marking failed');
                await this.indexerDb.recordHubPushAttempt(row.id, 'unknown push_type', 1);
                return;
            }
            // Success (or a hub-side dedupe of a row it already has); drop it.
            await this.indexerDb.markHubPushDelivered(row.id);
            console.log('HubPushQueue: delivered ' + row.push_type + ' row ' + row.id + ' (attempt ' + attemptNo + ')');
        } catch (err){
            let msg = String((err && err.message) || err).slice(0, 480);
            // Reorg retractions must NOT share the best-effort forward-push attempt cap. A forward
            // price/oracle push is disposable, so retiring it to 'failed' after maxAttempts is fine.
            // A '*_retraction' row is the ONLY remaining record that the hub must prune an orphaned
            // range: retiring it (a hub outage overlapping a reorg exhausts the ~10-attempt backoff
            // in under an hour) permanently strands stale prices and 'finalized' XCALL/DEX rows on
            // the hub and every mirror, eligible for re-injection/settlement, with the evidence
            // parked invisibly in a terminal row. Retractions are idempotent and generation-fenced,
            // so retrying forever at the max backoff is safe; keep them 'pending' indefinitely.
            let isRetraction = typeof row.push_type === 'string' && row.push_type.endsWith('_retraction');
            let cap = isRetraction ? Number.MAX_SAFE_INTEGER : this.maxAttempts;
            await this.indexerDb.recordHubPushAttempt(row.id, msg, cap);
            console.warn('HubPushQueue: push failed for row ' + row.id +
                ' (attempt ' + attemptNo + (isRetraction ? '' : '/' + this.maxAttempts) + '): ' + msg);
        }
    }
}

module.exports = HubPushQueue;
