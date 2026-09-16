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
 * XChain Indexer - Database mixin part: tokens / sanity_check
 *
 * The per-block supply check: every tick a block touched must carry the same
 * supply in tokens, in the credit/debit/escrow ledger, and in balances plus escrows.
 * Merged into the tokens mixin by db/tokens/index.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const ledgerPrecision = require('../../consensus/ledger_amount_precision_gate');

const { getLogger } = require('../../observability/index.js');

module.exports = {

    // Validate that token supplys match credits/debits/balances information
    async sanityCheck(block_index){
        // Ignore any calls without a block index
        if(this.util.isNull(block_index))
            return;
        let tickers  = {};
        let decimals = {};
        await supplyCheck.touchedTicks(this, block_index, tickers, decimals);
        // Batch the four per-tick aggregates into GROUP BY queries over the block's
        // touched-tick set, reusing the tick_id/decimals already selected above (#1842).
        // The former per-tick loop issued getTokenSupply/Token/Balance/Escrow serially,
        // each re-running createTicker + getTokenDecimalPrecision and (getTokenSupply with
        // no block scope) three FULL-HISTORY SUM scans, so cost grew ~14 round-trips per
        // touched tick per block and tracked ledger history. This collapses to a handful
        // of queries per block regardless of tick count. Semantics are preserved exactly:
        // the same DECIMAL(60,d) CAST (grouped by d so the scale stays per-tick-correct),
        // the same action-scoped ledger sums vs unjoined balances/escrow-total sums, the
        // same three-way compare and SanityError messages.
        let tickList = Object.keys(tickers);
        if(tickList.length === 0)
            return;
        // tick_id -> tick name, and the flat id list.
        let idToTick = {};
        let allIds   = [];
        for(let tick of tickList){
            let id = tickers[tick];
            idToTick[id] = tick;
            allIds.push(id);
        }
        // Ledger components (action-scoped) and total components (unjoined).
        let creditsById       = await supplyCheck.sumByTick(this, allIds, 'credits', true);
        let debitsById        = await supplyCheck.sumByTick(this, allIds, 'debits',  true);
        let escrowsLedgerById = await supplyCheck.sumByTick(this, allIds, 'escrows', true);
        let balancesById      = await supplyCheck.sumByTick(this, allIds, 'balances', false);
        let escrowsTotalById  = await supplyCheck.sumByTick(this, allIds, 'escrows',  false);
        // tokens.supply per touched tick (raw string, no CAST - matches getTokenSupplyToken).
        let tokenById = await supplyCheck.tokenSupplies(this, allIds);
        // Loop through the tickers and validate token supply match credits/debits/balances info
        let sums = { creditsById, debitsById, escrowsLedgerById, balancesById, escrowsTotalById, tokenById };
        for(let tick in tickers)
            supplyCheck.compareTick(this, tick, tickers[tick], decimals, sums);
    },

};

