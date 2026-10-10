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
 * XChain Indexer - JSON-RPC order family: this chain's open cross-chain book for the hub's matcher.
 *
 * Each group factory below closes over the context object src/api.js builds
 * (apiContext) and returns its methods verbatim; src/api/rpc/index.js merges
 * every family into the one controller the JSON-RPC router dispatches on.
 *
 ********************************************************************/

const { stampGiveDecimals } = require('../cross_chain_offer_decimals');
const { tipBlockTime }   = require('../tip_block_time');            // expiry filter clock for the open book
const { getLogger } = require('../../observability/index.js');
const gateRegistry = require('../../protocol_changes.js');

const OFFER_LIST_EXPORT_KEY = 'cross_chain_offer_list_export_activation.CROSS_CHAIN_OFFER_LIST_EXPORT';

function normalizeLimit(limit){
    let max = Number(limit);
    if(!Number.isFinite(max) || max <= 0) return 100;
    return Math.min(max, 500);
}

async function applyEffectiveOfferLists(indexer, db, offers, latest){
    let exportOfferLists = gateRegistry.activeAt(
        OFFER_LIST_EXPORT_KEY,
        indexer.config['NETWORK'],
        indexer.config['COIN'],
        latest,
        null
    );
    if(exportOfferLists && typeof db.applyEffectiveOpenCrossChainOfferLists === 'function')
        await db.applyEffectiveOpenCrossChainOfferLists(offers);
}

function warnIfTruncated(offers, max, latest){
    if(offers.truncated === true)
        getLogger().warn('getopencrosschainorders hit the cap of ' + max + ' at block ' + latest + ' - the open cross-chain book is truncated (newer offers dropped); the hub should page via next_cursor or raise its limit.');
}

async function readOpenCrossChainOrders(indexer, {to_coin, limit, after_action_index}){
    let max = normalizeLimit(limit);
    let db = indexer.indexerDb.apiView();
    let latest = await db.getLatestBlockIndex();
    let pushGeneration = await db.getPushGeneration(indexer.config['COIN']);
    let blockTime = await tipBlockTime(db, latest);
    let offers = await db.getOpenCrossChainOffers(max, after_action_index, to_coin, blockTime);
    await applyEffectiveOfferLists(indexer, db, offers, latest);
    warnIfTruncated(offers, max, latest);
    for(let offer of offers) offer.push_generation = pushGeneration;
    await stampGiveDecimals(db, indexer.util, indexer.config['COIN_DECIMALS'], offers, latest);
    return {
        latest_block_index: latest,
        network:            indexer.config['NETWORK'],
        count:              offers.length,
        truncated:          offers.truncated === true,
        next_cursor:        (offers.next_cursor != null) ? offers.next_cursor : null,
        orders:             offers
    };
}

// Return this chain's OPEN cross-chain DEX offers (give_coin != get_coin) so the
// xchain-hub federation can build the unified cross-chain order book. The "from"
// chain is implicit (this indexer's COIN). Paginates by keyset on action_index.
// Returns the latest block in the same round-trip so the federation can snapshot
// its matching view without a follow-up getlatestblock.
//
// Give-side decimal grid: the hub quantizes each cross-chain
// fill on the grid of the leg that gives it, and declines the match outright
// rather than guessing when it is absent. Resolution lives in
// cross_chain_offer_decimals.js (it delegates to the same getTokenInfo
// order_match.js uses, so the two grids cannot drift).
function openCrossChainOrdersRpc({ indexer }){
    return {
        async getopencrosschainorders({to_coin, limit, after_action_index}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            try {
                return await readOpenCrossChainOrders(indexer, {to_coin, limit, after_action_index});
            } catch (err) {
                getLogger().error('getopencrosschainorders error:', err);
                return { error: 'failed to look up cross-chain orders' };
            }
        },
    };
}

module.exports = { buildOrdersRpc: openCrossChainOrdersRpc };
