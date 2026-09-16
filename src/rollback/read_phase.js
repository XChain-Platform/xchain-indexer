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
 * XChain Indexer - Rollback: read phase
 *
 * What the rollback reads BEFORE its transaction opens: the rolled-back action range,
 * the ATTEST batches the reorg un-lands, and the addresses, tickers and market pairs the
 * orphaned range touched. Installed onto Rollback.prototype by ./index.js; the
 * statements are in src/db/rollback/read_phase.js.
 *
 ********************************************************************/

'use strict';

// For the market-pair sentinel only. db.js requires nothing from here, so this is
// a one-way edge; the pair key has to be the same one Database.getMarkets builds or
// the two collectors disagree about which markets a reorg must recompute.
const Database  = require('../db');
const readSql   = require('../db/rollback/read_phase.js');

module.exports = {

    // The rolled-back action range and the ATTEST batches the reorg un-lands, all read
    // BEFORE the transaction opens: the rows that answer them are deleted by the purge
    // inside it, and the hub retraction has to name a batch that is gone locally by then.
    async readRollbackScope(block_index){
        // Placeholder for the first action_index. Initialized to null (not a
        // falsy number) so the guards below distinguish "no actions in range"
        // from a legitimate action_index of 0 (Number(0) is falsy), so a false
        // sentinel would silently skip all rollback processing and the hub
        // price retraction whenever the lowest rolled-back action is index 0.
        let firstActionIndex = null;

        // Highest rolled-back action_index, bounding a DEFERRED hub retraction to a CLOSED
        // range [first, last]. Captured here, before the dataTables DELETE below removes the
        // orphaned `actions` rows, so the MAX reflects the full rolled-back range. The live
        // (immediate) retraction stays open-ended; only a queued/replayed retraction needs the
        // ceiling, so that a re-published row at A' (>= first) landing before the deferred drain
        // is not wiped by an open-ended DELETE (items 5296/5297).
        let lastActionIndex = null;
        let rows = await readSql.readFirstActionRows(this.indexerView, block_index);
        if(rows.length > 0)
            firstActionIndex = Number(rows[0].action_index);

        // Capture the upper bound of the rolled-back action range (still in the DB at this point).
        let maxRows = await readSql.readLastActionRows(this.indexerView, block_index);
        if(maxRows.length > 0 && maxRows[0].last_action_index !== null)
            lastActionIndex = Number(maxRows[0].last_action_index);

        // The ATTEST batches this reorg un-lands (spec §6.3, frontier row 55). Read HERE,
        // in the read phase, because the `attests` rows that identify them are deleted by
        // the dataTables purge below, and the hub retraction has to name a batch that no
        // longer exists locally by the time it is sent.
        let unlandedAttestBatches = [];
        if(firstActionIndex !== null && this.hubClient && this.hubClient.enabled)
            unlandedAttestBatches = await this.collectUnlandedAttestBatches(firstActionIndex);
        return { firstActionIndex, lastActionIndex, unlandedAttestBatches };
    },

    // The addresses, tickers and DEX market pairs the orphaned range touched, read into
    // the util lists (and the returned pair array) before any delete removes the rows
    // that name them, so the post-delete balance/supply/market recompute can find them.
    // The addresses/tickers lists are captured here, in this method's own tail, rather
    // than left for the caller to read after awaiting this call: this.util's lists are
    // shared with the fee-quote dry-run path (processAction -> resetLists), so a caller-side
    // read separated from the last row-absorb by even one await could observe a list the
    // dry-run reset or refilled in between. Capturing before return keeps zero yield points
    // between the last absorb and the read, matching this method's pre-split shape.
    async collectAffectedEntities(firstActionIndex){
        let query, args;
        // Placeholder for market pairs
        let markets = [];
        // Orientation-free keys of the pairs already collected in `markets`. Rescanning the whole
        // array per row, without breaking on a hit, costs O(rows x pairs) inside the reorg stall
        // window where every block is deferred, so the dedupe below reads this set instead. The
        // key is min:max over the two tick ids, which is exactly the either-orientation match a
        // scan gives; pairs are still pushed in the orientation they were first seen, so the
        // contents and order of `markets` are unchanged. Deliberately spans the whole per-table
        // read loop, matching the array it shadows (dedupe is across tables, not per table).
        let marketKeys = new Set();
        // Handle looking up data for any action_indexes in the rollback
        if(firstActionIndex !== null){

            // Loop through the data tables and build out list of addresses and tickers
            for(let table of this.dataTables){

                // Build out the correct SQL to pull address and ticker data from the various tables
                query = this.entityQueryForTable(table);
                args  = [firstActionIndex];

                // Run the query and populate the addresses, tickers, and markets arrays.
                // doQueryStrict (not doQuery): still pre-transaction; a swallowed fault here would
                // silently empty the address/ticker/market recompute sets, so updateBalances/
                // updateTokens/updateMarkets below skip rows they must fix - a stale-balance/supply
                // divergence. Fail loud so the reorg is retried cleanly instead.
                if(query){
                    let rows = await this.indexerView.doQueryStrict(query, args);
                    for(let row of rows){
                        this.absorbEntityRow(row, markets, marketKeys);
                    }
                }
            }
        }

        // Capture in the same synchronous tail as the loop above, with no await between the
        // last absorb and this read (see the method comment above).
        let addresses = this.util.getAddressesList();
        let tickers   = this.util.getTickersList();
        return { markets, addresses, tickers };
    },

    // The read-phase query for one rolled-back table, or false when the table names no
    // address, ticker or market pair. Grouped by the join each family needs, which is
    // the only thing that differs between them.
    entityQueryForTable(table){
        return readSql.entityQueryForLedgerTables(table)
            || readSql.entityQueryForTransferTables(table)
            || readSql.entityQueryForDexTables(table)
            || readSql.entityQueryForCoinpayTables(table);
    },

    // Fold one read-phase row into the recompute sets: its addresses and tickers into
    // the util lists, its market pair into `markets` (deduped by marketKeys).
    absorbEntityRow(row, markets, marketKeys){
        // Populate addresses and tickers arrays
        if(!this.util.isNull(row.address))
            this.util.addAddressTicker(row.address, row.tick);
        if(!this.util.isNull(row.address2))
            this.util.addAddressTicker(row.address2, row.tick);
        if(!this.util.isNull(row.address3))
            this.util.addAddressTicker(row.address3, row.tick);
        // Build out list of DEX market pairs. A tickerless (native-coin) side
        // reads as 0, the sentinel `markets` keys it under, so this collector
        // keeps exactly the pairs the block path collects (Database.getMarkets).
        // Dropping those rows instead left every token/native market out of the
        // post-reorg recompute, so its stats stayed at whatever the orphaned
        // range last wrote.
        if(!this.util.isNull(row.tick1_id) || !this.util.isNull(row.tick2_id)){
            let tick1_id = Database.marketTickId(row.tick1_id);
            let tick2_id = Database.marketTickId(row.tick2_id);
            let coin1_id = Number(row.coin1_id) || 0;
            let coin2_id = Number(row.coin2_id) || 0;
            let key      = Math.min(tick1_id, tick2_id) + ':' + Math.max(tick1_id, tick2_id);
            if(!marketKeys.has(key)){
                marketKeys.add(key);
                markets.push({ tick1_id, tick2_id, coin1_id, coin2_id });
            }
        }
    },

    // The ATTEST v5/v6 batches whose chain wire this reorg orphans (spec §6.3, row 55).
    //
    // A batch is un-landed when ANY of its wires is orphaned, not only its head. The
    // delivery fires on the action that COMPLETES the batch's chunk coverage (row 52), so
    // a reorg that takes one continuation leaves a head standing whose batch no longer
    // exists on the surviving chain, and the hub is still serving the link that delivery
    // stamped. Joining every rolled-back chunk row back to its head is what catches that
    // case; scoping the join to the head's own key is what makes the result the identity
    // the retraction has to carry (the key, its signed window and the HEAD's action index,
    // which is the value the hub stamped).
    //
    // Only VALID heads: a batch whose reassembly or quorum failed was stamped invalid on
    // its head and never pushed, so there is no link to retract. A head that is valid but
    // never completed its coverage is harmless the other way: the retraction matches no
    // link on the hub and is answered as an accepted no-op.
    //
    // The CHUNK side carries the same two predicates, because collection has to describe
    // the same chunk set forward assembly accepted (db.getAttestBatchChunks) and nothing
    // less. A batch key is sha256 over the window its head declares, so anyone can derive
    // it and file rows under it: A BATCH'S IDENTITY IS (KEY, AUTHOR), NEVER THE KEY ALONE
    // (actions/attest.js authoredBy). Joining on the key alone let a row that is no part
    // of the batch un-land it - a rejected duplicate, or a foreign publisher's chunk, sitting
    // anywhere in the orphaned range pulled in a SURVIVING head and queued a retraction that
    // cleared a live batch's hub links. The hub cannot catch that: the retraction names a
    // genuinely valid window, and the link is set-once, so nothing ever restores it.
    //
    // The author joins are INNER on purpose, mirroring authoredBy's fail-closed rule that an
    // unresolvable broadcaster scopes to NOTHING. A publisher whose author cannot be resolved
    // never assembles a batch forward either, so no link was ever stamped and there is nothing
    // to retract.
    //
    // doQueryStrict, like the two reads above it and for the same reason: this runs
    // outside the transaction, where doQuery collapses a transient DB fault into an empty
    // result, which here is indistinguishable from "no batch was un-landed" and would
    // silently skip a retraction the reorg is never retried to re-issue.
    async collectUnlandedAttestBatches(firstActionIndex){
        let rows = await readSql.readUnlandedAttestBatchRows(this.indexerView, firstActionIndex);
        return (rows || []).map(r => ({
            batch_key:    String(r.batch_key),
            action_index: Number(r.action_index),
            window_start: Number(r.window_start),
            window_end:   Number(r.window_end)
        }));
    },

};
