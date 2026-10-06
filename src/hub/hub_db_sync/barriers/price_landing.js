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
const STRICT_GATE = 'price_landed_strict_activation.PRICE_LANDED_STRICT_ACTIVATION';
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

module.exports = {

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
            if(old){
                merged[chain] = {
                    block: Math.max(old.block, next[chain].block),
                    protocol_time: Math.max(old.protocol_time, next[chain].protocol_time),
                };
                if(merged[chain].block > old.block || merged[chain].protocol_time > old.protocol_time)
                    advanced = true;
            } else {
                merged[chain] = next[chain];
                advanced = true;
            }
        }
        this.landedWatermarks = merged;
        if(advanced) this.releaseLandingWaiters();
        return advanced;
    },

    landingActiveAt(blockHeight){
        if(blockHeight === null || blockHeight === undefined) return false;
        return gateRegistry.activeAt(LANDED_GATE, this.network, this.coin, blockHeight, null) === true;
    },

    landingChainSet(){
        const table = gateRegistry.get(LANDING_CHAINS) || {};
        return Object.prototype.hasOwnProperty.call(table, this.network) ? table[this.network] : [];
    },

    // The landing chains this block must wait on by time: the per-network set minus this coin.
    landingChainsFor(){
        const set = this.landingChainSet();
        const own = (this.coin === null || this.coin === undefined) ? null : String(this.coin).trim().toUpperCase();
        return set.filter((c) => c !== own);
    },

    strictLandingActiveAt(blockHeight){
        const own = (this.coin === null || this.coin === undefined) ? null : String(this.coin).trim().toUpperCase();
        if(!this.landingChainSet().includes(own)) return false;
        return gateRegistry.activeAt(STRICT_GATE, this.network, this.coin, blockHeight, null) === true;
    },

    // First landing chain shortfall. Under the strict same-chain rule the own landing
    // member uses its preceding block; every other landing chain keeps the time bound.
    landingShortfall(blockHeight, blockTime){
        const t = Number(blockTime);
        const landed = this.landedWatermarks || {};
        if(this.strictLandingActiveAt(blockHeight)){
            const own = String(this.coin).trim().toUpperCase();
            const e = landed[own];
            const have = e ? e.block : null;
            const need = Number(blockHeight) - 1;
            if(have === null || !Number.isFinite(need) || have < need)
                return { chain: own, have: have, need: need, unit: 'block' };
        }
        for(const chain of this.landingChainsFor()){
            const e = landed[chain];
            const have = e ? e.protocol_time : null;
            if(!Number.isFinite(t) || have === null || !(have > t))
                return { chain: chain, have: have, need: t + 1, unit: 'time' };
        }
        return null;
    },

    landingSyncSatisfied(blockHeight, blockTime){
        if(!this.enabled) return true;
        if(!this.landingActiveAt(blockHeight)) return true;
        return this.landingShortfall(blockHeight, blockTime) === null;
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
                const s = this.landingShortfall(blockHeight, blockTime) ||
                    { chain: 'unknown', have: null, need: blockTime + 1, unit: 'time' };
                reject(new Error('price landing barrier timed out after ' + ms + 'ms waiting for block ' +
                                 blockHeight + ': landing chain ' + s.chain + ' landed ' + s.unit + ' ' +
                                 (s.have === null ? 'none' : s.have) + ', needs ' + s.need +
                                 (s.have === null ? '' : ' (short by ' + (s.need - s.have) +
                                  (s.unit === 'time' ? 's' : ' blocks') + ')')));
            }, ms);
            this._landingWaiters = (this._landingWaiters || []).concat([waiter]);
        });
    },
};
