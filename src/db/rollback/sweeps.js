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
 * XChain Indexer - Database statements: rollback orphan sweeps and mirror deletes
 *
 * The dangling-reference sweeps, the pair-scoped market probes and delete, and the
 * local deletes of hub-mirrored rows, each one the body of the src/rollback/sweeps.js
 * method of the same name, plus timedSweep, which the orphan sweeps here and the icon
 * sweep in ./rederive.js run through. The marked cross-chain block is compared statement
 * for statement with the replica by the cross-repo drift guards.
 *
 ********************************************************************/

'use strict';

// Run one sweep DELETE and report { table, ms, rows } for the rollback summary.
async function timedSweep(db, table, query, args){
    let startedAt = Date.now();
    let res = await db.doQuery(query, args);
    let rows = (res && res.affectedRows != null) ? Number(res.affectedRows) : null;
    return { table: table, ms: Date.now() - startedAt, rows: rows };
}

module.exports = {

    timedSweep,

    // balances, markets and pubkeys rows whose index id no longer resolves, timed per table.
    async sweepDanglingIndexReferences(db, nativeTickId){
        let stats = [];
        stats.push(await timedSweep(db, 'balances',
            `DELETE FROM balances
             WHERE address_id NOT IN (SELECT id FROM index_addresses)
                OR tick_id    NOT IN (SELECT id FROM index_tickers)`, []));

        // Same orphan-sweep for the other two derived tables that reference a rolled-back
        // index id but are NOT removed by the action_index / block_index delete loops
        // (an audit of every table referencing index_addresses/index_tickers found exactly
        // these plus balances and the icons sweep above):
        //
        //  - markets (tick1_id, tick2_id): updateMarkets only UPDATEs existing rows, never
        //    deletes, so a pair whose tick is orphaned-only keeps a row with a dangling
        //    tick id. Worse on id reclaim: getMarketId(tick1, reclaimed_id) then matches the
        //    stale row and the new pair silently inherits the old market's price/volume.
        //  - pubkeys (address_id -> pubkey, INSERT IGNORE): an orphaned-only source address
        //    leaves a dangling row; because the write is INSERT IGNORE, a later address that
        //    reclaims the id keeps the OLD pubkey. Not consensus-hashed (block hashes take
        //    source_pubkey from the decoder DB, not this table), so this is stale-data, not a
        //    fork, but it still mis-attributes a pubkey after id reuse.
        //
        // A from-genesis node never created either row, so deleting any whose id no longer
        // resolves makes the reorged node match it.
        // The 0 sentinel is exempt on both sides: it is not a dangling ticker id, it is
        // a side that has no ticker at all (the native coin, named by coin1_id/coin2_id),
        // and matching it here deleted every token/native market on the first reorg.
        stats.push(await timedSweep(db, 'markets',
            `DELETE FROM markets
             WHERE (tick1_id <> ? AND tick1_id NOT IN (SELECT id FROM index_tickers))
                OR (tick2_id <> ? AND tick2_id NOT IN (SELECT id FROM index_tickers))`,
            [nativeTickId, nativeTickId]));
        stats.push(await timedSweep(db, 'pubkeys',
            `DELETE FROM pubkeys
             WHERE address_id NOT IN (SELECT id FROM index_addresses)`, []));
        return stats;
    },

    // Each collected pair with no surviving order or match in either orientation.
    async sweepOrphanedMarketPairs(db, markets){
        for(let pair of markets){
            let survives = await db.doQuery(
                `SELECT 1 FROM orders o
                    WHERE (COALESCE(o.give_tick_id,0)=? AND COALESCE(o.get_tick_id,0)=?)
                       OR (COALESCE(o.give_tick_id,0)=? AND COALESCE(o.get_tick_id,0)=?)
                    LIMIT 1`,
                [pair.tick1_id, pair.tick2_id, pair.tick2_id, pair.tick1_id]);
            if(survives.length === 0){
                survives = await db.doQuery(
                    `SELECT 1 FROM order_matches om
                        WHERE (COALESCE(om.give_tick_id,0)=? AND COALESCE(om.get_tick_id,0)=?)
                           OR (COALESCE(om.give_tick_id,0)=? AND COALESCE(om.get_tick_id,0)=?)
                        LIMIT 1`,
                    [pair.tick1_id, pair.tick2_id, pair.tick2_id, pair.tick1_id]);
            }
            if(survives.length === 0){
                await db.doQuery(
                    `DELETE FROM markets WHERE (tick1_id=? AND tick2_id=?) OR (tick1_id=? AND tick2_id=?)`,
                    [pair.tick1_id, pair.tick2_id, pair.tick2_id, pair.tick1_id]);
            }
        }
    },

    // BTC-published price snapshots anchored at or above the reorg block.
    async purgeOrphanedPriceSnapshots(db, block_index){
        let query, args;
        query = `DELETE FROM price_snapshots WHERE reference_chain = 'BTC' AND reference_block >= ?`;
        args  = [block_index];
        await db.doQuery(query, args);
    },

    // This chain's oracle_prices mirror rows from the first orphaned action.
    async purgeOrphanedOraclePrices(db, config, firstActionIndex){
        let query, args;
        query = `DELETE FROM oracle_prices WHERE source_chain = ? AND action_index >= ?`;
        args  = [config['COIN'], firstActionIndex !== null ? firstActionIndex : Number.MAX_SAFE_INTEGER];
        await db.doQuery(query, args);
    },

    // This chain's cross_chain_calls, cross_chain_matches and bridge_transfers mirror rows.
    async purgeCrossChainMirrors(db, config, firstActionIndex){
        let query, args;
        //<CROSS-CHAIN-MIRROR-REORG-DELETE>
        let crossChainFrom = firstActionIndex !== null ? firstActionIndex : Number.MAX_SAFE_INTEGER;
        query = `DELETE FROM cross_chain_calls WHERE source_chain = ? AND source_action_index >= ?`;
        args  = [config['COIN'], crossChainFrom];
        await db.doQuery(query, args);
        query = `DELETE FROM cross_chain_matches WHERE (a_chain = ? AND a_action_index >= ?) OR (b_chain = ? AND b_action_index >= ?)`;
        args  = [config['COIN'], crossChainFrom, config['COIN'], crossChainFrom];
        await db.doQuery(query, args);
        // bridge_transfers is the same kind of mirror and closes the same window, and it is
        // ONE-SIDED: a transfer is retracted when the single source leg (the XBRIDGE v0 lock
        // or v1 burn named by src_chain/src_action_index) is reorged away, so one column pair
        // names the range. The spelling is src_chain/src_action_index, not the older
        // source_chain/source_action_index, because that is what the DDL carries (direction is
        // derived from src_chain and never stored); hub_db_sync.js _applyRetraction reads the
        // same pair out of RETRACTION_CHAIN_COLUMNS / RETRACTION_COLUMNS, so the two predicates
        // remove exactly the same rows apart from that path's bounded to_action_index clause
        // and its mandatory push_generation fence, which the asymmetry note above explains.
        // An APPLIED bridge leg is not unwound here: its bridge_settlements row is rollback
        // 'action' and drops with the orphaned block, so replay re-applies the transfer.
        query = `DELETE FROM bridge_transfers WHERE src_chain = ? AND src_action_index >= ?`;
        args  = [config['COIN'], crossChainFrom];
        await db.doQuery(query, args);
        //</CROSS-CHAIN-MIRROR-REORG-DELETE>
    },

};
