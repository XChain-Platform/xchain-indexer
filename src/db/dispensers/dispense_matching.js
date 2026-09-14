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
 * XChain Indexer - Database mixin part: dispensers, the dispense-trigger reads
 *
 * Which open dispensers a token SEND or a native payment hits, and which closed
 * dispenser a payment that hit nothing was aimed at. Merged into the dispensers mixin
 * by db/dispensers.js, which db/index.js installs onto Database.prototype, so call
 * sites stay this.db.<method>().
 *
 ********************************************************************/

const dispenseCancellingMatch = require('../../dispense_cancelling_match_activation');
const dispenserSendCompare = require('../../dispenser_send_amount_compare_activation');

// The findMatchingDispensers query: valid dispensers for a coin at an address whose
// latest status is open or cancelling. `latestStatusCorrelate` is the column the
// latest-status subquery correlates on and `where` the tick predicate, both chosen by
// findMatchingDispensers under the flag-days its comments describe.
function matchingDispensersSql(latestStatusCorrelate, where){
    return `SELECT
                            d1.action_index,
                            d1.get_amount,
                            d1.fiat_id
                        FROM
                            dispensers d1
                            INNER JOIN dispenser_statuses s1 ON (s1.dispenser_action_index=d1.action_index)
                            INNER JOIN index_statuses     s2 ON (s2.id=d1.status_id)
                            INNER JOIN index_statuses     s3 ON (s3.id=s1.status_id)
                        WHERE
                            s1.action_index = (
                                SELECT
                                    MAX(s4.action_index)
                                FROM
                                    dispenser_statuses s4
                                WHERE
                                    s4.dispenser_action_index=` + latestStatusCorrelate + `
                            ) AND
                            s2.status='valid' AND
                            s3.status IN ('open', 'cancelling') AND
                            d1.get_coin_id=? AND
                            d1.get_address_id=?` + where + `
                        ORDER BY d1.action_index ASC`;
}

