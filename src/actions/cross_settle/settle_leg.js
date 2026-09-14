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
 * What a verified cross-chain match DOES to this chain: release the local offer's
 * escrow to the counterparty's payout address, record the settlement, and complete
 * the offer. A SWAP leg releases in full; an ORDER leg releases one fill and stays
 * open until nothing remains to give.
 *
 * Both paths reach this file only after local_leg.js found our leg and quorum.js
 * verified the signatures, so nothing here re-checks trust; it moves value.
 *
 * Called with the handler as `this`, the way execute/slash_emission.js is.
 *
 ********************************************************************/

'use strict';

const ccr = require('../../cross_chain_royalty_activation.js');

const { getLogger } = require('../../observability/index.js');

/**
 * Settle a SWAP leg: the local offer must still be open (not already settled /
 * cancelled / expired), and the whole escrow releases to the counterparty.
 * A cross-chain swap stores get_coin = counterparty coin, so getSwapInfo resolved it
 * in the dismissal probe (once per block) and is handed in here.
 *
 * Called with the handler as `this`.
 *
 * @param {Object}      data     - the action row under construction
 * @param {Object}      m        - the mirrored cross_chain_matches row
 * @param {string}      coin     - this chain's coin
 * @param {Object}      leg      - the local leg local_leg.js resolved
 * @param {Object|null} swapInfo - the local swap row, or null when it is not there
 * @returns {Promise<void>}
 */
