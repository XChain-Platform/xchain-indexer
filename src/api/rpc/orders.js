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
            let max = Number(limit);
            if(!Number.isFinite(max) || max <= 0) max = 100;
            if(max > 500) max = 500;
            // Federation READ isolation: committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                // Source-chain reorg fence: stamp each offer with this chain's current
                // push generation. The hub copies it onto the matched leg's a_/b_push_generation so a
                // deferred retraction fences by generation and a re-published order at a recycled
                // action_index (higher generation) survives. Per-COIN, so one read covers the book.
                //
                // Read the generation BEFORE the rows: a concurrent rollback bumps the
                // generation atomically with deleting the orphaned rows (rollback.js, in-transaction).
                // Reading the generation first guarantees safety wherever that commit lands - gen G
                // then rows are pre-commit orphans (stamped G, which the fence <= G covers) or already
                // gone; gen G+1 means the commit happened, so the orphaned rows are already gone. The
                // reverse order (rows then generation) could read orphaned rows pre-commit and stamp
                // them with the post-commit G+1, letting them escape the fence permanently.
                let pushGeneration = await db.getPushGeneration(indexer.config['COIN']);
                // Effective expiration filter: drop offers already past their (edit-
                // overlaid) expiration relative to the tip's block_time, so a stale 'open' offer
                // awaiting its next block-loop expiry pass cannot occupy a bounded slot. A missing
                // block_time (older-schema gap) yields a non-finite value → the filter is skipped
                // (fail open, unchanged behavior) rather than dropping the whole book.
                let blockTime = await tipBlockTime(db, latest);
                // Unified cross-chain book: SWAP (exact single-fill) + ORDER
                // (price-time partial fills) drawn in one UNION ALL so a single global
                // LIMIT + keyset cursor bounds the whole book. Each offer is tagged `kind`; the
                // returned array carries .truncated + .next_cursor out-of-band.
                let merged = await db.getOpenCrossChainOffers(max, after_action_index, to_coin, blockTime);
                let truncated = merged.truncated === true;
                if(truncated)
                    getLogger().warn('getopencrosschainorders hit the cap of ' + max + ' at block ' + latest + ' - the open cross-chain book is truncated (newer offers dropped); the hub should page via next_cursor or raise its limit.');
                for(let o of merged) o.push_generation = pushGeneration;
                await stampGiveDecimals(db, indexer.util, indexer.config['COIN_DECIMALS'], merged, latest);
                return {
                    latest_block_index: latest,
                    network:            indexer.config['NETWORK'],
                    count:              merged.length,
                    truncated:          truncated,
                    // Keyset cursor for the hub's page loop: feed back as after_action_index.
                    next_cursor:        (merged.next_cursor != null) ? merged.next_cursor : null,
                    orders:             merged
                };
            } catch (err) {
                getLogger().error('getopencrosschainorders error:', err);
                return { error: 'failed to look up cross-chain orders' };
            }
        },
    };
}

module.exports = { buildOrdersRpc: openCrossChainOrdersRpc };