// The steps of sanityCheck, kept off the exported object so Database.prototype gains no
// method. Each takes the Database instance as `db`; they run in the order sanityCheck
// calls them, so the statements reach doQuery in the same sequence as one inline body.
const supplyCheck = {

    // Fill `tickers` (tick -> tick_id) and `decimals` (tick -> decimals) with every tick the
    // block's credits, debits and escrows touched.
    async touchedTicks(db, block_index, tickers, decimals){
        // Get list of tickers and supply from credits/debits/escrows/tokens tables using block_index
        let query   = `SELECT
                        DISTINCT(x.tick_id),
                        t2.tick,
                        t1.decimals
                    FROM
                        (
                            -- Scope the touched-tick set by the ACTION's own block_index, NOT by
                            -- joining transactions on tx_index: a block whose only ledger effect is
                            -- a synthetic action (e.g. an UNSTAKE v2 cooldown completion, tx_index
                            -- NULL) would otherwise contribute no tick and skip the sanity check for
                            -- it, hiding the imbalance until a later real-tx block for that tick.
                            SELECT
                                c.tick_id
                            FROM
                                credits c
                                INNER JOIN actions a ON (c.action_index=a.action_index)
                            WHERE
                                a.block_index=?
                            UNION
                            SELECT
                                d.tick_id
                            FROM
                                debits d
                                INNER JOIN actions a ON (d.action_index=a.action_index)
                            WHERE
                                a.block_index=?
                            UNION
                            SELECT
                                e.tick_id
                            FROM
                                escrows e
                                INNER JOIN actions a ON (e.action_index=a.action_index)
                            WHERE
                                a.block_index=?
                        ) as x
                        INNER JOIN tokens        t1 ON (t1.tick_id=x.tick_id)
                        INNER JOIN index_tickers t2 ON (t2.id=x.tick_id)
                    ORDER BY 
                        t2.tick ASC`;
        let results = await db.doQuery(query, [block_index, block_index, block_index]);
        if(results.length >0){
            for(let row of results){
                // Add ticker, decimal, and supply info to assoc arrays
                tickers[row.tick]  = Number(row.tick_id);
                decimals[row.tick] = row.decimals;
            };
        }
    },

    // Run ONE GROUP BY SUM over the touched-tick set per table. joinActions mirrors
    // getTokenSupply's `INNER JOIN actions` for the ledger credit/debit/escrow sums;
    // the balances and escrow-TOTAL sums are unjoined, exactly like
    // getTokenSupplyBalance/getTokenSupplyEscrow. Returns tick_id -> summed string.
    //
    // Summed at the EXACT ledger scale (18 dp), not per-tick DECIMAL(60,d), so
    // the per-decimal query grouping is gone with it. The three
    // projections compared below each round ONCE, at the tick's own scale: the
    // ledger side rounds when escrows are folded in, the total side when
    // balances and escrows are added. That is the only shape that agrees when
    // the ledger carries amounts finer than the tick (fees at 8 dp against a
    // 0-decimal gas tick), because round(C) - round(D) + round(E) is not
    // round(C - D + E). Pre-flag-day rows sit on the tick's own grid, so both
    // shapes give the same number for them.
    async sumByTick(db, allIds, table, joinActions){
        let out          = {};
        let placeholders = allIds.map(() => '?').join(', ');
        let from         = joinActions
            ? table + ' m INNER JOIN actions a ON (a.action_index=m.action_index)'
            : table + ' m';
        let q = 'SELECT m.tick_id AS tick_id, ' + ledgerPrecision.exactSumSql('m.amount') + ' AS s'
              + ' FROM ' + from + ' WHERE m.tick_id IN (' + placeholders + ') GROUP BY m.tick_id';
        let rows = await db.doQuery(q, allIds);
        for(let row of rows){
            if(!db.util.isNull(row.s)) out[Number(row.tick_id)] = row.s;
        }
        return out;
    },

    // tokens.supply per touched tick, tick_id -> raw supply string.
    async tokenSupplies(db, allIds){
        let tokenById = {};
        let placeholders = allIds.map(() => '?').join(', ');
        let rows = await db.doQuery(
            'SELECT tick_id, supply FROM tokens WHERE tick_id IN (' + placeholders + ')', allIds);
        for(let row of rows){
            if(!db.util.isNull(row.supply)) tokenById[Number(row.tick_id)] = row.supply;
        }
        return tokenById;
    },

    // Compare one tick's three supply projections, logging all of them on any mismatch and
    // throwing the SanityError for the first projection that disagrees with tokens.supply.
    compareTick(db, tick, tick_id, decimals, sums){
        let { creditsById, debitsById, escrowsLedgerById, balancesById, escrowsTotalById, tokenById } = sums;
        let d       = decimals[tick];
        let credits = (creditsById[tick_id]       != null) ? creditsById[tick_id]       : 0;
        let debitsV = (debitsById[tick_id]        != null) ? debitsById[tick_id]        : 0;
        let escLdg  = (escrowsLedgerById[tick_id] != null) ? escrowsLedgerById[tick_id] : 0;
        // Ledger (credits - debits + escrows), identical to getTokenSupply's final
        // bcadd/bcsub: net at the exact scale, round ONCE at the tick's decimals.
        let ledger  = db.util.bcnum(db.util.bcadd(
            db.util.bcsub(credits, debitsV, ledgerPrecision.LEDGER_AMOUNT_PRECISION), escLdg, d));
        let token   = db.util.bcnum((tokenById[tick_id]        != null) ? tokenById[tick_id]        : 0); // Supply from tokens
        let balance = db.util.bcnum((balancesById[tick_id]     != null) ? balancesById[tick_id]     : 0); // Supply from balances
        let escrow  = db.util.bcnum((escrowsTotalById[tick_id] != null) ? escrowsTotalById[tick_id] : 0); // Supply from escrows
        let total   = db.util.bcadd(balance, escrow, decimals[tick]);        // Total (balances + escrows)
        if(String(token)!=String(ledger) || String(token)!=String(total)){
            getLogger().info("Tick,   tick_id =", tick, tick_id);
            getLogger().info("token   supply =", token);
            getLogger().info("ledger  supply =", ledger);  // Credits / Debits / Escrows
            getLogger().info("balance supply =", balance); // balances table
            getLogger().info("escrow  supply =", escrow);  // Escrows
            getLogger().info("total   supply =", total);   // balance + escrow
        }
        if(String(token)!=String(ledger))
            db.util.throwError("SanityError: ledger supply does not match token supply : " + tick + " (" + ledger + " != " + token + ")");
        if(String(token)!=String(total))
            db.util.throwError("SanityError: total supply does not match token supply : " + tick + " (" + total + " != " + token + ")");
    },

};