async function settleSwapLeg(data, m, coin, leg, swapInfo){

    if(!swapInfo){
        getLogger().warn("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : local offer ' + coin + ':' + leg.localActionIndex + ' not found : skipping');
        return;
    }
    if(swapInfo['SWAP_STATUS'] !== 'open'){
        // Already terminal (settled via a prior pass, cancelled, or expired). Record the
        // settlement so we stop re-evaluating it, but move no funds. The record is
        // anchored to a real internal action row so a reorg (which may revive the
        // offer's open status) drops it and the match re-applies.
        getLogger().info("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : offer ' + coin + ':' + leg.localActionIndex + ' not open (' + swapInfo['SWAP_STATUS'] + ') : recording no-op settlement');
        await recordNoopSettlement.call(this, data, m, leg.localActionIndex);
        return;
    }

    // Settle: mint an internal action and release escrow to the counterparty.
    let action = { ACTION: 'CROSS_SETTLE', BLOCK_INDEX: data['BLOCK_INDEX'] };
    data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);
    data['STATUS'] = 'valid';

    getLogger().info("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : release ' +
                leg.giveAmount + ' ' + coin + ':' + (leg.giveTick || coin) + ' → ' + leg.payoutAddr + ' : ' + data['STATUS']);

    await releaseEscrow.call(this, data, m, coin, leg, leg.giveAmount, swapInfo['SOURCE']);

    // Complete the offer and record the settlement (idempotent on match_id).
    await this.indexerDb.createSwapStatus(data['ACTION_INDEX'], leg.localActionIndex, 'complete');
    await this.indexerDb.recordCrossChainSettlement(data['ACTION_INDEX'], m, leg.localActionIndex, data['BLOCK_INDEX']);

    let addresses = Object.keys(this.util.getAddressesList());
    await this.indexerDb.updateBalances(addresses);

    await this.mapper.createMappings(data);
}

/**
 * Settle one ORDER leg of a cross-chain match: release only THIS match's fill from escrow
 * to the counterparty, record the fill (so the order's remaining drops), and complete the
 * order only once fully filled. Multiple partial fills each settle once (distinct match_id
 * → distinct cross_chain_settlements row), accumulating against the same local order.
 *
 * Called with the handler as `this`.
 *
 * @param {Object}                data      - the action row under construction
 * @param {Object}                m         - the mirrored cross_chain_matches row
 * @param {string}                coin      - this chain's coin
 * @param {Object}                leg       - the local leg local_leg.js resolved
 * @param {Object|null|undefined} orderInfo - the local order row; undefined means unread
 * @returns {Promise<void>}
 */
async function settleOrderLeg(data, m, coin, leg, orderInfo){

    // A cross-chain order stores get_coin = counterparty coin, so getOrderInfo (which
    // filters by get_coin) resolves it under the counterparty coin; parse() already read
    // it for the dismissal probe and hands it in, so the leg is read once per block.
    if(orderInfo === undefined)
        orderInfo = await this.indexerDb.getOrderInfo(leg.counterpartyCoin, leg.localActionIndex);
    if(!orderInfo){
        getLogger().warn("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : local order ' + coin + ':' + leg.localActionIndex + ' not found : skipping');
        return;
    }
    if(orderInfo['ORDER_STATUS'] !== 'open'){
        // Terminal already (fully filled by a prior pass, cancelled, or expired). Record
        // the settlement so we stop re-evaluating it but move no funds (same
        // reorg-anchored no-op record as the swap leg above).
        getLogger().info("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : order ' + coin + ':' + leg.localActionIndex + ' not open (' + orderInfo['ORDER_STATUS'] + ') : recording no-op settlement');
        await recordNoopSettlement.call(this, data, m, leg.localActionIndex);
        return;
    }

    let clamped = await clampFillToEscrow.call(this, data, m, coin, leg, orderInfo);
    if(clamped === null)
        return;

    await applyOrderFill.call(this, data, m, coin, leg, orderInfo, clamped);
}

/**
 * Escrow-authoritative clamp (XDEX-COMMIT-TOCTOU): the hub's
 * committed-fill reservation updates only on match finalization, so two
 * matches finalized concurrently for the same offer can carry fills whose
 * sum exceeds the order's escrow. The match row is quorum-signed but the
 * ESCROW is the authority on what can leave it: release at most what the
 * order still has (fills recorded by prior settlements included). The
 * over-stamped portion of a losing match simply never releases; the
 * counterparty's own leg is clamped independently against its own escrow.
 * Ownership orders are single-fill (no balance escrow), so no clamp.
 *
 * An order with nothing left to give records a no-op settlement and releases
 * nothing, which is reported back as null.
 *
 * Called with the handler as `this`.
 *
 * @param {Object} data      - the action row under construction
 * @param {Object} m         - the mirrored cross_chain_matches row
 * @param {string} coin      - this chain's coin
 * @param {Object} leg       - the local leg; reads giveOwnership and giveAmount
 * @param {Object} orderInfo - the local order row; reads GIVE_REMAINING
 * @returns {Promise<string|number|null>} the amount to release, or null for a no-op
 */
async function clampFillToEscrow(data, m, coin, leg, orderInfo){

    let giveAmount = leg.giveAmount;
    if(leg.giveOwnership !== 1){
        let giveRemaining = orderInfo['GIVE_REMAINING'];
        if(giveRemaining !== undefined && giveRemaining !== null){
            if(this.util.bclte(giveRemaining, 0)){
                getLogger().warn("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : order ' + coin + ':' + leg.localActionIndex + ' has no give remaining : recording no-op settlement');
                await recordNoopSettlement.call(this, data, m, leg.localActionIndex);
                return null;
            }
            if(this.util.bclt(giveRemaining, giveAmount)){
                getLogger().warn("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : fill ' + giveAmount + ' exceeds give remaining ' + giveRemaining + ' on order ' + coin + ':' + leg.localActionIndex + ' : clamping release to escrow');
                giveAmount = giveRemaining;
            }
        }
    }
    return giveAmount;
}

/**
 * Release one order fill: mint the internal action, move the escrow, record the fill so
 * getOrderAmountsRemaining deducts it, and complete the order only when nothing remains
 * to give.
 *
 * Called with the handler as `this`.
 *
 * @param {Object}        data       - the action row under construction
 * @param {Object}        m          - the mirrored cross_chain_matches row
 * @param {string}        coin       - this chain's coin
 * @param {Object}        leg        - the local leg local_leg.js resolved
 * @param {Object}        orderInfo  - the local order row
 * @param {string|number} giveAmount - the clamped fill to release
 * @returns {Promise<void>}
 */
async function applyOrderFill(data, m, coin, leg, orderInfo, giveAmount){

    let action = { ACTION: 'CROSS_SETTLE', BLOCK_INDEX: data['BLOCK_INDEX'] };
    data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);
    data['STATUS'] = 'valid';

    getLogger().info("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : order fill release ' +
                giveAmount + ' ' + coin + ':' + (leg.giveTick || coin) + ' → ' + leg.payoutAddr + ' : ' + data['STATUS']);

    await releaseEscrow.call(this, data, m, coin, leg, giveAmount, orderInfo['SOURCE']);

    // Record the fill so getOrderAmountsRemaining deducts it (single source of truth).
    await this.indexerDb.recordCrossChainOrderFill(data['ACTION_INDEX'], leg.localActionIndex, giveAmount, leg.getAmount, coin, leg.giveTick, leg.counterpartyCoin, leg.getTick);

    // Complete the order only when nothing remains to give (or it was an ownership order,
    // which is single-fill). Otherwise it stays 'open' for further fills.
    let [give_remaining] = await this.indexerDb.getOrderAmountsRemaining(leg.localActionIndex);
    if(leg.giveOwnership === 1 || this.util.bclte(give_remaining, 0))
        await this.indexerDb.createOrderStatus(data['ACTION_INDEX'], leg.localActionIndex, 'complete');

    // Record the settlement (idempotent on match_id).
    await this.indexerDb.recordCrossChainSettlement(data['ACTION_INDEX'], m, leg.localActionIndex, data['BLOCK_INDEX']);

    let addresses = Object.keys(this.util.getAddressesList());
    await this.indexerDb.updateBalances(addresses);

    await this.mapper.createMappings(data);
}

/**
 * The ledger half both legs share: an ownership offer transfers the token itself,
 * anything else releases escrow and credits the proceeds.
 *
 * Called with the handler as `this`.
 *
 * @param {Object}        data        - the action row; carries the minted ACTION_INDEX
 * @param {Object}        m           - the mirrored cross_chain_matches row
 * @param {string}        coin        - this chain's coin
 * @param {Object}        leg         - the local leg local_leg.js resolved
 * @param {string|number} giveAmount  - the amount actually released
 * @param {string}        offerSource - the local offer's SOURCE (the ownership seller)
 * @returns {Promise<void>}
 */
async function releaseEscrow(data, m, coin, leg, giveAmount, offerSource){

    let credits = [], debits = [], escrows = [];
    if(leg.giveOwnership === 1){
        // Ownership orders are single-fill: transfer ownership, no balance escrow.
        await this.util.transferTokenOwnership(this.indexerDb, this.mapper, data, leg.giveTick, offerSource, leg.payoutAddr);
    } else {
        // BigNumber-space negation, not JS unary minus (float truncation).
        escrows.push([leg.giveTick, this.util.bcsub(0, giveAmount, 64), leg.payoutAddr]);
        for(let c of await proceedsCredits.call(this, data, m, coin, leg.giveTick, giveAmount, leg.payoutAddr, leg.counterpartyCoin)){
            credits.push(c);
            this.util.addAddressTicker(c[2], c[0]);
        }
    }

    await this.util.processTransactionLedgerChanges(this.indexerDb, data, credits, debits, escrows);
}

/**
 * Build the proceeds credit(s) for a non-ownership escrow release. The released escrow
 * is the proceeds of the OTHER chain's offer (its seller listed a controlled token
 * there, and its guard produced the stored royalty split), so at/above the
 * CROSS_CHAIN_ROYALTY flag-day the counterparty's legs are applied here: each leg `to`
 * is re-encoded from the counterparty chain's address encoding to THIS chain's
 * (crossChainReencodeAddress; same hash160/witness program, different version byte or
 * HRP), then applyProceedsSplit replaces the single full credit with seller remainder
 * + leg credits, conserving giveAmount exactly. Fail-closed like applyProceedsSplit: a
 * native-coin leg (no tick), a malformed legs set, or any leg that does not re-encode
 * (impossible for a create-side-validated order, but a hostile mirror row could carry
 * anything) yields NO split, so the seller keeps full proceeds and a bad row can never
 * trap the settlement. Below the flag-day the single full credit is returned unchanged.
 *
 * Called with the handler as `this`.
 *
 * @param {Object}        data             - the action row; carries BLOCK_INDEX and ACTION_INDEX
 * @param {Object}        m                - the mirrored cross_chain_matches row
 * @param {string}        coin             - this chain's coin
 * @param {string}        giveTick         - the tick being released
 * @param {string|number} giveAmount       - the amount being released
 * @param {string}        payoutAddr       - the counterparty's payout address on this chain
 * @param {string}        counterpartyCoin - the chain the legs were encoded for
 * @returns {Promise<Array<Array>>} the credit rows to write
 */
async function proceedsCredits(data, m, coin, giveTick, giveAmount, payoutAddr, counterpartyCoin){
    let full = [[giveTick, giveAmount, payoutAddr]];
    if(!ccr.isCrossChainRoyaltyActive(m.snapshot_block, m.network))
        return full;
    // The legs belong to the offer whose proceeds THIS release pays out: on a's chain
    // the escrow releases to b's payout (b's legs), and vice versa.
    let isA      = (m.a_chain === coin);
    let legsJson = isA ? m.b_payout_legs : m.a_payout_legs;
    if(this.util.isNull(legsJson) || this.util.isNull(giveTick))
        return full;
    let parsed;
    try { parsed = JSON.parse(legsJson); } catch(e){ return full; }
    if(!Array.isArray(parsed) || parsed.length === 0)
        return full;
    let reencoded = [];
    for(let leg of parsed){
        let to = this.util.crossChainReencodeAddress((leg ? leg.to : null), counterpartyCoin, coin, this.config['NETWORK']);
        if(to === null)
            return full;
        reencoded.push({ to: to, bps: leg.bps });
    }
    let dec  = 0;
    let info = await this.indexerDb.getTokenInfo(giveTick, data['BLOCK_INDEX'], data['ACTION_INDEX']);
    if(info && !this.util.isNull(info['DECIMALS']))
        dec = parseInt(info['DECIMALS']);
    return this.util.applyProceedsSplit(giveTick, giveAmount, payoutAddr, reencoded, dec, parseInt(this.config['CONTROLLER_MAX_TAKE_BPS']));
}

/**
 * Record a no-op settlement for a match whose local offer is already terminal:
 * mint the internal CROSS_SETTLE action (the rollback anchor) and the
 * cross_chain_settlements row, move no funds. Without the record, the match
 * stays "effective + unsettled" and re-evaluates on every subsequent block.
 *
 * Called with the handler as `this`.
 *
 * @param {Object} data             - the action row under construction
 * @param {Object} m                - the mirrored cross_chain_matches row
 * @param {number} localActionIndex - this chain's leg action index
 * @returns {Promise<void>}
 */
async function recordNoopSettlement(data, m, localActionIndex){
    let action = { ACTION: 'CROSS_SETTLE', BLOCK_INDEX: data['BLOCK_INDEX'] };
    data['ACTION_INDEX'] = await this.indexerDb.createActionIndex(action);
    data['STATUS'] = 'valid';
    await this.indexerDb.recordCrossChainSettlement(data['ACTION_INDEX'], m, localActionIndex, data['BLOCK_INDEX']);
    await this.mapper.createMappings(data);
}

module.exports = {
    settleSwapLeg,
    settleOrderLeg,
    proceedsCredits,
    recordNoopSettlement
};
