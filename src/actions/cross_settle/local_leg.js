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
 * Which leg of a mirrored cross-chain match belongs to THIS chain, and whether it
 * is worth doing the signature work for at all. Everything here answers from chain
 * state and the row's own fields, never from the signatures, which is why it runs
 * before the quorum check.
 *
 * Called with the handler as `this`, the way execute/slash_emission.js is.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../observability/index.js');

/**
 * Network scope: a match is bound to the network it was matched + signed on (also in the
 * canonical). Refuse any match not for THIS indexer's network so a
 * regtest/testnet-signed match can never settle on a mainnet indexer even if
 * its row is mirrored in. getEffectiveUnsettledMatches already filters on
 * network; this is the security boundary's belt-and-suspenders guard.
 *
 * Called with the handler as `this` (it reads this.config).
 *
 * @param {Object} m - the mirrored cross_chain_matches row
 * @returns {boolean} true when the match was signed on this indexer's network
 */
function matchIsOnThisNetwork(m){
    if(String(m.network || '') !== String(this.config['NETWORK'] || '')){
        getLogger().warn("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : network mismatch (' + m.network + ' != ' + this.config['NETWORK'] + ') : skipping');
        return false;
    }
    return true;
}

/**
 * Identify this chain's leg: a = canonical-lower. On a's chain release a's escrow to b's payout (b_payout_addr);
 * on b's chain release b's escrow to a's payout (a_payout_addr).
 *
 * @param {Object} m    - the mirrored cross_chain_matches row
 * @param {string} coin - this chain's coin
 * @returns {Object|null} the local leg's fields, or null when the match is not ours
 */
function resolveLocalLeg(m, coin){

    let isA = (m.a_chain === coin);
    if(!isA && m.b_chain !== coin) return null;             // not our match

    return {
        isA:              isA,
        localActionIndex: isA ? Number(m.a_action_index) : Number(m.b_action_index),
        localKind:        String(isA ? m.a_kind : m.b_kind) || 'swap',
        giveTick:         isA ? m.a_tick : m.b_tick,
        giveAmount:       isA ? m.a_amount : m.b_amount,    // FILL released from local escrow
        getAmount:        isA ? m.b_amount : m.a_amount,    // FILL the local offer receives
        getTick:          isA ? m.b_tick : m.a_tick,        // tick the local offer receives
        giveOwnership:    Number(isA ? m.a_ownership : m.b_ownership),
        payoutAddr:       isA ? m.b_payout_addr : m.a_payout_addr,
        counterpartyCoin: isA ? m.b_chain : m.a_chain
    };
}

/**
 * A match the mirror keeps serving but whose local leg is provably not an offer on
 * this chain never settles, however many blocks re-evaluate it: a hub database that
 * outlives a regtest re-genesis carries matches from the dead chain, and each fresh
 * indexer then re-read and re-logged both of them at every block. Judge that BEFORE
 * the signature work, since it depends on chain state only. "Provably" means the
 * leg's action index is already parsed here and resolves to no open-able offer or
 * order; an index not yet parsed is a leg the replay has not reached, so it falls
 * through to the ordinary path and is retried. A dismissal holds only while the chain
 * is above the block that judged it, so a rollback below that block re-evaluates
 * the match without any rollback hook.
 *
 * Called with the handler as `this` (it reads this.indexerDb and the dismissal map).
 *
 * @param {Object} data - the action row under construction; reads BLOCK_INDEX
 * @param {Object} m    - the mirrored cross_chain_matches row
 * @param {Object} leg  - the local leg resolveLocalLeg returned
 * @param {string} coin - this chain's coin, for the log line
 * @returns {Promise<{dismissed: boolean, localInfo: (Object|undefined)}>} localInfo is
 *          the local swap or order row, read once per block for the settle path
 */
async function probeLocalLeg(data, m, leg, coin){

    let blockIndex = Number(data['BLOCK_INDEX']);
    let dismissed  = this.dismissed.get(m.match_id);
    if(dismissed){
        if(blockIndex > dismissed.block) return { dismissed: true };
        this.dismissed.delete(m.match_id);
    }
    let localInfo = (leg.localKind === 'order')
        ? await this.indexerDb.getOrderInfo(leg.counterpartyCoin, leg.localActionIndex)
        : await this.indexerDb.getSwapInfo(leg.counterpartyCoin, leg.localActionIndex);
    if(!localInfo && await this.indexerDb.isActionIndexParsed(leg.localActionIndex)){
        this.dismissed.set(m.match_id, { block: blockIndex });
        getLogger().warn("\t CROSS_SETTLE : match=" + String(m.match_id).substring(0,16) + '... : local ' + leg.localKind + ' ' + coin + ':' + leg.localActionIndex + ' is an indexed action but not a cross-chain ' + leg.localKind + ' : dismissed until a reorg below block ' + blockIndex);
        return { dismissed: true };
    }

    return { dismissed: false, localInfo: localInfo };
}

module.exports = {
    matchIsOnThisNetwork,
    resolveLocalLeg,
    probeLocalLeg
};
