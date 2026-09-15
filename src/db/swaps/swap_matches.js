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
 * XChain Indexer - Database mixin part: swaps / swap_matches
 *
 * The counter-offer lookup a new SWAP runs, and the upsert of the swap_matches
 * row a settled pairing writes.
 * Merged into the swaps mixin by db/swaps/index.js, which db/index.js installs
 * onto Database.prototype, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Handle looking up potential swap matches
    async findSwapMatches(data){
        let matches = false;
        // Normalize data
        let source_id    = await this.createAddress(data['SOURCE']);
        let action_index = data['ACTION_INDEX'];
        // Lookup any matching swaps from different addresses (not SOURCE)
        let query = swapMatchesSql();
        let args = [action_index, source_id];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            // Loop through possible matches and get full information on the swap match
            for(let row of results){
                let swapInfo = await this.getSwapInfo(row.coin, row.action_index);
                if(!matches)
                    matches = [];
                matches.push(swapInfo);
            }
        }
        return matches;
    },

    // Create/Update record in `swap_matches` table
    async createSwapMatch(data, swap, match){
        data                  = this.normalizeDataValues(data);
        let give_coin_id      = await this.createCoin(match['GIVE_COIN']);
        let get_coin_id       = await this.createCoin(match['GET_COIN']);
        let give_tick_id      = await this.createTicker(match['GIVE_TICK']);
        let get_tick_id       = await this.createTicker(match['GET_TICK']);
        let status_id         = await this.createStatus(data['STATUS']);
        let give_amount       = match['GIVE_AMOUNT']
        let get_amount        = match['GET_AMOUNT']
        let action_index      = data['ACTION_INDEX'];
        let give_action_index = match['ACTION_INDEX']
        let get_action_index  = swap['ACTION_INDEX'];
        // Check if record already exists for this swap_matches
        let query  = `SELECT
                            action_index
                        FROM
                            swap_matches
                        WHERE
                            action_index=?`;
        let args = [action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record
            query = `UPDATE
                        swap_matches
                    SET
                        give_coin_id=?,
                        give_tick_id=?,
                        give_amount=?,
                        give_action_index=?,
                        get_coin_id=?,
                        get_tick_id=?,
                        get_amount=?,
                        get_action_index=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO swap_matches (give_coin_id, give_tick_id, give_amount, give_action_index, get_coin_id, get_tick_id, get_amount, get_action_index, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [give_coin_id, give_tick_id, give_amount, give_action_index, get_coin_id, get_tick_id, get_amount, get_action_index, status_id, action_index];
        results = await this.doQuery(query, args);
    },

};

// The statement findSwapMatches runs, kept off the exported object so Database.prototype
// gains no method. It binds [action_index, source_id]: the new swap s1, and its maker's
// address id, which the counter-offer s2 must not share. The SQL comments inside the
// statement carry the reasons for each leg of the pairing.
function swapMatchesSql(){
    return `SELECT
                        c1.coin,
                        s2.action_index
                    FROM
                        swaps s1,
                        swaps s2
                        INNER JOIN index_coins    c1 ON (c1.id=s2.get_coin_id)
                        INNER JOIN actions        a1 ON (a1.action_index=s2.action_index)
                        INNER JOIN transactions   t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN swap_statuses  s3 ON (s3.swap_action_index=s2.action_index)
                        INNER JOIN index_statuses s4 ON (s4.id=s3.status_id)
                    WHERE
                        s3.action_index = (
                            SELECT
                                MAX(s4.action_index)
                            FROM
                                swap_statuses s4
                            WHERE
                                s4.swap_action_index=s2.action_index
                        ) AND
                        s1.give_coin_id=s2.get_coin_id AND
                        s1.give_tick_id=s2.get_tick_id AND
                        -- Reverse leg: what s1 GETS must be exactly what s2 GIVES. The give leg and
                        -- the two amount equalities below bind everything EXCEPT the reverse tick/coin,
                        -- so a taker could receive a DIFFERENT (freely chosen, valuable) token than the
                        -- maker escrowed as long as the amounts matched; swap_match settlement then
                        -- credits swapInfo.GET_TICK, minting that token from the global escrow pool
                        -- (the +credit / -phantom-escrow net to zero, so the supply sanityCheck never
                        -- trips) while the maker's real GIVE token is stranded. NULL-safe (native-coin
                        -- sides carry a NULL tick), matching the give-leg / findOrderMatches handling.
                        s1.get_coin_id=s2.give_coin_id AND
                        -- Enforced only when both reverse ticks are real tokens (the token-for-token
                        -- path, where the mint bug lives); a NULL-tick leg is left to its own routing.
                        (s1.get_tick_id=s2.give_tick_id OR s1.get_tick_id IS NULL OR s2.give_tick_id IS NULL) AND
                        -- Ownership legs store NULL amounts; in SQL, NULL = NULL is NULL (not
                        -- true), so a bare equality silently drops every ownership swap
                        -- (ownership-for-ownership = both NULL, ownership-for-balance = one
                        -- NULL) before it can be returned. Pair on NULL-equals-NULL too, the
                        -- way findOrderMatches handles its null sides (#3749).
                        (s1.give_amount=s2.get_amount OR (s1.give_amount IS NULL AND s2.get_amount IS NULL)) AND
                        (s1.get_amount=s2.give_amount OR (s1.get_amount IS NULL AND s2.give_amount IS NULL)) AND
                        s1.action_index=? AND
                        a1.source_id!=? AND
                        s4.status='open'
                    ORDER BY
                        s2.action_index ASC`;
}
