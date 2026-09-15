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
 * XChain Indexer - Rollback: orphan sweeps and mirror deletes
 *
 * The sweeps that remove derived rows the index-id delete left dangling, the
 * pair-scoped market delete, and the local deletes of the hub-mirrored price and
 * cross-chain rows. Installed onto Rollback.prototype by ./index.js; the statements
 * are in src/db/rollback/sweeps.js.
 *
 ********************************************************************/

'use strict';

// For the market-pair sentinel only. db.js requires nothing from here, so this is
// a one-way edge; the pair key has to be the same one Database.getMarkets builds or
// the two collectors disagree about which markets a reorg must recompute.
const Database  = require('../db');
const sweepSql  = require('../db/rollback/sweeps.js');

module.exports = {

    // Sweep balances rows orphaned by the index-table delete above. `balances` is a
    // derived table keyed by (address_id, tick_id); it is NOT in dataTables (not
    // deleted by action_index) and is normally reconciled by updateAddressBalance.
    // But when an address (or tick) is seen ONLY in the orphaned range, its
    // index_addresses/index_tickers row was just deleted, so the refresh below
    // resolves the string to NULL (suppressIndexIdCreation) and updateAddressBalance
    // can no longer locate the stale row by its now-deleted id. That leaves a zombie
    // balance whose id matches no index row, which inflates sum(balances) and trips
    // sanityCheck on the next block touching the tick (indexer halts). A
    // from-genesis replay never created that row, so deleting every balance whose
    // address_id/tick_id no longer resolves makes the reorged node match a fresh
    // one. (Pre-suppressIndexIdCreation this was masked: createAddress resurrected the
    // id and updateAddressBalance recomputed the row to 0 and removed it, at the cost
    // of the ^<id> fork the index delete exists to close. The id PKs are NOT NULL, so
    // the NOT IN subqueries never short-circuit on a NULL.) Mirrors the icons orphan
    // sweep above.
    async sweepDanglingIndexReferences(){
        await sweepSql.sweepDanglingIndexReferences(this.indexerDb, Database.MARKET_NATIVE_TICK_ID);
    },

    // IDX-2: the dangling-tick sweep above misses a market whose pair was FIRST traded only in
    // the orphaned range but whose ticks survive (both were issued in earlier surviving
    // blocks). createMarket inserts the markets row on the first order for a pair; if that
    // order (and every other order/match for the pair) is in the orphaned range, the generic
    // dataTables delete removes the orders but updateMarkets only refreshes stats, never
    // deletes, so a zeroed-stats row lingers that a from-genesis replay never created. Scoped
    // to the pairs this rollback collected (`markets`), each is dropped only if NO surviving
    // orders/order_matches row references it in either orientation. markets is unhashed and
    // snapshot-replicated (no consensus reader), so this is a fresh-replay parity fix.
    // COALESCE on the probes: the pair ids come from `markets`, where a tickerless
    // side is 0, while orders/order_matches store NULL for it. Comparing the two
    // directly found no survivor for any token/native pair, so the delete below
    // dropped live markets on every reorg that touched one.
    async sweepOrphanedMarketPairs(markets){
        await sweepSql.sweepOrphanedMarketPairs(this.indexerDb, markets);
    },

    // Delete consensus price snapshots anchored to the orphaned blocks.
    // price_snapshots anchors each round to a block via reference_block
    // (its equivalent of block_index) rather than block_index itself, so
    // it falls outside the generic blockTables loop above and needs its
    // own delete. Without it, snapshots tied to orphaned blocks survive
    // with status='finalized' and a from-genesis replay on the new chain
    // never regenerates those rounds, leaving replaying nodes permanently
    // divergent from surviving nodes on this table.
    //
    // Note: other hub-mirrored block-anchored tables (state_checkpoints,
    // capability_snapshots) are intentionally NOT deleted here. Both are
    // append-only with supersede-by-seq / MAX-per-height read semantics,
    // so a stale row is harmless once the hub pushes a higher-seq
    // replacement; convergence is hub-driven for those tables. The
    // price_snapshots delete exists because a from-genesis replay never
    // regenerates orphaned rounds, so hub re-mirror alone cannot close
    // the divergence window on this table.
    // PRICE-SNAP-1: reference_block is ALWAYS a BTC anchor height (the PRICE v0 wire field),
    // regardless of the publishing chain, and reference_chain records that publisher. The old
    // unqualified `reference_block >= block_index` therefore (a) is a numeric no-op on a
    // DOGE/LTC indexer (local heights dwarf BTC anchors) and (b) would, once the price
    // capability is resolvable off-BTC, let a BTC reorg delete a DOGE/LTC-published round
    // anchored to a BTC height that the hub (source_chain-scoped) still keeps - a mirror-hole
    // fork on a table that feeds getOracleDataForVM. Scope the delete to BTC-published rounds
    // on the BTC indexer only; off-BTC rounds converge via the hub's source_chain retraction,
    // exactly as the note above describes. Behavior-preserving today (all v0 rounds are BTC).
    async purgeOrphanedPriceSnapshots(block_index){
        if(this.config['COIN'] === 'BTC'){
            await sweepSql.purgeOrphanedPriceSnapshots(this.indexerDb, block_index);
        }
    },

    // oracle_prices is the per-action local mirror of PRICE v1 rows
    // (populated by hub_db_sync). Like price_snapshots, its rows are
    // tagged by source_chain + action_index and are NOT regenerated by a
    // from-genesis replay on the new chain. The async hub retraction
    // (retractPriceRange below) handles convergence eventually, but a
    // reorg concurrent with a hub blip leaves stale rows serving until
    // the hub reconnects. Deleting them here closes that window; the
    // later hub-driven delete is a harmless no-op. The delete MUST be
    // qualified by source_chain (COIN) because oracle_prices holds rows
    // from ALL chains and action_index is only unique within a chain.
    async purgeOrphanedOraclePrices(firstActionIndex){
        await sweepSql.purgeOrphanedOraclePrices(this.indexerDb, this.config, firstActionIndex);
    },

    // cross_chain_calls / cross_chain_matches are the per-action local mirrors
    // of hub-relayed XCALL + cross-chain DEX rows (populated by hub_db_sync).
    // Like oracle_prices above, they are tagged by source chain + a per-chain
    // action_index and are NOT regenerated by a from-genesis replay on the new
    // chain. The async hub retractions (retractXcallRange / retractMatchRange
    // below) converge eventually, but a reorg concurrent with a hub blip would
    // leave stale 'finalized' calls / matches serving until the hub reconnects;
    // deleting them here closes that window and the later hub-driven row:deleted
    // is a harmless no-op. cross_chain_matches is two-sided: a match drops when
    // EITHER leg on this chain was rolled back. Predicates are byte-identical to
    // client/rollback.js (drift-guarded by the markers below), and deliberately NOT
    // to hub_db_sync.js _applyRetraction: that path additionally carries the bounded
    // to_action_index clause and the item-5308 push_generation fence, and for these
    // two quorum-class tables the fence is MANDATORY (an unfenced retraction is
    // refused outright), so its emitted SQL is always stricter than this one.
    // The asymmetry is the point. This delete is our own authoritative rollback of
    // our own chain, so it is unbounded from the orphan point up; the hub-driven
    // delete acts on untrusted input and must be fenced to a generation we produced.
    // Do not "reconcile" the two by adding a fence here or dropping one there.
    async purgeCrossChainMirrors(firstActionIndex){
        await sweepSql.purgeCrossChainMirrors(this.indexerDb, this.config, firstActionIndex);
    },

};
