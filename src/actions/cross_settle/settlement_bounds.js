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
 * The bounds a verified match must fit before it moves value on this chain, from
 * settlement_bounds_activation. The match is quorum-signed, but the local offer's
 * escrow is the authority on what can leave it: a leg settles only the tick and
 * ownership flag the offer itself gives, and a swap leg releases at most the
 * swap's own escrow. Below the activation every function here leaves the match's
 * terms as signed.
 *
 * Called with the handler as `this`, the way settle_leg.js is.
 *
 ********************************************************************/

'use strict';

const gateRegistry = require('../../consensus/gate_registry');
const { getLogger } = require('../../observability/index.js');

// Read on this chain's own block, not the match's BTC-anchored snapshot block: the bounds
// govern what leaves this chain's escrow, not which bytes the validators signed.
const SETTLEMENT_BOUNDS_KEY = 'settlement_bounds_activation.SETTLEMENT_BOUNDS_ACTIVATION';

/**
 * Whether settlement_bounds_activation is active at this block on this chain.
 *
 * @param {Object}        handler    - the Cross_Settle handler; reads config NETWORK and COIN
 * @param {number|string} blockIndex - the block being parsed
 * @returns {boolean} true from the activation height on
 */
function settlementBoundsAt(handler, blockIndex){
    return gateRegistry.activeAt(SETTLEMENT_BOUNDS_KEY, handler.config['NETWORK'], handler.config['COIN'], Number(blockIndex), null);
}

/**
 * True when, from the activation, the match names a different give side than the local
 * offer's own: another tick (a native leg reads as the coin on both sides) or another
 * ownership flag. Such a match would release a tick the offer never escrowed or move
 * ownership it never put up, so the caller records a no-op settlement instead. Below the
 * activation nothing is compared and this is false.
 *
 * Called with the handler as `this`.
 *
 * @param {Object} data  - the action row under construction; reads BLOCK_INDEX
 * @param {Object} m     - the mirrored cross_chain_matches row
 * @param {string} coin  - this chain's coin
 * @param {Object} leg   - the local leg; reads giveTick, giveOwnership and localActionIndex
 * @param {Object} offer - the local swap or order row; reads GIVE_TICK and GIVE_OWNERSHIP
 * @returns {boolean} true when the match must not move value
 */
function mismatchesOffer(data, m, coin, leg, offer){
    if(!settlementBoundsAt(this, data['BLOCK_INDEX']))
        return false;
    let matchTick      = String(leg.giveTick || coin);
    let offerTick      = String(offer['GIVE_TICK'] || coin);
    let offerOwnership = Number(offer['GIVE_OWNERSHIP'] || 0);
    if(matchTick === offerTick && leg.giveOwnership === offerOwnership)
        return false;
    getLogger().warn("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : names ' + matchTick + ' (ownership ' + leg.giveOwnership + ') but offer ' +
                coin + ':' + leg.localActionIndex + ' gives ' + offerTick + ' (ownership ' + offerOwnership + ') : recording no-op settlement');
    return true;
}

/**
 * The swap leg's release from the activation: an open swap still holds its whole
 * GIVE_AMOUNT in escrow, so a match stamping more releases only that, the bound
 * settle_leg.js clampFillToEscrow applies to an order's remaining give. An ownership swap
 * escrows no balance and is not clamped. Below the activation the match's amount stands.
 *
 * Called with the handler as `this`.
 *
 * @param {Object} data     - the action row under construction; reads BLOCK_INDEX
 * @param {Object} m        - the mirrored cross_chain_matches row
 * @param {string} coin     - this chain's coin
 * @param {Object} leg      - the local leg; reads giveOwnership, giveAmount and localActionIndex
 * @param {Object} swapInfo - the local swap row; reads GIVE_AMOUNT
 * @returns {string|number} the amount to release
 */
function clampSwapReleaseToEscrow(data, m, coin, leg, swapInfo){
    let giveAmount = leg.giveAmount;
    if(leg.giveOwnership === 1 || !settlementBoundsAt(this, data['BLOCK_INDEX']))
        return giveAmount;
    let escrowed = swapInfo['GIVE_AMOUNT'];
    if(this.util.bclt(escrowed, giveAmount)){
        getLogger().warn("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : release ' + giveAmount + ' exceeds escrow ' + escrowed +
                    ' on swap ' + coin + ':' + leg.localActionIndex + ' : clamping release to escrow');
        giveAmount = escrowed;
    }
    return giveAmount;
}

module.exports = {
    mismatchesOffer,
    clampSwapReleaseToEscrow
};