module.exports = {

    // Handle finding any sends to an address with active dispenser(s)
    //
    // Affordability predicate (flag-day gated, see
    // dispenser_send_amount_compare_activation.js). `sends.amount` and
    // `dispensers.get_amount` are both VARCHAR(250), so the legacy
    // `s1.amount >= d1.get_amount` compares them as TEXT under the column
    // collation: get_amount '9' against a send of '10' is false as a string and
    // true as a number. This query is the ONLY gate deciding whether a token
    // SEND becomes a DISPENSE (utility.processDispenserSends iterates exactly
    // these rows), so a lexicographic false negative strands the sender's
    // tokens at the dispenser address on a legal overpayment. At/after the
    // activation both operands are CAST to DECIMAL before comparing, the
    // CAST-before-compare idiom every sibling amount query in this file uses.
    // Correcting it changes how already-valid blocks evaluate, so the legacy
    // predicate is emitted byte-identically below the height, and a caller with
    // no block context (out-of-band writes, API-side readers) stays on it.
    async findDispenserSends(action_index, block_index){
        let sends = [];
        let amountCompare = dispenserSendCompare.sendAmountComparePredicate(
            block_index, this.config['NETWORK'], this.config['COIN']);
        let query  = `SELECT
                            a2.address as source,
                            a3.address as destination,
                            c1.coin,
                            t2.tick,
                            s1.amount
                        FROM
                            sends s1
                            INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN dispensers         d1 ON (d1.get_address_id=s1.destination_id)
                            INNER JOIN dispenser_statuses s2 ON (s2.dispenser_action_index=d1.action_index)
                            INNER JOIN index_statuses     s3 ON (s3.id=s1.status_id)
                            INNER JOIN index_statuses     s4 ON (s4.id=s2.status_id)
                            INNER JOIN index_addresses    a2 ON (a2.id=a1.source_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=s1.destination_id)
                            INNER JOIN index_tickers      t2 ON (t2.id=s1.tick_id)
                            INNER JOIN index_coins        c1 ON (c1.id=d1.get_coin_id)
                        WHERE
                            s2.action_index = (
                                SELECT
                                    MAX(s5.action_index)
                                FROM
                                    dispenser_statuses s5
                                WHERE
                                    s5.dispenser_action_index=d1.action_index
                            ) AND
                            s3.status='valid' AND 
                            s4.status IN ('open', 'cancelling') AND 
                            s1.tick_id=d1.get_tick_id AND
                            ` + amountCompare + ` AND
                            s1.action_index=?
                        GROUP BY s1.action_index`;
        let args = [action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            sends = results;
        return sends;
    },

    // Handle finding any open dispensers for a given coin/tick/amount/destination combination
    async findMatchingDispensers(data){
        let dispensers = [];
        // Normalize data
        let coin_id        = await this.createCoin(data['COIN']);
        let tick_id        = await this.createTicker(data['COIN_TICK']);
        let destination_id = await this.createAddress(data['COIN_DESTINATION']);
        let coin_amount    = this.util.bcnum(data['COIN_AMOUNT']);
        let args           = [coin_id, destination_id];
        let where          = '';
        let dispenses      = [];
        // Include the ticker in the query if we have one
        if(!this.util.isNull(tick_id)){
            where = ' AND d1.get_tick_id=?';
            args.push(tick_id);
        } else if(dispenseCancellingMatch.isDispenseCancellingMatchActive(data['BLOCK_TIME'], this.config['NETWORK'])){
            // Native-coin trigger: a bare native payment carries no COIN_TICK (only the
            // token-SEND channel sets it, utility.js), so tick_id is null. Without a
            // predicate the native branch left `where` empty and matched EVERY open
            // dispenser at the address, including token-priced ones (get_tick_id non-null),
            // then dispense.js settled the seller's escrow by comparing a native amount to a
            // token-denominated GET_AMOUNT with no unit check - escrow dispensed against
            // payment in the WRONG asset. A native trigger must only settle native-priced
            // dispensers (get_tick_id IS NULL). Correcting the match set changes how
            // already-valid blocks evaluate, so it rides the coordinated 2.0.0 flag-day
            // shared by dispense_cancelling_match_activation (which gates the sibling
            // correction in this same function): below the flag-day the legacy unbounded
            // match is kept so historical replay stays byte-identical; at/after it the
            // native branch is constrained to get_tick_id IS NULL.
            where = ' AND d1.get_tick_id IS NULL';
        }
        // Latest-status correlation column (flag-day gated, see
        // dispense_cancelling_match_activation.js). The MAX(action_index) subquery must
        // correlate on the DISPENSER's action index (d1.action_index), the idiom every
        // sibling query uses (getDispenserInfo / findDispenserSends / getSweepDestination /
        // findCancelledDispensers). The legacy predicate correlated on s1.action_index -
        // the STATUS row's own action index, a different id domain - which only resolves
        // while the dispenser's sole status row is the initial 'open' one; after a cancel
        // writes a 'cancelling' row the dispenser matches nothing and the buyer's coin-paid
        // DISPENSE trigger is silently dropped. Correcting it changes how already-valid
        // blocks evaluate, so the legacy column is kept below the activation time.
        let latestStatusCorrelate = dispenseCancellingMatch.isDispenseCancellingMatchActive(
            data['BLOCK_TIME'], this.config['NETWORK']) ? 'd1.action_index' : 's1.action_index';
        let query  = matchingDispensersSql(latestStatusCorrelate, where);
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                // FIAT dispensers: include regardless of coin_amount (matching happens in dispense.js via reverse price lookup)
                // Non-FIAT dispensers: only include if coin_amount >= get_amount
                if(!this.util.isNull(row.fiat_id) || this.util.bcgte(coin_amount, row.get_amount))
                    dispensers.push(Number(row.action_index));
            }
        }
        return dispensers;
    },

    // Observability helper (read-only): given the COIN network and a paid address,
    // return the most recent dispenser at that address whose LATEST status is
    // 'cancelled' or 'expired', or false if none. Used by dispense.js to tag a
    // DISPENSE trigger that matched no open dispenser: when the address DID hold a
    // dispenser the indexer has since closed or re-dated, this identifies which one
    // and why. Purely for metrics - it changes no validation or state outcome, and
    // uses the same latest-status idiom as findMatchingDispensers / getDispenserInfo.
    async getClosedDispenserAtAddress(coin, address){
        let query = `SELECT
                        d1.action_index,
                        s3.status
                    FROM
                        dispensers d1
                        INNER JOIN index_addresses    a3 ON (a3.id=d1.get_address_id)
                        INNER JOIN index_coins        c1 ON (c1.id=d1.get_coin_id)
                        INNER JOIN dispenser_statuses s1 ON (s1.dispenser_action_index=d1.action_index)
                        INNER JOIN index_statuses     s3 ON (s3.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT
                                MAX(s4.action_index)
                            FROM
                                dispenser_statuses s4
                            WHERE
                                s4.dispenser_action_index=d1.action_index
                        ) AND
                        c1.coin=? AND
                        a3.address=? AND
                        s3.status IN ('cancelled', 'expired')
                    ORDER BY d1.action_index DESC
                    LIMIT 1`;
        let results = await this.doQuery(query, [coin, address]);
        if(results.length > 0)
            return { ACTION_INDEX: Number(results[0].action_index), REASON: results[0].status };
        return false;
    },

};
