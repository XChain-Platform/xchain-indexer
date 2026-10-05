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
 * XChain Indexer - Hub DB Sync Client: price landing barrier
 *
 * Holds a price-reading block until every landing chain has published a landed
 * protocol time past the block's own time, so the stamp on every round the block
 * can select is already mirrored. Releases on the landed map alone, never on
 * priceSyncHeight or the stream watermark.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const gateRegistry = require('../../../consensus/gate_registry.js');

const LANDED_GATE = 'price_fee_batch_landed_activation.PRICE_FEE_BATCH_LANDED_ACTIVATION';
const LANDING_CHAINS = 'price_fee_batch_landed_activation.PRICE_LANDING_CHAINS';

// Keeps only entries shaped { block, protocol_time } with safe non-negative integers.
// Null (no usable object) is distinct from an empty map.
function sanitizeLanded(raw){
    if(!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    for(const chain of Object.keys(raw)){
        const e = raw[chain];
        if(!e || typeof e !== 'object') continue;
        if(!Number.isSafeInteger(e.block) || e.block < 0) continue;
        if(!Number.isSafeInteger(e.protocol_time) || e.protocol_time < 0) continue;
        const c = String(chain).trim().toUpperCase();
        if(c !== '') out[c] = { block: e.block, protocol_time: e.protocol_time };
    }
    return out;
}

const priceLandingMethods = {

    // Install the landed map off a watermark frame. No usable object clears the map, so a
    // hub that stops publishing it makes the barrier defer. A chain's entry never moves
    // backwards. Returns true when any entry advanced.
    noteLanded(raw) {
        const next = sanitizeLanded(raw);
        if(next === null){
            this.landedWatermarks = {};
            return false;
        }
        const prev = this.landedWatermarks || {};
        const merged = {};
        let advanced = false;
        for(const chain of Object.keys(next)){
            const old = prev[chain];
            if(old && old.protocol_time >= next[chain].protocol_time){
                merged[chain] = old;
                continue;
            }
            merged[chain] = next[chain];
            advanced = true;
        }
        this.landedWatermarks = merged;
        if(advanced) this.releaseLandingWaiters();
        return advanced;
    },

    landingActiveAt(blockHeight){
        if(blockHeight === null || blockHeight === undefined) return false;
        return gateRegistry.activeAt(LANDED_GATE, this.network, this.coin, blockHeight, null) === true;
    },

    // The landing chains this block must wait on: the per-network set minus this coin.
    landingChainsFor(){
        const table = gateRegistry.get(LANDING_CHAINS) || {};
        const set = Object.prototype.hasOwnProperty.call(table, this.network) ? table[this.network] : [];
        const own = (this.coin === null || this.coin === undefined) ? null : String(this.coin).trim().toUpperCase();
        return set.filter((c) => c !== own);
    },

    // First landing chain whose published protocol time does not exceed blockTime, as
    // { chain, have, need }; null when every one does. A chain with no entry reads as short.
    landingShortfall(blockTime){
        const t = Number(blockTime);
        const landed = this.landedWatermarks || {};
        for(const chain of this.landingChainsFor()){
            const e = landed[chain];
            const have = e ? e.protocol_time : null;
            if(!Number.isFinite(t) || have === null || !(have > t)) return { chain: chain, have: have, need: t + 1 };
        }
        return null;
    },

    landingSyncSatisfied(blockHeight, blockTime){
        if(!this.enabled) return true;
        if(!this.landingActiveAt(blockHeight)) return true;
        return this.landingShortfall(blockTime) === null;
    },

    releaseLandingWaiters(){
        const waiters = this._landingWaiters || [];
        if(waiters.length === 0) return;
        const still = [];
        for(const w of waiters){
            if(this.landingSyncSatisfied(w.height, w.blockTime)){
                clearTimeout(w.timer);
                w.resolve();
            } else {
                still.push(w);
            }
        }
        this._landingWaiters = still;
    },

    waitForPriceLandingSync(blockHeight, blockTime, timeoutMs){
        blockHeight = Number(blockHeight);
        blockTime   = Number(blockTime);
        if(this.landingSyncSatisfied(blockHeight, blockTime)) return Promise.resolve();
        let ms = parseInt(timeoutMs);
        if(!Number.isFinite(ms) || ms <= 0) ms = 60000;
        return new Promise((resolve, reject) => {
            const waiter = { height: blockHeight, blockTime: blockTime, resolve: resolve, timer: null };
            waiter.timer = setTimeout(() => {
                if(this.landingSyncSatisfied(blockHeight, blockTime)) return resolve();
                this._landingWaiters = (this._landingWaiters || []).filter((w) => w !== waiter);
                const s = this.landingShortfall(blockTime) || { chain: 'unknown', have: null, need: blockTime + 1 };
                reject(new Error('price landing barrier timed out after ' + ms + 'ms waiting for block ' +
                                 blockHeight + ': landing chain ' + s.chain + ' landed time ' +
                                 (s.have === null ? 'none' : s.have) + ', needs ' + s.need +
                                 (s.have === null ? '' : ' (short by ' + (s.need - s.have) + 's)')));
            }, ms);
            this._landingWaiters = (this._landingWaiters || []).concat([waiter]);
        });
    },
};

module.exports = function buildPriceLandingMethods() {
    return priceLandingMethods;
};
