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
// The tokens mixin is cut into parts by behaviour under tokens/; this entry merges them
// back into the one method set db/index.js installs, at the position those methods held here.
const tokenWriter = require('./token_writer.js');
const sanityCheck = require('./sanity_check.js');

const { getLogger } = require('../../observability/index.js');
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

    ...tokenWriter,

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
        // Ticker ids are consensus state. Keep caller order so each MAX(id)+1 reservation
        // is inserted before the next token reads the dense counter.
        for(const tick of tokens)
            await this.updateTokenInfo(tick);
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

    ...sanityCheck,

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
     * ownership}, validated by the handler. See
     * xchain-documentation/protocol/controller-bound-tokens.md.
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
