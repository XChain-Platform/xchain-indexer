const { getLogger } = require('../observability/index.js');
const { CONFIG_ENV } = require('../config.js');
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
 ********************************************************************/

class HubPushQueue {

    constructor(indexer, opts){
        opts = opts || {};
        this.indexer   = indexer;
        this.indexerDb = indexer.indexerDb;
        this.hubClient = indexer.hubClient;
        this.hubSelector = opts.selector || indexer.hubSelector || indexer.selector ||
            (this.hubClient && (this.hubClient.selector || this.hubClient.hubSelector)) || null;

        // How often the poller wakes to drain due rows.
        this.intervalMs    = opts.intervalMs    || parseInt(CONFIG_ENV.HUB_PUSH_RETRY_INTERVAL_MS) || 30000;
        // Backoff schedule: wait grows as base * 2^(attempts-1), capped at max.
        this.baseBackoffMs = opts.baseBackoffMs || parseInt(CONFIG_ENV.HUB_PUSH_RETRY_BASE_MS)     || 30000;
        this.maxBackoffMs  = opts.maxBackoffMs  || parseInt(CONFIG_ENV.HUB_PUSH_RETRY_MAX_MS)      || 600000;  // 10 min cap
        // Stop retrying a row after this many attempts (~30 min with defaults).
        this.maxAttempts   = opts.maxAttempts   || parseInt(CONFIG_ENV.HUB_PUSH_MAX_ATTEMPTS)      || 10;
        // Rows pulled per drain tick.
        this.batchSize     = opts.batchSize     || 50;
        // Set HUB_PUSH_FAILED_RETENTION_SECONDS=0 to keep terminal rows forever.
        let retentionEnv = parseInt(CONFIG_ENV.HUB_PUSH_FAILED_RETENTION_SECONDS);
        this.failedRetentionSec = (opts.failedRetentionSec != null) ? opts.failedRetentionSec
            : (Number.isFinite(retentionEnv) ? retentionEnv : 7 * 24 * 3600);
        this.pruneIntervalMs = opts.pruneIntervalMs || parseInt(CONFIG_ENV.HUB_PUSH_PRUNE_INTERVAL_MS) || 3600000;
        this._lastPruneMs = 0;

        this.timer    = null;
        this.draining = false;
        this._throttledUntilMs = 0;
        // Promise that resolves when the currently in-flight drain() finishes; null when idle. Lets
        // pause() await an in-flight drain instead of returning while it is still mid-batch.
        this._drainDone = null;
        // Set by rollback.js around its post-commit retraction block so a deferred drain cannot
        // re-issue a stale open-ended retraction against the just-rolled-back range.
        // Independent of `draining` (which only prevents overlapping drains).
        this.paused   = false;
    }

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
            getLogger().info('HubPushQueue: no hub configured, retry queue idle');
            return;
        }
        this.timer = setInterval(() => {
            this.drain().catch(err => getLogger().warn('HubPushQueue: drain error:', err.message || err));
        }, this.intervalMs);
        // Never keep the process alive on the timer alone.
        if(this.timer.unref) this.timer.unref();
        getLogger().info('HubPushQueue: started (interval ' + this.intervalMs + 'ms, max ' + this.maxAttempts + ' attempts)');
    }

    stop(){
        if(this.timer){ clearInterval(this.timer); this.timer = null; }
    }

    // A pending row is due when enough time has elapsed since its last attempt,
    // per the exponential-backoff schedule. Rows never tried are immediately due.
    isDue(row, now){
        if(!row.last_attempted_at) return true;
        let last    = new Date(row.last_attempted_at).getTime();
        let attempts = Number(row.attempts) || 0;
        let backoff = Math.min(this.baseBackoffMs * Math.pow(2, Math.max(0, attempts - 1)), this.maxBackoffMs);
        return now >= last + backoff;
    }

    candidateAddresses(){
        if(!this.hubSelector) return [];
        let status = (typeof this.hubSelector.status === 'function')
            ? this.hubSelector.status() : this.hubSelector;
        if((status && (status.pinned === true || status.mode === 'pinned')) ||
           this.hubSelector.pinned === true ||
           (typeof this.hubSelector.isPinned === 'function' && this.hubSelector.isPinned()))
            return [];
        let candidates = status && status.candidates;
        if(!Array.isArray(candidates) && Array.isArray(this.hubSelector.candidates))
            candidates = this.hubSelector.candidates;
        if(!Array.isArray(candidates)) return [];
        return [...new Set(candidates
            .map(candidate => typeof candidate === 'string' ? candidate : candidate && candidate.address)
            .filter(address => typeof address === 'string' && address.length > 0))];
    }

    clientForAddress(address){
        let base = this.hubClient;
        let client = Object.create(base);
        client.hubUrl = address;
        client.call = (method, params, apiKeyOverride, urlOverride) =>
            base.call(method, params, apiKeyOverride, urlOverride || address);
        return client;
    }

    async ensureHubDeliveries(rowId, addresses){
        if(addresses.length === 0) return;
        let values = addresses.map(() => "(?, ?, 'pending', 0, NOW(), NOW())").join(', ');
        let params = [];
        for(let address of addresses) params.push(rowId, address);
        await this.indexerDb.poolQuery(
            `INSERT IGNORE INTO hub_push_deliveries
                (push_id, hub_address, status, attempts, created_at, updated_at)
             VALUES ${values}`,
            params
        );
    }

    async getHubDeliveries(rowId){
        return await this.indexerDb.poolQuery(
            `SELECT push_id, hub_address, status, attempts, last_attempted_at, last_error
               FROM hub_push_deliveries WHERE push_id = ?`,
            [rowId]
        );
    }

    async markHubDeliveryDelivered(rowId, address){
        await this.indexerDb.poolQuery(
            `UPDATE hub_push_deliveries
                SET status = 'delivered', last_attempted_at = NOW(), last_error = NULL,
                    updated_at = NOW()
              WHERE push_id = ? AND hub_address = ?`,
            [rowId, address]
        );
    }

    async recordHubDeliveryFailure(rowId, address, err){
        let msg = String((err && err.message) || err).slice(0, 480);
        if(err && err.rateLimited){
            let waitMs = Number.isFinite(err.retryAfterMs) && err.retryAfterMs > 0 ? err.retryAfterMs : 60000;
            this._throttledUntilMs = Date.now() + waitMs;
            getLogger().warn('HubPushQueue: hub rate-limited delivery to ' + address +
                '; holding the queue ' + Math.round(waitMs / 1000) + 's (' + msg + ')');
            return;
        }
        await this.indexerDb.poolQuery(
            `UPDATE hub_push_deliveries
                SET attempts = attempts + 1, last_attempted_at = NOW(), last_error = ?,
                    updated_at = NOW()
              WHERE push_id = ? AND hub_address = ?`,
            [msg, rowId, address]
        );
        getLogger().warn('HubPushQueue: delivery failed for row ' + rowId + ' to ' + address + ': ' + msg);
    }

    async removeHubDeliveries(rowId){
        await this.indexerDb.poolQuery('DELETE FROM hub_push_deliveries WHERE push_id = ?', [rowId]);
    }

    // Drain one batch of due rows. Guarded against overlapping runs so a slow
    // hub can't pile up concurrent drains on top of each other.
    async drain(){
        if(this.draining) return;
        if(this.paused) return;
        // Hub-imposed hold from a previous 429. Checked before the prune/fetch so a
        // throttled queue costs one clock read per tick, not a DB round trip.
        if(this._throttledUntilMs && Date.now() < this._throttledUntilMs) return;
        this.draining = true;
        // Publish a completion promise so pause() can await this in-flight drain.
        let resolveDone;
        this._drainDone = new Promise(resolve => { resolveDone = resolve; });
        try {
            // Sweep aged terminal rows before fetching. It rides the existing drain
            // timer rather than owning one, so it inherits start/stop/pause and adds
            // no lifecycle: the throttle below is what keeps it off every 30s tick.
            await this.pruneFailed();
            // The due-time predicate is pushed into SQL (db.js getPendingHubPushes) so
            // parked-in-backoff rows no longer occupy the LIMIT batch slots, which is what
            // caused head-of-line blocking. Pass the SAME backoff params used below by
            // isDue, which stays as a cheap belt-and-braces re-check.
            let rows = await this.indexerDb.getPendingHubPushes(this.batchSize, {
                baseBackoffMs: this.baseBackoffMs,
                maxBackoffMs:  this.maxBackoffMs
            });
            if(!rows || rows.length === 0) return;
            let now = Date.now();
            for(let row of rows){
                if(!this.isDue(row, now)) continue;
                await this.attempt(row);
                // A 429 stops the batch where it stands. The remaining rows are still
                // pending and still due, so the next tick past the hold picks them up
                // unchanged; pushing them now would only deepen the throttle.
                if(this._throttledUntilMs && Date.now() < this._throttledUntilMs) break;
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
    async pruneFailed(){
        if(!(this.failedRetentionSec > 0)) return 0;
        let now = Date.now();
        if(now - this._lastPruneMs < this.pruneIntervalMs) return 0;
        this._lastPruneMs = now;
        if(typeof this.indexerDb.pruneFailedHubPushes !== 'function') return 0;
        try {
            let removed = await this.indexerDb.pruneFailedHubPushes(this.failedRetentionSec);
            if(removed > 0)
                getLogger().info('HubPushQueue: pruned ' + removed + ' failed row(s) older than ' +
                    this.failedRetentionSec + 's');
            return removed;
        } catch (err){
            getLogger().warn('HubPushQueue: failed-row prune error:', err.message || err);
            return 0;
        }
    }

    // Return aggregate queue stats for the health endpoint. Runs a single
    // pooled query so it is safe to call concurrently with drain(). Returns
    // null when the hub is unconfigured (queue never populated).
    // pendingOldestAgeSec rides the same grouped scan. Now that oracle_price
    // and the retractions retry without a cap, a stalled rail no longer shows up as a
    // climbing `failed` count; it shows up as a pending backlog that AGES, and without
    // this field that is invisible. Computed server-side so no host/DB clock skew folds
    // into the age. Null when nothing is pending.
    async getStats(){
        if(!this.hubClient || !this.hubClient.enabled) return null;
        let rows = await this.indexerDb.getHubPushQueueStats();
        let pending = 0, failed = 0, pendingOldestAgeSec = null;
        for(let r of (rows || [])){
            if(r.status === 'pending'){
                pending = Number(r.cnt);
                if(r.oldest_age_sec !== undefined && r.oldest_age_sec !== null)
                    pendingOldestAgeSec = Number(r.oldest_age_sec);
            }
            else if(r.status === 'failed')  failed  = Number(r.cnt);
        }
        return { pending, failed, pendingOldestAgeSec };
    }

    // Parse a queued row's JSON payload, or terminally fail an unparseable row so it
    // stops cycling through the queue. This is the
    // row's own parse guard, evaluated before any hub delivery is attempted. Returns
    // null (never a legitimately-parsed value, even a bare `null` payload lands inside
    // the wrapper object) when the row was already recorded failed here.
    async parseHubPushPayload(row){
        try {
            return { payload: (typeof row.payload === 'string') ? JSON.parse(row.payload) : row.payload };
        } catch (e){
            // A payload that can't be parsed can never be delivered; mark it
            // failed immediately so it stops cycling through the queue.
            getLogger().warn('HubPushQueue: row ' + row.id + ' has unparseable payload, marking failed');
            await this.indexerDb.recordHubPushAttempt(row.id, 'unparseable payload', 1);
            return null;
        }
    }

    async deliverHubPush(row, payload, client){
        client = client || this.hubClient;
        if(row.push_type === 'price_round'){
            await client.pushPriceRound(payload);
        } else if(row.push_type === 'oracle_price'){
            await client.pushOraclePrice(payload);
        } else if(row.push_type === 'price_batch'){
            await client.pushPriceBatch(payload);
        } else if(row.push_type === 'attest_batch'){
            await client.pushAttestBatch(payload);
        } else if(row.push_type === 'price_retraction'){
            await client.retractPriceRange(payload.coin, payload.action_index, payload.last_action_index, payload.retraction_generation);
        } else if(row.push_type === 'xcall_retraction'){
            await client.retractXcallRange(payload.coin, payload.action_index, payload.last_action_index, payload.retraction_generation);
        } else if(row.push_type === 'attest_batch_retraction'){
            await client.retractAttestBatch(payload.coin, payload);
        } else if(row.push_type === 'match_retraction'){
            await client.retractMatchRange(payload.coin, payload.action_index, payload.last_action_index, payload.retraction_generation);
        } else if(row.push_type === 'bridge_retraction'){
            await client.retractBridgeRange(payload.coin, payload.action_index, payload.last_action_index, payload.retraction_generation);
        } else {
            getLogger().warn('HubPushQueue: row ' + row.id + ' has unknown push_type "' + row.push_type + '", marking failed');
            await this.indexerDb.recordHubPushAttempt(row.id, 'unknown push_type', 1);
            return false;
        }
        return true;
    }

    isHubPushDurable(pushType){
        return typeof pushType === 'string' &&
            (pushType.endsWith('_retraction') || pushType === 'oracle_price' ||
             pushType === 'price_batch' || pushType === 'attest_batch');
    }

    async recordHubPushFailure(row, err, attemptNo){
        let msg = String((err && err.message) || err).slice(0, 480);
        if(err && err.rateLimited){
            let waitMs = Number.isFinite(err.retryAfterMs) && err.retryAfterMs > 0 ? err.retryAfterMs : 60000;
            this._throttledUntilMs = Date.now() + waitMs;
            getLogger().warn('HubPushQueue: hub rate-limited ' + row.push_type + ' row ' + row.id +
                '; holding the queue ' + Math.round(waitMs / 1000) + 's (' + msg + ')');
            return;
        }
        let isDurable = this.isHubPushDurable(row.push_type);
        let cap = isDurable ? Number.MAX_SAFE_INTEGER : this.maxAttempts;
        await this.indexerDb.recordHubPushAttempt(row.id, msg, cap);
        getLogger().warn('HubPushQueue: push failed for row ' + row.id +
            ' (attempt ' + attemptNo + (isDurable ? '' : '/' + this.maxAttempts) + '): ' + msg);
    }

    async attempt(row){
        let candidates = this.candidateAddresses();
        if(candidates.length > 0) return await this.attemptFanout(row, candidates);

        let parsed = await this.parseHubPushPayload(row);
        if(parsed === null) return;

        let attemptNo = (Number(row.attempts) || 0) + 1;
        try {
            let delivered = await this.deliverHubPush(row, parsed.payload);
            if(!delivered) return;
            // Success (or a hub-side dedupe of a row it already has); drop it.
            await this.indexerDb.markHubPushDelivered(row.id);
            getLogger().info('HubPushQueue: delivered ' + row.push_type + ' row ' + row.id + ' (attempt ' + attemptNo + ')');
        } catch (err){
            await this.recordHubPushFailure(row, err, attemptNo);
        }
    }

    async attemptFanout(row, candidates){
        let parsed = await this.parseHubPushPayload(row);
        if(parsed === null) return;

        await this.ensureHubDeliveries(row.id, candidates);
        let deliveries = await this.getHubDeliveries(row.id);
        let byAddress = new Map((deliveries || []).map(delivery => [delivery.hub_address, delivery]));
        let now = Date.now();

        for(let address of candidates){
            let delivery = byAddress.get(address) || {
                hub_address: address,
                status: 'pending',
                attempts: 0,
                last_attempted_at: null
            };
            if(delivery.status === 'delivered' || !this.isDue(delivery, now)) continue;
            try {
                let delivered = await this.deliverHubPush(row, parsed.payload, this.clientForAddress(address));
                if(!delivered){
                    await this.removeHubDeliveries(row.id);
                    return;
                }
                await this.markHubDeliveryDelivered(row.id, address);
                delivery.status = 'delivered';
                byAddress.set(address, delivery);
                getLogger().info('HubPushQueue: delivered ' + row.push_type + ' row ' + row.id +
                    ' to ' + address);
            } catch (err){
                await this.recordHubDeliveryFailure(row.id, address, err);
            }
        }

        if(candidates.every(address => {
            let delivery = byAddress.get(address);
            return delivery && delivery.status === 'delivered';
        })){
            await this.removeHubDeliveries(row.id);
            await this.indexerDb.markHubPushDelivered(row.id);
        }
    }
}

module.exports = HubPushQueue;
