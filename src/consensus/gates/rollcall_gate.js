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
 * reward materialise. On a SHARED-LEDGER network -- mainnet and testnet, where
 * many nodes validate one chain -- none may be read from the coin registry,
 * from env, or from coins.resolveConfirmations(), the same argument
 * anchor_reward_activation.js makes for its own maturity and burial depths: a
 * ledger input cannot be sourced from a field nothing pins and anyone may tune.
 *
 * THAT ARGUMENT IS ABOUT A SHARED LEDGER, so per the 2026-09-01 ruling it is
 * scoped to the networks that have one. A regtest chain is private: no two
 * regtest venues validate the same blocks, so a height one venue pins for itself
 * cannot fork anybody, and refusing it only meant AT1-AT10 had nowhere to run.
 * Regtest therefore takes its arming height from the environment, documented at
 * ROLLCALL_REGTEST_ARMED_HEIGHT below. mainnet and testnet stay literal and are
 * not reachable from env by any path in this file.
 *
 * A HALF-ARMED regtest venue is visible rather than silent: ROLLCALL_ACTIVATION
 * is one of consensus_rules_digest.js's SHARED_GATES, so a hub armed against an
 * inert indexer reports a rules mismatch instead of quietly disagreeing about
 * which epochs exist.
 *
 * Canonical map of record is xchain-documentation/protocol/constants.js; the
 * twin lives at the same path (src/consensus/gates/rollcall_gate.js) in the hub
 * and the indexer and is kept BYTE-IDENTICAL, because the hub signs what the
 * indexer judges and a one-sided edit forks the fleet at the epoch boundary.
 *
 * KEYING. Every gate here keys on the carried BTC EPOCH_HEIGHT, on BOTH chains,
 * which is the `snapshot_block` convention of stake_weighted_quorum.js and NOT
 * either chain's local processing height. That is what makes a pre-activation
 * roll call inert on DOGE and on BTC alike, so no second DOGE-height flag day
 * has to be coordinated against this one.
 *
 ********************************************************************/

const { get, copy, activeAt } = require('../gate_registry');

const ROLLCALL_REGTEST_ARMED_HEIGHT = copy('rollcall_activation.ROLLCALL_REGTEST_ARMED_HEIGHT');

const ROLLCALL_REGTEST_ENV = copy('rollcall_activation.ROLLCALL_REGTEST_ENV');

/**
 * Resolve the regtest arming height from `env`.
 *
 * UNSET SHIPS INERT, and that default is not timidity. Arming a network commits
 * every BTC indexer on it to a wired DOGE peer: the epoch close cannot decide a
 * non-empty responsible set without one, and it defers the block rather than
 * reading silence as absence. That is the 2026-08-31 finding, which was that a
 * hardcoded regtest height wedged every single-coin BTC venue at its first
 * close. So a two-chain acceptance venue opts IN, and a BTC-only venue that
 * cannot answer a close is left alone.
 *
 * Accepted forms, case-insensitive and trimmed:
 *   armed | genesis | on | true | yes  -> ROLLCALL_REGTEST_ARMED_HEIGHT
 *   a non-negative integer             -> that height, for a venue whose epochs
 *                                         should begin above an indexed prefix
 *   unset | '' | off | inert | false | no | none -> null (INERT)
 * Anything else fails CLOSED to null and says so on stderr, because a typo that
 * silently armed a venue would produce closes nobody meant to drive.
 *
 * Read ONCE, at require time, on purpose: an activation height that could change
 * under a running process is not an activation height.
 *
 * @param {object} env the process environment, or a stand-in
 * @returns {number|null}
 */
function resolveRegtestActivation(env){
    let raw = (env || {})[ROLLCALL_REGTEST_ENV];
    if(raw === undefined || raw === null) return null;
    let s = String(raw).trim().toLowerCase();
    if(s === '' || s === 'off' || s === 'inert' || s === 'false' || s === 'no' || s === 'none') return null;
    if(s === 'armed' || s === 'genesis' || s === 'on' || s === 'true' || s === 'yes')
        return ROLLCALL_REGTEST_ARMED_HEIGHT;
    if(/^\d+$/.test(s)){
        let h = parseInt(s, 10);
        if(Number.isFinite(h) && h >= 0) return h;
    }
    console.error('ROLLCALL: ignoring ' + ROLLCALL_REGTEST_ENV + '=' + JSON.stringify(String(raw)) +
                  '; regtest stays INERT. Expected a non-negative height, "armed", or "off".');
    return null;
}

const ROLLCALL_ACTIVATION = copy('rollcall_activation.ROLLCALL_ACTIVATION');

const ROLLCALL_INTERVAL_BLOCKS = copy('rollcall_activation.ROLLCALL_INTERVAL_BLOCKS');

const ROLLCALL_ACCEPT_WINDOW_BLOCKS = copy('rollcall_activation.ROLLCALL_ACCEPT_WINDOW_BLOCKS');

const ROLLCALL_PROOF_DELAY_BLOCKS = copy('rollcall_activation.ROLLCALL_PROOF_DELAY_BLOCKS');

const ROLLCALL_DOGE_MATURITY = copy('rollcall_activation.ROLLCALL_DOGE_MATURITY');

const ROLLCALL_EVICT_MISSES = copy('rollcall_activation.ROLLCALL_EVICT_MISSES');

const ROLLCALL_STREAK_LOOKBACK = copy('rollcall_activation.ROLLCALL_STREAK_LOOKBACK');

const ROLLCALL_REWARD_AMOUNT = copy('rollcall_activation.ROLLCALL_REWARD_AMOUNT');

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
 * an armed regtest venue (ROLLCALL_REGTEST_ARMED_HEIGHT is 0), so callers must
 * not treat a falsy height as "no epoch".
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
    ROLLCALL_REGTEST_ARMED_HEIGHT,
    ROLLCALL_REGTEST_ENV,
    resolveRegtestActivation,
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
