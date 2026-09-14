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
 * XChain Indexer - Hub config overlay
 *
 * Overlay of hub-served operational params onto the live coin config: the startup
 * fetch, one poll tick (the poll timer lives in ./hub_config_poll.js beside the
 * call-time interval reader), the consensus-hash transport check, and the three-way
 * classifier that keeps every consensus param out of the overlay. The methods are
 * installed onto XChainIndexer.prototype by ../XChainIndexer.js.
 *
 ********************************************************************/

const coins = require('../coins');
const { getLogger } = require('../observability/index.js');

// Top-level key of the hub's configs tree for a coin. The hub keys that tree by FULL
// lowercase coin name ('bitcoin'), never by the ticker config['COIN'] carries ('BTC'):
// its rows are written from xchain-node's full-name config tree (config/index.js Coin) and
// every hub-side reader of the same tree maps the ticker through COIN_FULL_NAME first
// (XChainHub getFeeQuote, _resolveIndexerUrl, db normalizeCoin). Indexing it with the raw
// ticker resolves undefined on every poll, so the overlay delivers nothing and says
// nothing. Falls back to the raw value for a coin absent from the registry.
//
// Not every hub-served map is this shape: checkHubConsensusHash reads
// coin_consensus_hashes, which is genuinely ticker-keyed and must NOT be mapped.
//
// Module-level rather than a method so the prototype-borrowed
// `mergeHubParams.call(stub, tree)` the consensus soft-fork guard uses keeps working
// against a bare `{ config }` stub.
function hubConfigCoinKey(coinTicker){
    return coins.COIN_FULL_NAME[coinTicker] || coinTicker;
}

// THREE-WAY CONFIG CLASSIFIER (see the platform consolidation plan):
//   1. pinned-verify-only - consensus-critical coin params (gas schedule, staking,
//      fee math, addresses, genesis, byte-prefixes). NEVER applied from the hub;
//      the hub serves them only for the transport-integrity hash check
//      (checkHubConsensusHash). They live solely in the bundled canonical coin
//      files (src/coins) and are pin-verified at boot (verifyConsensusPin).
//   2. live-apply - display/connection params, safe to merge live. Listed below.
//   3. governance-activated - operationally-mutable consensus params, selected by a
//      protocol-agreed activation height (NOT a live poll); none wired yet.
//
// CONSENSUS RULE: any param whose value feeds block-hashed state must NOT appear in
// these lists. The overlay applies a committed hub change the moment a node observes
// it, which happens at different wall-clock times (hence different block heights)
// across the federation. Live-polling a consensus param would let two nodes process
// the same on-chain transaction with different values and produce divergent
// block-hashed rows (a soft fork). Such values come solely from the per-chain local
// defaults (configs/BTC.js, LTC.js, DOGE.js) and may change only via a coordinated
// node upgrade; any future governance path must gate the switch on a protocol-agreed
// activation block height, not a live poll.
//
// Deliberately EXCLUDED for this reason:
//   - GAS_SCHEDULE / GAS_PRICE: feed contract_executions fee math and block hashes.
//   - ACTIVATION_DELAY_BLOCKS: stake/delegation activation_block (actions/stake.js,
//                              delegate.js, unstake.js) is BLOCK_INDEX + this value.
//   - EXPIRATION_FEE_PER_DAY: ORDER/SWAP/DISPENSER expiration fee debited from
//                             balance rows (utility.js getExpirationFee).
//   - STAKING: carries ACTIVATION_DELAY_BLOCKS, COOLDOWN_BLOCKS, and
//              per-capability MIN_STAKE, all of which gate consensus
//              acceptance and the activation/deactivation_block math.
//
// The lists below are intentionally empty: every hub param currently classified for this
// coin/network feeds consensus, so none may be live-polled. Add a key here ONLY after
// confirming it is tunable/display-only and never reaches block-hashed state.
const SCALAR_PARAMS = Object.freeze([]);
const BLOB_PARAMS   = Object.freeze([]);

// Copy each listed scalar hub param over the config, skipping an absent one.
function applyScalarParams(config, hubParams){
    for(let key of SCALAR_PARAMS){
        let val = hubParams[key];
        if(val === undefined || val === null) continue;
        config[key] = val;
    }
}

// Copy each listed blob param over the config: a JSON string is parsed (a parse failure
// logs and keeps the local value) and an object is taken as served.
function applyBlobParams(config, hubParams){
    for(let key of BLOB_PARAMS){
        let val = hubParams[key];
        if(val === undefined || val === null) continue;
        if(typeof val === 'string' && (val.charAt(0) === '{' || val.charAt(0) === '[')){
            try {
                config[key] = JSON.parse(val);
            } catch(e) {
                getLogger().warn('XChainIndexer: failed to JSON-parse hub param ' + key + ':', e);
            }
        } else if(typeof val === 'object'){
            config[key] = val;
        }
    }
}

