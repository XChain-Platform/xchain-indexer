/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * ROLLCALL activation and consensus constants (validator liveness eviction).
 *
 * A roll call is a signed proof of presence bound to a BTC epoch block's
 * `ledger_hash`: hubs sign, an elected leader lands the signatures on DOGECOIN
 * as a ROLLCALL action, and the BTC indexer -- the only place the capability
 * membership predicate runs -- closes each epoch by proving that DOGE action
 * the way the anchor rail already proves anchors. A source absent for
 * ROLLCALL_EVICT_MISSES consecutive ROLLED epochs is evicted by a synthetic
 * UNSTAKE, so its stake deactivates and refunds after the ordinary cooldown.
 * Nothing is burned: absence is not an offense.
 *
 * EVERY value here is CONSENSUS. They decide which epochs exist, which
 * signatures count, and at what BTC height an eviction and a COLLECT-spendable
 * reward materialise. None may be read from the coin registry, from env, or
 * from coins.resolveConfirmations() -- the same argument
 * anchor_reward_activation.js makes for its own maturity and burial depths: a
 * ledger input cannot be sourced from a field nothing pins and anyone may tune.
 *
 * Canonical map of record is xchain-documentation/protocol/constants.js; the
 * twin lives in xchain-hub/src/rollcall_activation.js and is kept BYTE-IDENTICAL
 * apart from that one reference line, because the hub signs what the indexer
 * judges and a one-sided edit forks the fleet at the epoch boundary.
 *
 * KEYING. Every gate here keys on the carried BTC EPOCH_HEIGHT, on BOTH chains,
 * which is the `snapshot_block` convention of stake_weighted_quorum.js and NOT
 * either chain's local processing height. That is what makes a pre-activation
 * roll call inert on DOGE and on BTC alike, so no second DOGE-height flag day
 * has to be coordinated against this one.
 *
 ********************************************************************/

// Per-network BTC height at/above which ROLLCALL epochs exist at all.
// INERT on mainnet (null = never active) until the operator pins a height with
// the mainnet federation. The null placeholder follows the live precedent of
// SNAPSHOT_BURIAL_ACTIVATION.mainnet; because null is a legitimate value here,
// every read MUST go through the Number.isFinite guard below -- a bare
// `height >= ROLLCALL_ACTIVATION[network]` arms mainnet at height 0, since
// `0 >= null` is true in JS.
const ROLLCALL_ACTIVATION = {
    mainnet: null,        // INERT placeholder: the operator owns this height
    testnet: 151200,      // 1008 x 150 = 144 x 1050; tip was 150400 on 2026-08-30, ~5.5 days out
    regtest: 0,
};

// Epoch cadence in BTC blocks. Weekly on the live networks per the 2026-08-30
// ruling: with K=2 an outage shorter than one epoch minus the accept window
// (~6 days) can never evict, and 2-3 weeks idle always does. Regtest uses 30 so
// an acceptance run does not have to mine 2 x 1008 blocks.
const ROLLCALL_INTERVAL_BLOCKS = { mainnet: 1008, testnet: 1008, regtest: 30 };

// How long after the epoch block a signature may still land, in BTC blocks. The
// BTC header stamp at E + this value is what cuts the DOGE chain (see
// rollcallWindowEndHeight / the epoch close).
const ROLLCALL_ACCEPT_WINDOW_BLOCKS = { mainnet: 144, testnet: 144, regtest: 12 };

// BTC blocks after the window closes before the epoch closes, giving the DOGE
// side time to bury. MUST be >= 1 on every network: a block's `block_time` is
// written by createBlock AFTER that block's own processing, so the window
// endpoint has to be a strictly earlier block than the close, or the close
// reads a timestamp that does not exist yet.
const ROLLCALL_PROOF_DELAY_BLOCKS = { mainnet: 36, testnet: 36, regtest: 2 };

// DOGE blocks past the window cut before a DOGE indexer's answer is admissible;
// the anchor rail's own burial depth. This is what bounds the one residual the
// design accepts: a DOGE reorg deeper than this, removing a counted signature
// after the BTC close has recorded its epoch, cannot be undone from BTC,
// because nothing there observes it and no un-evict rail exists.
const ROLLCALL_DOGE_MATURITY = { mainnet: 60, testnet: 60, regtest: 2 };

// K: consecutive ROLLED epochs a source must be absent for before eviction.
const ROLLCALL_EVICT_MISSES = 2;

