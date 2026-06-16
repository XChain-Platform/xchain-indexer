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
 * table — so a dropped push used to permanently remove the row from the hub's
 * oracle_prices / price_snapshots and from every indexer that mirrors the hub.
 *
 * To make those pushes durable, a failed push is persisted to the
 * `pending_hub_pushes` table. This poller drains that table on a fixed interval,
 * re-sending each row with exponential backoff until the hub accepts it (the
 * hub's pushpriceround / pushoracleprice handlers dedupe, so a replay the hub
 * already has returns cleanly). A row that keeps failing past the attempt cap is
 * marked `failed` so the queue stays bounded.
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

        this.timer    = null;
        this.draining = false;
    }

    // Begin draining on an interval. No-op when no hub is configured — in that
    // case the PRICE handlers never enqueue, so there is nothing to drain.
    start(){
        if(this.timer) return;
        if(!this.hubClient || !this.hubClient.enabled){
            console.log('HubPushQueue: no hub configured — retry queue idle');
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
        this.draining = true;
        try {
            let rows = await this.indexerDb.getPendingHubPushes(this.batchSize);
            if(!rows || rows.length === 0) return;
            let now = Date.now();
            for(let row of rows){
                if(!this._isDue(row, now)) continue;
                await this._attempt(row);
            }
        } finally {
            this.draining = false;
        }
    }

    async _attempt(row){
        let payload;
        try {
            payload = (typeof row.payload === 'string') ? JSON.parse(row.payload) : row.payload;
        } catch (e){
            // A payload that can't be parsed can never be delivered — mark it
            // failed immediately so it stops cycling through the queue.
            console.warn('HubPushQueue: row ' + row.id + ' has unparseable payload — marking failed');
            await this.indexerDb.recordHubPushAttempt(row.id, 'unparseable payload', 1);
            return;
        }

        let attemptNo = (Number(row.attempts) || 0) + 1;
        try {
            if(row.push_type === 'price_round'){
                await this.hubClient.pushPriceRound(payload);
            } else if(row.push_type === 'oracle_price'){
                await this.hubClient.pushOraclePrice(payload);
            } else {
                console.warn('HubPushQueue: row ' + row.id + ' has unknown push_type "' + row.push_type + '" — marking failed');
                await this.indexerDb.recordHubPushAttempt(row.id, 'unknown push_type', 1);
                return;
            }
            // Success (or a hub-side dedupe of a row it already has) — drop it.
            await this.indexerDb.markHubPushDelivered(row.id);
            console.log('HubPushQueue: delivered ' + row.push_type + ' row ' + row.id + ' (attempt ' + attemptNo + ')');
        } catch (err){
            let msg = String((err && err.message) || err).slice(0, 480);
            await this.indexerDb.recordHubPushAttempt(row.id, msg, this.maxAttempts);
            console.warn('HubPushQueue: push failed for row ' + row.id +
                ' (attempt ' + attemptNo + '/' + this.maxAttempts + '): ' + msg);
        }
    }
}

module.exports = HubPushQueue;
