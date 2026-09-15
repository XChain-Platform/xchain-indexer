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
 * XChain Indexer - JSON-RPC betting family: raw BET feed and bet reads for ops tooling and e2e.
 *
 * Each group factory below closes over the context object src/api.js builds
 * (apiContext) and returns its methods verbatim; src/api/rpc/index.js merges
 * every family into the one controller the JSON-RPC router dispatches on.
 *
 ********************************************************************/

const { getLogger } = require('../../observability/index.js');

function buildBetsRpc(ctx){
    return Object.assign({}, betFeedsRpc(ctx), betsRpc(ctx));
}

function betFeedsRpc({ indexer }){
    return {
        // BET parimutuel betting reads (raw reads for ops
        // tooling and e2e; the PUBLIC surface is the explorer REST layer). Paged
        // listing of betting feeds.
        // Body: { status?, source?, tick?, limit?, after_action_index? }
        async getbetfeeds({status, source, tick, limit, after_action_index}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let max = Number(limit);
            if(!Number.isFinite(max) || max <= 0) max = 100;
            if(max > 500) max = 500;
            // Committed-only read off an independent pooled connection
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                let rows   = await db.getBetFeedRows({ status, source, tick, limit: max, after_action_index });
                return {
                    latest_block_index: latest,
                    network:            indexer.config['NETWORK'],
                    count:              rows.length,
                    next_cursor:        (rows.length === max) ? rows[rows.length - 1].action_index : null,
                    feeds:              rows
                };
            } catch (err) {
                getLogger().error('getbetfeeds error:', err);
                return { error: 'failed to look up bet feeds' };
            }
        },

        // One betting feed + its per-outcome open pools.
        // Body: { action_index }
        async getbetfeed({action_index}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            if(!Number.isFinite(Number(action_index)))
                return { error: 'action_index must be numeric' };
            let db = indexer.indexerDb.apiView();
            try {
                let feed = await db.getBetFeedInfo(Number(action_index));
                if(!feed)
                    return { error: 'unknown feed' };
                let pools = await db.getBetFeedPools(Number(action_index));
                return {
                    network: indexer.config['NETWORK'],
                    feed:    feed,
                    pools:   pools
                };
            } catch (err) {
                getLogger().error('getbetfeed error:', err);
                return { error: 'failed to look up bet feed' };
            }
        },
    };
}

// Paged listing of bets.
// Body: { feed?, source?, status?, limit?, after_action_index? }
function betsRpc({ indexer }){
    return {
        async getbets({feed, source, status, limit, after_action_index}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            let max = Number(limit);
            if(!Number.isFinite(max) || max <= 0) max = 100;
            if(max > 500) max = 500;
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                let rows   = await db.getBetRows({ feed, source, status, limit: max, after_action_index });
                return {
                    latest_block_index: latest,
                    network:            indexer.config['NETWORK'],
                    count:              rows.length,
                    next_cursor:        (rows.length === max) ? rows[rows.length - 1].action_index : null,
                    bets:               rows
                };
            } catch (err) {
                getLogger().error('getbets error:', err);
                return { error: 'failed to look up bets' };
            }
        },
    };
}

module.exports = { buildBetsRpc };