const hubConfigMethods = {

    // Fetch operational params from the hub and shallow-merge them over the local coin config.
    // Called once at startup. Best-effort: logs a warning and returns without modifying config
    // if the hub is unreachable or returns an unexpected response.
    async applyHubConfigOverlay(){
        if(!this.hubClient || !this.hubClient.configEnabled) return;
        try {
            let { ok, configs, seq, watermark, coinConsensusHashes } = this.unwrapHubConfigResponse(await this.hubClient.getAllConfigs());
            if(!ok){
                getLogger().warn('XChainIndexer: hub config overlay skipped, hub returned no usable config (using local defaults)');
                return;
            }
            this.checkHubConsensusHash(coinConsensusHashes);
            this.mergeHubParams(configs);
            this.lastHubConfigSeq = seq;
            this.lastHubConfigWatermark = watermark;
            this.lastHubConfigFetchAt = Date.now();
        } catch(err) {
            getLogger().warn('XChainIndexer: hub config overlay failed, using local defaults:', err);
        }
    },

    // Transport-integrity check: compare the hub's served consensus-config hash for
    // this coin/network against our OWN bundled hash. A mismatch means the hub would
    // serve divergent consensus values; we never apply consensus params from the hub
    // (the pinned-verify-only class below), so this only logs, but it surfaces a hub
    // that is out of sync with this node's pinned bundle so an operator can upgrade.
    checkHubConsensusHash(coinConsensusHashes){
        if(!coinConsensusHashes) return; // older hub: field absent, nothing to compare
        let coin = this.config.COIN, network = this.config.NETWORK;
        let hubHash = coinConsensusHashes[network] && coinConsensusHashes[network][coin];
        if(!hubHash) return;
        let localHash = coins.consensusHash(coin, network);
        if(hubHash !== localHash)
            getLogger().error('CONSENSUS HASH MISMATCH: hub serves ' + hubHash + ' for ' + coin + '/' + network +
                ' but this node bundles ' + localHash + '. The hub config diverges from this node; not applying hub consensus values (they are pinned-verify-only). Upgrade the lagging side.');
    },

    // Normalize the getallconfigs response across hub versions. Newer hubs wrap the
    // config map as { configs, seq, watermark } so consumers can detect a config change
    // committed between polls; older hubs return the bare nested map. Returns
    // { configs, seq, watermark } each defaulting to 0 (treated as "no committed change
    // seen" by the poll loop). seq only advances on PBFT-committed changes, so a
    // standalone/config-oracle hub (no consensus) never bumps it; watermark
    // (MAX(updated_at) over configs) advances on ANY config write, so both signals must
    // be honored or a non-consensus hub's committed changes are never re-applied live.
    unwrapHubConfigResponse(response){
        if(response && typeof response === 'object' && response.configs && typeof response.configs === 'object' && ('seq' in response)){
            return { ok: true, configs: response.configs, seq: Number(response.seq) || 0, watermark: Number(response.watermark) || 0, coinConsensusHashes: response.coin_consensus_hashes || null };
        }
        // Failed fetch: the hub returned nothing, a non-object, or an HTTP-200 { error: ... }
        // envelope. getallconfigs signals a config-DB read failure as a JSON-RPC *result*
        // (not a JSON-RPC error), so call resolves rather than throwing. Report ok:false so
        // callers do NOT refresh lastHubConfigFetchAt on it, keeping the staleness health
        // signal honest instead of masking a frozen-config hub.
        if(!response || typeof response !== 'object' || response.error){
            return { ok: false, configs: {}, seq: 0, watermark: 0, coinConsensusHashes: null };
        }
        // Older hub: bare nested config map without the { configs, seq, watermark } wrapper.
        return { ok: true, configs: response, seq: 0, watermark: 0, coinConsensusHashes: null };
    },

    // Shallow-merge the hub's operational params for this coin/network over the live
    // config object. Mutating this.config in place is what lets a re-applied overlay
    // take effect without a process restart.
    // Which params may be applied at all is fixed by SCALAR_PARAMS / BLOB_PARAMS above,
    // under the three-way classifier and its consensus rule.
    mergeHubParams(allConfigs){
        let coin    = hubConfigCoinKey(this.config.COIN);
        let network = this.config.NETWORK;
        let hubParams = (allConfigs && allConfigs[coin] && allConfigs[coin][network] && allConfigs[coin][network]['xchain-indexer']) || {};

        applyScalarParams(this.config, hubParams);
        applyBlobParams(this.config, hubParams);
    },

    // One poll tick: fetch, re-check the consensus hash, stamp freshness, then re-apply
    // on a regression or an advance. A fetch fault propagates to the poll timer, which
    // logs it and keeps the current config.
    async pollHubConfigOnce(){
        let { ok, configs, seq, watermark, coinConsensusHashes } = this.unwrapHubConfigResponse(await this.hubClient.getAllConfigs());
        // A usable envelope (not a { error: ... } failure result) means the hub
        // actually answered with config. A failed fetch must NOT refresh the freshness
        // signal, or a persistently config-DB-failing hub reports healthy while the
        // live-polled params are frozen.
        if(!ok){
            getLogger().warn('XChainIndexer: hub config poll returned no usable config; not refreshing freshness signal');
            return;
        }
        // Re-check hub/node consensus-config drift on every poll (not only at startup),
        // so a mid-run hub upgrade/downgrade to a divergent bundle is surfaced live.
        // The check is log-only / pinned-verify-only and cannot affect consensus.
        this.checkHubConsensusHash(coinConsensusHashes);
        // Record the fetch time even when seq is unchanged, since the freshness of the
        // live-polled params is what the health/status age signal reports, not whether
        // they happened to change.
        this.lastHubConfigFetchAt = Date.now();
        if(this.applyHubConfigRegression(seq, watermark, configs)) return;
        this.applyHubConfigAdvance(seq, watermark, configs);
    },

    // Hub restart / restore-from-older-snapshot: a REGRESSED seq or watermark
    // hits none of the three gates below, and the Math.max clamp keeps the stale
    // high value forever, so config re-apply stops until the hub climbs back past
    // it. Treat a regression as a cursor reset: re-merge and adopt the
    // served values verbatim, the way the startup overlay already does
    // (applyHubConfigOverlay assigns seq/watermark unclamped). mergeHubParams is
    // idempotent. Alarm loudly rather than self-heal in silence: a hub that lost
    // config state is an operator event, not a steady-state poll.
    // Returns true when it re-applied, which ends the poll tick.
    applyHubConfigRegression(seq, watermark, configs){
        let hubReset = (seq < (this.lastHubConfigSeq || 0)) ||
                       (watermark > 0 && watermark < (this.lastHubConfigWatermark || 0));
        if(hubReset){
            getLogger().error('XChainIndexer: HUB CONFIG REGRESSION: hub served seq ' + seq +
                          '/watermark ' + watermark + ', below last-seen ' + this.lastHubConfigSeq +
                          '/' + this.lastHubConfigWatermark +
                          ' (hub restart or restore from an older snapshot); re-applying hub config and resetting the cursor.');
            this.mergeHubParams(configs);
            this.lastHubConfigSeq       = seq;
            this.lastHubConfigWatermark = watermark;
            return true;
        }
        return false;
    },

    // Re-apply on EITHER signal advancing: seq (PBFT-committed) OR watermark
    // (any config write, incl. a standalone/config-oracle hub with no consensus).
    // Older hubs omit watermark -> it defaults to 0 and never advances, so this
    // stays back-compatible with a seq-only hub.
    //
    // Same-second redelivery: the hub reads its config watermark BEFORE the rows
    // (xchain-hub api.js/db.js getConfigWatermark), so a write committed after the
    // watermark read but stamped in the SAME epoch-second is carried in the full
    // config tree while the watermark it reports stays equal. A strict `>` gate
    // would skip that row forever on a hub whose PBFT seq never advances (a
    // standalone/config-oracle hub, seq stuck at 0), acting on stale config with
    // no staleness signal. So an equal NON-ZERO watermark is treated as re-apply-
    // eligible: mergeHubParams is idempotent, so re-merging the (full) tree is
    // safe. A missing watermark (0) keeps the strict path so a seq-only hub does
    // NOT re-merge every poll. This relies on the full-tree fetch and stays that
    // way: the hub's since_updated_at delta boundary is now inclusive `>=`,
    // so a new-enough hub no longer drops the same-second row, but
    // an older hub's strict `>` still would - the full-tree fetch is the
    // deployment-skew-proof choice, so do not thread the delta cursor here.
    applyHubConfigAdvance(seq, watermark, configs){
        let seqAdvanced       = seq > (this.lastHubConfigSeq || 0);
        let watermarkAdvanced = watermark > (this.lastHubConfigWatermark || 0);
        let watermarkRedeliver = watermark > 0 && watermark === (this.lastHubConfigWatermark || 0);
        if(seqAdvanced || watermarkAdvanced || watermarkRedeliver){
            this.mergeHubParams(configs);
            this.lastHubConfigSeq = Math.max(seq, this.lastHubConfigSeq || 0);
            this.lastHubConfigWatermark = Math.max(watermark, this.lastHubConfigWatermark || 0);
            // Only announce an actual advance; an equal-watermark redelivery re-merge
            // is a steady-state no-op on a watermark-bearing hub and must not log-spam.
            if(seqAdvanced || watermarkAdvanced)
                getLogger().info('XChainIndexer: applied hub config update (committed seq ' + seq + ', watermark ' + watermark + ')');
        }
    }
};

module.exports = { hubConfigCoinKey, hubConfigMethods };
