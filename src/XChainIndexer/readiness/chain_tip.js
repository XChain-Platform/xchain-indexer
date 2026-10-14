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
 * absent tracker must never make it slow. A failed refresh keeps the last known tip,
 * and chainTipAt says how old it is. HEALTH REPORTING ONLY: nothing here reaches a
 * hashed value or a barrier.
 *
 * Installed onto XChainIndexer.prototype by ../../XChainIndexer.js.
 *
 ********************************************************************/

'use strict';

// Resolve after `ms` without holding the event loop open.
function delay(ms){
    return new Promise((resolve) => {
        let timer = setTimeout(resolve, ms);
        if(timer && typeof timer.unref === 'function') timer.unref();
    });
}

// The tip as the status surfaces report it.
function chainTipSnapshot(indexer){
    return {
        height: Number.isSafeInteger(indexer.chainTip) ? indexer.chainTip : null,
        source: Number.isSafeInteger(indexer.chainTip) ? 'utxo_tracker' : null,
        at:     indexer.chainTipAt || null
    };
}

module.exports = {

    // Return { height, source, at } for the coin node tip, refreshing it from the utxo
    // tracker when the cached reading is older than chainTipTtlMs. Waits at most
    // chainTipTimeoutMs for a refresh; a slower one finishes in the background and
    // lands in the next read. { height: null } when no tracker is configured or it has
    // never answered with a usable node_height (the tracker reports -1 when unknown).
    // Never throws.
    async readChainTip(now = Date.now()){
        let tracker = this.utxoTracker;
        if(!tracker || !tracker.enabled || typeof tracker.getSyncStatus !== 'function')
            return chainTipSnapshot(this);
        let fresh = this._chainTipCheckedAt && (now - this._chainTipCheckedAt) < this.chainTipTtlMs;
        if(fresh) return chainTipSnapshot(this);
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
        return chainTipSnapshot(this);
    }
};
