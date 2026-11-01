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
const rpcParams = require('./params.js');

function buildBetsRpc(ctx){
    return Object.assign({}, betFeedsRpc(ctx), betsRpc(ctx));
}

function betFeedsRpc({ indexer }){
    return {
        // BET parimutuel betting reads (raw reads for ops
        // tooling and e2e; the PUBLIC surface is the explorer REST layer). Paged
        // listing of betting feeds with effective list references.
        // Body: { status?, source?, tick?, limit?, after_action_index? }
        async getbetfeeds({status, source, tick, limit, after_action_index}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            // Bound paging and the optional scalar filters before building the listing query.
            let page = rpcParams.limit(limit, { defaultValue: 100, max: 500 });
            if(page.error) return { error: page.error };
            let cursor = rpcParams.optionalInteger(after_action_index, { name: 'after_action_index', min: 0 });
            if(cursor.error) return { error: cursor.error };
            let statusParam = rpcParams.string(status, { name: 'status', maxLength: 64 });
            let sourceParam = rpcParams.string(source, { name: 'source', maxLength: 255 });
            let tickParam = rpcParams.string(tick, { name: 'tick', maxLength: 255 });
            if(statusParam.error || sourceParam.error || tickParam.error)
                return { error: statusParam.error || sourceParam.error || tickParam.error };
            let max = page.value;
            // Committed-only read off an independent pooled connection
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                let rows   = await db.getBetFeedRows({
                    status: statusParam.value, source: sourceParam.value, tick: tickParam.value,
                    limit: max, after_action_index: cursor.value
                });
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

        // One betting feed, including its effective list references, + its
        // per-outcome open pools.
        // Body: { action_index }
        async getbetfeed({action_index}){
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            // Require an exact positive feed action row index.
            let parsed = rpcParams.integer(action_index, { name: 'action_index', min: 1 });
            if(parsed.error) return { error: parsed.error };
            let db = indexer.indexerDb.apiView();
            try {
                let feed = await db.getBetFeedInfo(parsed.value);
                if(!feed)
                    return { error: 'unknown feed' };
                let pools = await db.getBetFeedPools(parsed.value);
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
            // Bound paging and the optional scalar filters before building the listing query.
            let page = rpcParams.limit(limit, { defaultValue: 100, max: 500 });
            if(page.error) return { error: page.error };
            let feedParam = rpcParams.optionalInteger(feed, { name: 'feed', min: 1 });
            let cursor = rpcParams.optionalInteger(after_action_index, { name: 'after_action_index', min: 0 });
            let sourceParam = rpcParams.string(source, { name: 'source', maxLength: 255 });
            let statusParam = rpcParams.string(status, { name: 'status', maxLength: 64 });
            if(feedParam.error || cursor.error || sourceParam.error || statusParam.error)
                return { error: feedParam.error || cursor.error || sourceParam.error || statusParam.error };
            let max = page.value;
            let db = indexer.indexerDb.apiView();
            try {
                let latest = await db.getLatestBlockIndex();
                let rows   = await db.getBetRows({
                    feed: feedParam.value, source: sourceParam.value, status: statusParam.value,
                    limit: max, after_action_index: cursor.value
                });
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
