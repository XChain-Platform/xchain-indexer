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
 * XChain Indexer - Coin node tip for the status surfaces
 *
 * The `lag` field on /status is decoder tip minus indexer height. When the decoder
 * stops (a REORG_HALT, a dead node connection), its tip freezes and that lag reads 0
 * while the chain moves on, so an indexer frozen behind it looks caught up. This reads
 * the coin node tip from the utxo tracker the indexer is already configured with,
 * so /status can report chainLag beside lag.
 *
 * Cached with a short TTL, with concurrent readers sharing one request and every
 * read bounded by a timeout: /status is the container healthcheck, and a slow or
 * absent tracker must never make it slow. A failed refresh keeps the last known tip
 * only for a bounded age, and chainTipAt says when it was last refreshed. HEALTH
 * REPORTING ONLY: nothing here reaches a hashed value or a barrier.
 *
 * Installed onto XChainIndexer.prototype by ../../XChainIndexer.js.
 *
 ********************************************************************/

'use strict';

const CHAIN_TIP_STALE_TTLS = 4;
const CHAIN_TIP_MIN_MAX_AGE_MS = 60000;

// Resolve after `ms` without holding the event loop open.
function delay(ms){
    return new Promise((resolve) => {
        let timer = setTimeout(resolve, ms);
        if(timer && typeof timer.unref === 'function') timer.unref();
    });
}

// The tip as the status surfaces report it. `stale` is null when no source is
// configured, false while a configured source is within its grace, and true after.
function chainTipSnapshot(indexer, now, trackerUsable){
    let at = Number.isFinite(indexer.chainTipAt) && indexer.chainTipAt > 0
        ? indexer.chainTipAt
        : null;
    if(!trackerUsable)
        return { height: null, source: null, at: at, stale: null, staleSince: null };
    let ttlMs = Number.isFinite(indexer.chainTipTtlMs) && indexer.chainTipTtlMs > 0
        ? indexer.chainTipTtlMs
        : CHAIN_TIP_MIN_MAX_AGE_MS;
    let maxAgeMs = Math.max(CHAIN_TIP_MIN_MAX_AGE_MS, CHAIN_TIP_STALE_TTLS * ttlMs);
    let ageFrom = at || indexer.startedAt;
    let staleSince = Number.isFinite(ageFrom) ? ageFrom + maxAgeMs : null;
    let stale = staleSince != null && Number.isFinite(now) && now > staleSince;
    let height = !stale && Number.isSafeInteger(indexer.chainTip) ? indexer.chainTip : null;
    return {
        height: height,
        source: height == null ? null : 'utxo_tracker',
        at:     at,
        stale:  stale,
        staleSince: stale ? staleSince : null
    };
}

module.exports = {

    // Return { height, source, at, stale, staleSince } for the coin node tip, refreshing it
    // from the utxo tracker when the cached reading is older than chainTipTtlMs. Waits at most
    // chainTipTimeoutMs for a refresh; a slower one finishes in the background and
    // lands in the next read. { height: null } when no tracker is configured or it has
    // never answered with a usable node_height (the tracker reports -1 when unknown).
    // Never throws.
    async readChainTip(now = Date.now()){
        let tracker = this.utxoTracker;
        let trackerUsable = !!(tracker && tracker.enabled && typeof tracker.getSyncStatus === 'function');
        if(!trackerUsable) return chainTipSnapshot(this, now, false);
        let fresh = this._chainTipCheckedAt && (now - this._chainTipCheckedAt) < this.chainTipTtlMs;
        if(fresh) return chainTipSnapshot(this, now, true);
        if(!this._chainTipInFlight){
            this._chainTipInFlight = Promise.resolve()
                .then(() => tracker.getSyncStatus())
                .then((sync) => {
                    let height = Number(sync && sync.node_height);
                    if(Number.isSafeInteger(height) && height >= 0){
                        this.chainTip   = height;
                        this.chainTipAt = Date.now();
                    }
                })
                .catch(() => { /* reporting only: keep the last known tip */ })
                .finally(() => {
                    this._chainTipInFlight = null;
                    this._chainTipCheckedAt = Date.now();
                });
        }
        await Promise.race([this._chainTipInFlight, delay(this.chainTipTimeoutMs)]);
        return chainTipSnapshot(this, now, true);
    }
};