// 2K: how many rolled epochs back the K-streak may reach. Bounds how far an old
// absence can travel, so a source that leaves for months and returns starts
// clean rather than resuming a stale streak.
const ROLLCALL_STREAK_LOOKBACK = 4;

// The frozen rollcall-publish reward, minted BTC-side to the ELECTED LEADER
// only -- never to whoever published first, which would be a fee-bidding race
// no hub can bump, since there is no fee-bump or RBF path anywhere in the hub.
// Parity with ANCHOR_REWARD_AMOUNT per the 2026-08-30 ruling. Never from the wire.
const ROLLCALL_REWARD_AMOUNT = '10.00000000';

/**
 * Whether ROLLCALL is active for an epoch at BTC height `epochHeight` on `network`.
 * An unparseable height, an inert null gate, or an unknown network -> false (safe).
 * @param {number|string} epochHeight BTC height of the roll-call epoch
 * @param {string} network mainnet|testnet|regtest
 * @returns {boolean}
 */
function isRollcallActive(epochHeight, network){
    let h = parseInt(epochHeight);
    if(!Number.isFinite(h)) return false;
    let threshold = ROLLCALL_ACTIVATION[network];
    if(threshold === null || threshold === undefined) return false;
    if(!Number.isFinite(parseInt(threshold))) return false;
    return h >= threshold;
}

/**
 * Whether `height` is an epoch boundary on `network`. Epoch 0 IS a real epoch on
 * regtest (ROLLCALL_ACTIVATION.regtest is 0), so callers must not treat a falsy
 * height as "no epoch".
 * @param {number|string} height BTC height
 * @param {string} network mainnet|testnet|regtest
 * @returns {boolean}
 */
function isRollcallEpoch(height, network){
    let h = parseInt(height);
    if(!Number.isFinite(h) || h < 0) return false;
    let interval = ROLLCALL_INTERVAL_BLOCKS[network];
    if(!Number.isFinite(parseInt(interval)) || interval <= 0) return false;
    return (h % interval) === 0;
}

/**
 * The BTC height whose header stamp cuts the DOGE window for epoch `epochHeight`.
 * @returns {number|null} null for an unparseable height or unknown network, so a
 *   caller fails closed rather than cutting the window at NaN.
 */
function rollcallWindowEndHeight(epochHeight, network){
    let h = parseInt(epochHeight);
    if(!Number.isFinite(h)) return null;
    let w = ROLLCALL_ACCEPT_WINDOW_BLOCKS[network];
    if(!Number.isFinite(parseInt(w))) return null;
    return h + w;
}

/**
 * The BTC height at which epoch `epochHeight` closes: C = E + window + proof delay.
 * @returns {number|null} null for an unparseable height or unknown network.
 */
function rollcallCloseHeight(epochHeight, network){
    let end = rollcallWindowEndHeight(epochHeight, network);
    if(end === null) return null;
    let d = ROLLCALL_PROOF_DELAY_BLOCKS[network];
    if(!Number.isFinite(parseInt(d))) return null;
    return end + d;
}

/**
 * The epoch whose close block is `height`, or null if no epoch closes there.
 * The close runs once per block, so this is the BTC indexer's entry point: it
 * answers "is this block a close, and for which epoch" without scanning.
 * @returns {number|null}
 */
function rollcallEpochClosingAt(height, network){
    let h = parseInt(height);
    if(!Number.isFinite(h)) return null;
    let w = ROLLCALL_ACCEPT_WINDOW_BLOCKS[network];
    let d = ROLLCALL_PROOF_DELAY_BLOCKS[network];
    if(!Number.isFinite(parseInt(w)) || !Number.isFinite(parseInt(d))) return null;
    let epoch = h - w - d;
    if(epoch < 0) return null;
    if(!isRollcallEpoch(epoch, network)) return null;
    if(!isRollcallActive(epoch, network)) return null;
    return epoch;
}

module.exports = {
    ROLLCALL_ACTIVATION,
    ROLLCALL_INTERVAL_BLOCKS,
    ROLLCALL_ACCEPT_WINDOW_BLOCKS,
    ROLLCALL_PROOF_DELAY_BLOCKS,
    ROLLCALL_DOGE_MATURITY,
    ROLLCALL_EVICT_MISSES,
    ROLLCALL_STREAK_LOOKBACK,
    ROLLCALL_REWARD_AMOUNT,
    isRollcallActive,
    isRollcallEpoch,
    rollcallWindowEndHeight,
    rollcallCloseHeight,
    rollcallEpochClosingAt
};
