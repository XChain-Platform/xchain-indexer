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
 * XChain Indexer - Database mixin: tokens
 * 
 * The queries over the tokens table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const path    = require('path');
const ledgerPrecision = require('../ledger_amount_precision_activation');

const { getLogger } = require('../observability/index.js');
module.exports = {

    // Get token supply for a given ticker from tokens table
    async getTokenSupplyToken(tick){
        let supply   = 0;
        let tick_id  = await this.createTicker(tick);
        let decimals = await this.getTokenDecimalPrecision(tick_id);
        let query = `SELECT supply FROM tokens WHERE tick_id=? LIMIT 1`;
        let results = await this.doQuery(query, [tick_id]);
        if(results.length > 0 && !this.util.isNull(results[0].supply))
            supply = results[0].supply;
        return supply;
    },

    // Create/Update record in `tokens` table
    async createToken(data){
        data                   = this.normalizeDataValues(data);
        let supply             = (!this.util.isNull(data['SUPPLY']) &&               this.util.isNumeric(data['SUPPLY'])) ? data['SUPPLY'] : 0;
        let max_supply         = (!this.util.isNull(data['MAX_SUPPLY']) &&           this.util.isNumeric(data['MAX_SUPPLY'])) ? data['MAX_SUPPLY'] : 0;
        let max_mint           = (!this.util.isNull(data['MAX_MINT']) &&             this.util.isNumeric(data['MAX_MINT'])) ? data['MAX_MINT'] : 0;
        let mint_supply        = (!this.util.isNull(data['MINT_SUPPLY']) &&          this.util.isNumeric(data['MINT_SUPPLY'])) ? data['MINT_SUPPLY'] : 0;
        let mint_address_max   = (!this.util.isNull(data['MINT_ADDRESS_MAX']) &&     this.util.isNumeric(data['MINT_ADDRESS_MAX'])) ? data['MINT_ADDRESS_MAX'] : 0;
        let mint_start_block   = (!this.util.isNull(data['MINT_START_BLOCK']) &&     this.util.isNumeric(data['MINT_START_BLOCK'])) ? data['MINT_START_BLOCK'] : 0;
        let mint_stop_block    = (!this.util.isNull(data['MINT_STOP_BLOCK']) &&      this.util.isNumeric(data['MINT_STOP_BLOCK'])) ? data['MINT_STOP_BLOCK'] : 0;
        let callback_amount    = (!this.util.isNull(data['CALLBACK_AMOUNT']) &&      this.util.isNumeric(data['CALLBACK_AMOUNT'])) ? data['CALLBACK_AMOUNT'] : 0;
        let allow_list         = (!this.util.isNull(data['ALLOW_LIST']) &&           this.util.isNumeric(data['ALLOW_LIST'])) ? parseInt(data['ALLOW_LIST']) : null;
        let block_list         = (!this.util.isNull(data['BLOCK_LIST']) &&           this.util.isNumeric(data['BLOCK_LIST'])) ? parseInt(data['BLOCK_LIST']) : null;
        let decimals           = (!this.util.isNull(data['DECIMALS']) &&             this.util.isNumeric(data['DECIMALS'])) ? parseInt(data['DECIMALS']) : 0;
        // Token-bridge opt-in, PARSED state (the issues row above keeps the raw wire text).
        // The '-' sentinel is the wire spelling of "no destination chains" and lands here as
        // NULL, so this column always reads as the effective destination list: empty means
        // not bridgeable, which is what the explorer, the wallet and the hub's poll want.
        // MIN_DEPTH is raise-only, so an absent value is NULL and the federation falls back
        // to the platform confirmation depth. `bridged` is deliberately NOT written here: it
        // is set by the first applied XBRIDGE v3 lock and no ISSUE may set or clear it.
        let bridge_chains      = (!this.util.isNull(data['BRIDGE_CHAINS']) && String(data['BRIDGE_CHAINS']) !== '-') ? String(data['BRIDGE_CHAINS']) : null;
        let min_depth          = (!this.util.isNull(data['MIN_DEPTH']) &&            this.util.isNumeric(data['MIN_DEPTH'])) ? parseInt(data['MIN_DEPTH']) : null;
        let lock_bridge        = (data['LOCK_BRIDGE']==1) ? 1 : 0;
        // Force any amount values to the correct decimal precision
        if(this.util.isNumeric(decimals) && decimals >= this.config.MIN_TOKEN_DECIMALS && decimals <= this.config.MAX_TOKEN_DECIMALS){
            max_supply         = this.util.bcformat(max_supply, decimals);
            max_mint           = this.util.bcformat(max_mint, decimals);
            mint_supply        = this.util.bcformat(mint_supply, decimals);
            mint_address_max   = this.util.bcformat(mint_address_max, decimals);
            // callback_amount    = this.util.bcformat(callback_amount, decimals);
        }
        let description        = data['DESCRIPTION'];
        let action_index       = data['ACTION_INDEX'];
        // Force lock fields to integer values 
        let lock_max_supply    = (data['LOCK_MAX_SUPPLY']==1) ? 1 : 0;
        let lock_mint          = (data['LOCK_MINT']==1) ? 1 : 0;
        // LOCK_MINT_SUPPLY is the seventh token lock and is folded by getTokenInfo() from the
        // issues rows like the other six. It was missing from this derivation (and from the
        // INSERT/UPDATE below), so tokens.lock_mint_supply sat at its column default forever
        // and every read API reported the lock unset even where the chain enforces it (#).
        // Consensus never depended on this column (issue.js re-folds `issues`), but the wallet's
        // mint form and lock matrix read it and would offer a mint/lock the chain then rejects.
        let lock_mint_supply   = (data['LOCK_MINT_SUPPLY']==1) ? 1 : 0;
        let lock_max_mint      = (data['LOCK_MAX_MINT']==1) ? 1 : 0;
        let lock_description   = (data['LOCK_DESCRIPTION']==1) ? 1 : 0;
        let lock_sleep         = (data['LOCK_SLEEP']==1) ? 1 : 0;
        let lock_callback      = (data['LOCK_CALLBACK']==1) ? 1 : 0;
        let callback_block     = (data['CALLBACK_BLOCK']>0) ? data['CALLBACK_BLOCK'] : 0;
        let callback_tick_id   = await this.createTicker(data['CALLBACK_TICK']);
        let tick_id            = await this.createTicker(data['TICK']);
        let owner_id           = await this.createAddress(data['OWNER']);
        // Check if record already exists for this token
        let query  = "SELECT id FROM tokens WHERE tick_id=? LIMIT 1";
        let exists = false;
        let results = await this.doQuery(query, [tick_id]);
        if(results.length > 0)
            exists = true;
        let args = [];
        if(exists){
            // UPDATE record
            query = `UPDATE
                        tokens
                    SET
                        max_supply=?,
                        max_mint=?,
                        decimals=?,
                        description=?,
                        lock_max_supply=?,
                        lock_mint=?,
                        lock_mint_supply=?,
                        lock_max_mint=?,
                        lock_description=?,
                        lock_sleep=?,
                        lock_callback=?,
                        callback_block=?,
                        callback_tick_id=?,
                        callback_amount=?,
                        allow_list=?,
                        block_list=?,
                        mint_address_max=?,
                        mint_start_block=?,
                        mint_stop_block=?,
                        bridge_chains=?,
                        min_depth=?,
                        lock_bridge=?,
                        supply=?,
                        owner_id=?,
                        last_action_index=?
                    WHERE
                        tick_id=?`;
            args = [max_supply, max_mint, decimals, description, lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint,lock_description, lock_sleep, lock_callback, callback_block, callback_tick_id, callback_amount, allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block, bridge_chains, min_depth, lock_bridge, supply, owner_id, action_index, tick_id];
        } else {
            // INSERT record
            query = `INSERT INTO tokens (
                        max_supply, 
                        max_mint, 
                        decimals, 
                        description, 
                        lock_max_supply,
                        lock_mint,
                        lock_mint_supply,
                        lock_max_mint,
                        lock_description,
                        lock_sleep,
                        lock_callback,
                        callback_block,
                        callback_tick_id,
                        callback_amount,
                        allow_list,
                        block_list,
                        mint_address_max,
                        mint_start_block,
                        mint_stop_block,
                        bridge_chains,
                        min_depth,
                        lock_bridge,
                        supply,
                        owner_id,
                        action_index,
                        last_action_index,
                        tick_id
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args    = [max_supply, max_mint, decimals, description, lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint,lock_description, lock_sleep, lock_callback, callback_block, callback_tick_id, callback_amount, allow_list, block_list, mint_address_max, mint_start_block, mint_stop_block, bridge_chains, min_depth, lock_bridge, supply, owner_id, action_index, action_index, tick_id];
        }
        results = await this.doQuery(query, args);

    },

    // Handle updating token information (supply, price, etc)
    // @param {tickers} boolean Full update
    // @param {tickers} string  Ticker 
    // @param {tickers} array   Array of Tickers
    async updateTokens(tickers, rollback){
        let tokens = [];
        let type   = typeof tickers;
        if(type==='object'){
            for(let tick of tickers){
                if(!this.util.isNull(tick))
                    tokens.push(tick);
            }
        }
        if(type==='string')
            tokens.push(tickers);
        // Dump full list of tokens
        if(type==='boolean' && tickers===true){
            getLogger().info('Updating all tokens...');
            let query = "SELECT t2.tick FROM tokens t1, index_tickers t2 WHERE t1.tick_id=t2.id";
            let results = await this.doQuery(query);
            if(results.length > 0)
                for(let row of results)
                    tokens.push(row.tick);
        }
        // Loop through tokens and update basic info
        await Promise.all(tokens.map(t => this.updateTokenInfo(t)));
    },

    // Mark a token's ownership as held in escrow by an ORDER/SWAP/DISPENSER action.
    // While set, owner-only actions targeting this tick are rejected; on cancel/expire/match
    // the corresponding action handler calls clearTokenEscrow() to release.
    async setTokenEscrow(tick, action_index){
        let tick_id = await this.createTicker(tick);
        let query   = "UPDATE tokens SET escrow_action_index=? WHERE tick_id=?";
        await this.doQuery(query, [action_index, tick_id]);
    },

    // Release a token's ownership escrow.
    async clearTokenEscrow(tick){
        let tick_id = await this.createTicker(tick);
        let query   = "UPDATE tokens SET escrow_action_index=NULL WHERE tick_id=?";
        await this.doQuery(query, [tick_id]);
    },

    // Returns the action_index of the offer holding this tick's ownership in escrow, or null
    // if ownership is not currently escrowed. Used by ISSUE v1-5 / CALLBACK / SLEEP / LINK /
    // FILE / child-ISSUE handlers to reject owner-only actions during escrow.
    async getTokenEscrow(tick){
        if(this.util.isNull(tick))
            return null;
        let tick_id = await this.createTicker(tick);
        let query   = "SELECT escrow_action_index FROM tokens WHERE tick_id=? LIMIT 1";
        let results = await this.doQuery(query, [tick_id]);
        if(results.length === 0 || this.util.isNull(results[0].escrow_action_index))
            return null;
        return results[0].escrow_action_index;
    },

    // Validate that token supplys match credits/debits/balances information
    async sanityCheck(block_index){
        // Ignore any calls without a block index
        if(this.util.isNull(block_index))
            return;
        let tickers  = {};
        let decimals = {};
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
        let results = await this.doQuery(query, [block_index, block_index, block_index]);
        if(results.length >0){
            for(let row of results){
                // Add ticker, decimal, and supply info to assoc arrays
                tickers[row.tick]  = Number(row.tick_id);
                decimals[row.tick] = row.decimals;
            };
        }
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
        let sumByTick = async (table, joinActions) => {
            let out          = {};
            let placeholders = allIds.map(() => '?').join(', ');
            let from         = joinActions
                ? table + ' m INNER JOIN actions a ON (a.action_index=m.action_index)'
                : table + ' m';
            let q = 'SELECT m.tick_id AS tick_id, ' + ledgerPrecision.exactSumSql('m.amount') + ' AS s'
                  + ' FROM ' + from + ' WHERE m.tick_id IN (' + placeholders + ') GROUP BY m.tick_id';
            let rows = await this.doQuery(q, allIds);
            for(let row of rows){
                if(!this.util.isNull(row.s)) out[Number(row.tick_id)] = row.s;
            }
            return out;
        };
        // Ledger components (action-scoped) and total components (unjoined).
        let creditsById       = await sumByTick('credits', true);
        let debitsById        = await sumByTick('debits',  true);
        let escrowsLedgerById = await sumByTick('escrows', true);
        let balancesById      = await sumByTick('balances', false);
        let escrowsTotalById  = await sumByTick('escrows',  false);
        // tokens.supply per touched tick (raw string, no CAST - matches getTokenSupplyToken).
        let tokenById = {};
        {
            let placeholders = allIds.map(() => '?').join(', ');
            let rows = await this.doQuery(
                'SELECT tick_id, supply FROM tokens WHERE tick_id IN (' + placeholders + ')', allIds);
            for(let row of rows){
                if(!this.util.isNull(row.supply)) tokenById[Number(row.tick_id)] = row.supply;
            }
        }
        // Loop through the tickers and validate token supply match credits/debits/balances info
        for(let tick in tickers){
            let tick_id = tickers[tick];
            let d       = decimals[tick];
            let credits = (creditsById[tick_id]       != null) ? creditsById[tick_id]       : 0;
            let debitsV = (debitsById[tick_id]        != null) ? debitsById[tick_id]        : 0;
            let escLdg  = (escrowsLedgerById[tick_id] != null) ? escrowsLedgerById[tick_id] : 0;
            // Ledger (credits - debits + escrows), identical to getTokenSupply's final
            // bcadd/bcsub: net at the exact scale, round ONCE at the tick's decimals.
            let ledger  = this.util.bcnum(this.util.bcadd(
                this.util.bcsub(credits, debitsV, ledgerPrecision.LEDGER_AMOUNT_PRECISION), escLdg, d));
            let token   = this.util.bcnum((tokenById[tick_id]        != null) ? tokenById[tick_id]        : 0); // Supply from tokens
            let balance = this.util.bcnum((balancesById[tick_id]     != null) ? balancesById[tick_id]     : 0); // Supply from balances
            let escrow  = this.util.bcnum((escrowsTotalById[tick_id] != null) ? escrowsTotalById[tick_id] : 0); // Supply from escrows
            let total   = this.util.bcadd(balance, escrow, decimals[tick]);        // Total (balances + escrows)
            if(String(token)!=String(ledger) || String(token)!=String(total)){
                getLogger().info("Tick,   tick_id =", tick, tick_id);
                getLogger().info("token   supply =", token);
                getLogger().info("ledger  supply =", ledger);  // Credits / Debits / Escrows
                getLogger().info("balance supply =", balance); // balances table
                getLogger().info("escrow  supply =", escrow);  // Escrows
                getLogger().info("total   supply =", total);   // balance + escrow
            }
            if(String(token)!=String(ledger))
                this.util.throwError("SanityError: ledger supply does not match token supply : " + tick + " (" + ledger + " != " + token + ")");
            if(String(token)!=String(total))
                this.util.throwError("SanityError: total supply does not match token supply : " + tick + " (" + total + " != " + token + ")");
        }
    },

    // Get tokens owned by a given address. Ticks whose ownership is currently
    // escrowed by an open ORDER/SWAP/DISPENSER (escrow_action_index set) are in
    // protocol custody, not in the address's ownership records, so they are
    // excluded - per SWEEP.md, escrowed ownership is reachable only through the
    // offer-close path, never through the OWNERSHIPS snapshot.
    async getAddressOwnerships(address){
        let id   = await this.createAddress(address);
        let data = [];
        // Lookup the address preferences
        // Order pinned to binary collation: the SWEEP settlement loop mints a consensus-hashed
        // ACTION_INDEX per swept ownership in this result's order (sweep.js), so an unpinned sort
        // would follow each node's default collation and fork the per-block actions hash. Same
        // house rule as the other consensus reads, and it matches the byte order the SWEEP
        // controller-guard loops already sort by.
        let query = `SELECT
                        t2.tick
                    FROM
                        tokens t1
                        INNER JOIN index_tickers t2 ON (t2.id=t1.tick_id)
                    WHERE
                        t1.owner_id=?
                        AND t1.escrow_action_index IS NULL
                    ORDER BY
                        t2.tick COLLATE utf8mb4_bin`;
        let results = await this.doQuery(query, [id]);
        if(results.length > 0)
            for(let row of results)
                data.push(row.tick);
        return data;
    },

    /**
     * Set a native token row's `bridged` bit, the way setTokenEscrow sets
     * escrow_action_index: a targeted UPDATE rather than a field of the createToken
     * derivation. createToken rebuilds `tokens` from the `issues` rows and no ISSUE may
     * set or clear this bit, so it has no derivation to ride.
     *
     * Set by the FIRST applied XBRIDGE v3 lock and never cleared in milestone 1 (token
     * spec section 8): emptying BRIDGE_CHAINS after bridging must not reopen policy
     * binding while copies are outstanding on another chain. `bridged=0` in the WHERE
     * makes the write a no-op for every later lock of the same tick.
     *
     * `block_index` is the applying block. It is not stored: the bit carries no height
     * because nothing in milestone 1 reads "when", and a reorg of the first lock
     * deliberately leaves the bit set (the conservative direction, since the copies it
     * refuses policy binding for may still exist on the destination chain).
     *
     * @param {string} tick        - the NATIVE tick being locked (never the rooted form)
     * @param {number} block_index - the block the lock applied at; logged, not stored
     * @returns {Promise<void>}
     */
    async setTokenBridged(tick, block_index){
        let tick_id = await this.createTicker(tick);
        if(tick_id === null)
            return;
        let query = "UPDATE tokens SET bridged=1 WHERE tick_id=? AND bridged=0";
        let res   = await this.doQuery(query, [tick_id]);
        // One line per token, ever, because the WHERE excludes an already-set bit.
        if(res && res.affectedRows)
            getLogger().info('\t Token ' + tick + ' marked bridged at block ' + block_index);
    },

    /*
     * Programmable policy layer - controller bindings (token_controllers / address_controllers).
     *
     * A token (ISSUE format 7) or an account (ADDRESS format 1) defers a chosen action-class to a
     * guard contract. These two tables are APPEND-ONLY event logs: every bind/unbind is one
     * immutable row keyed by its own action_index. The EFFECTIVE controller for a (subject, class)
     * at block X is the latest event with block_index <= X - a `bind` gates; an `unbind` gates ONLY
     * while X < cooldown_end_block (the drop-cooldown's teeth: a thief can't instantly drop a
     * spend-limit), and stops gating once X reaches it. Cooldown expiry is therefore computed at
     * READ time, never swept - so no row ever mutates, and both tables roll back cleanly as plain
     * dataTables (DELETE WHERE action_index >= orphan, then forward replay re-creates the events).
     * "At most one live controller per (subject, class)" is enforced by the handlers: a BIND is
     * rejected when an effective controller already gates that class (replace = unbind-then-bind,
     * which preserves the cooldown's teeth). action_class ∈ {transfer, trade, burn, mint, stake,
     * ownership}, validated by the handler. See Controller_Bound_Tokens.md.
     */

    // Append a token controller bind/unbind event. `evt` carries action_index, tick_id, action_class,
    // contract_index, bound_by_id, is_unbind, cooldown_blocks, cooldown_end_block, block_index.
    async recordTokenControllerEvent(evt){
        let query = `INSERT INTO token_controllers
                        (action_index, tick_id, action_class, contract_index, bound_by_id,
                         is_unbind, cooldown_blocks, cooldown_end_block, block_index)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        await this.doQuery(query, [evt.action_index, evt.tick_id, evt.action_class, evt.contract_index,
            evt.bound_by_id, evt.is_unbind ? 1 : 0, evt.cooldown_blocks, evt.cooldown_end_block, evt.block_index]);
    },

};
