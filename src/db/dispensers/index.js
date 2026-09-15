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
 * XChain Indexer - Database mixin: dispensers
 * 
 * The queries over the dispensers table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

// The writers and the dispense-trigger reads are the parts of this family kept in
// dispensers/writes.js and dispensers/dispense_matching.js; they are merged into the
// export below, so db/index.js installs one dispensers mixin and every method keeps its
// name on Database.prototype.
const writes           = require('./writes.js');
const dispenseMatching = require('./dispense_matching.js');

// The getDispenserInfo read: one dispenser by coin and action_index with every column
// the caller exposes, its own status and the status of its latest dispenser_statuses row.
const DISPENSER_INFO_SQL = `SELECT
                        d1.action_index,
                        t2.tick as give_tick,
                        d1.give_amount,
                        d1.give_ownership,
                        c1.coin as get_coin,
                        t3.tick as get_tick,
                        d1.get_amount,
                        d1.give_escrow,
                        a2.address as source,
                        a3.address as get_address,
                        d1.expiration,
                        d1.allow_list,
                        d1.block_list,
                        f1.code as fiat,
                        d1.fiat_amount,
                        a4.address as oracle_address,
                        m1.memo,
                        s2.status,
                        s3.status as dispenser_status,
                        b1.block_index,
                        b1.block_time
                    FROM
                        dispensers d1
                        INNER JOIN actions             a1 ON (a1.action_index=d1.action_index)
                        INNER JOIN transactions        t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN blocks              b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses     a2 ON (a2.id=a1.source_id)
                        INNER JOIN index_addresses     a3 ON (a3.id=d1.get_address_id)
                        LEFT  JOIN index_addresses     a4 ON (a4.id=d1.oracle_address_id)
                        INNER JOIN index_tickers       t2 ON (t2.id=d1.give_tick_id)
                        LEFT  JOIN index_tickers       t3 ON (t3.id=d1.get_tick_id)
                        INNER JOIN index_coins         c1 ON (c1.id=d1.get_coin_id)
                        LEFT  JOIN index_memos         m1 ON (m1.id=d1.memo_id)
                        LEFT  JOIN index_fiats         f1 ON (f1.id=d1.fiat_id)
                        INNER JOIN dispenser_statuses  s1 ON (s1.dispenser_action_index=d1.action_index)
                        INNER JOIN index_statuses      s2 ON (s2.id=d1.status_id)
                        INNER JOIN index_statuses      s3 ON (s3.id=s1.status_id)
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
                        d1.action_index=?
                    LIMIT 1`;

module.exports = {

    // Return dispenser info for given action_index
    async getDispenserInfo(coin, action_index, block_time){
        let dispenser = false;
        let query = DISPENSER_INFO_SQL;
        let args  = [coin, action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            dispenser = {};
            dispenser['GIVE_COIN'] = this.config['COIN'];
            for(let key in results[0]){
                let name  = String(key).toUpperCase()
                let value = results[0][key];
                if(['ACTION_INDEX', 'BLOCK_INDEX', 'BLOCK_TIME', 'EXPIRATION', 'ALLOW_LIST', 'BLOCK_LIST', 'GIVE_OWNERSHIP'].includes(name))
                    value = Number(value);
                dispenser[name] = value;
            }
        }
        // Get additional information on this order
        if(dispenser){
            // Get updated dispenser properties from the dispenser_edits table.
            // EXPIRATION and the two lists overlay; GIVE_ESCROW deliberately does NOT and
            // stays the create-time value, because refills are counted by
            // getDispenserAmountRemaining (64dp) and GIVE_REMAINING below is the number
            // any caller wanting post-refill escrow should read.
            let edit = await this.getDispenserEdits(action_index, block_time);
            if(edit.expiration)
                dispenser['EXPIRATION'] = edit.expiration;
            if(edit.allow_list)
                dispenser['ALLOW_LIST'] = edit.allow_list;
            if(edit.block_list)
                dispenser['BLOCK_LIST'] = edit.block_list;
            // Ownership dispensers expose virtual '1' for GIVE_AMOUNT / GIVE_ESCROW so the
            // matching engine and dispense flow can compare amounts uniformly. Settlement
            // code branches on GIVE_OWNERSHIP rather than the synthetic amount.
            if(dispenser['GIVE_OWNERSHIP'] == 1){
                if(this.util.isNull(dispenser['GIVE_AMOUNT']))  dispenser['GIVE_AMOUNT']  = '1';
                if(this.util.isNull(dispenser['GIVE_ESCROW'])) dispenser['GIVE_ESCROW'] = '1';
                // Virtual remaining: 1 if no dispense yet, 0 once dispensed (single-shot).
                // getDispenserAmountRemaining returns 0 for a fresh ownership dispenser
                // (give_escrow is null in the DB) and goes negative after a successful
                // DISPENSE has been recorded with give_amount='1'.
                let dispensed = await this.getDispenserAmountRemaining(action_index);
                dispenser['GIVE_REMAINING'] = this.util.bclt(dispensed, 0) ? '0' : '1';
            } else {
                // Determine dispenser amounts remaining
                dispenser['GIVE_REMAINING'] = await this.getDispenserAmountRemaining(action_index);
            }
        }
        return dispenser;
    },

    // Origin-standing check for DISPENSER creates (DISPENSER_ORIGIN_STANDING
    // protocol change): true when `source` is the SOURCE of at least one prior
    // VALID dispenser create on `getAddress` (action_index strictly earlier
    // than the create being validated). Later status changes (closed /
    // canceled / expired) do not revoke standing; only the create's own
    // validity counts, so invalid create attempts confer nothing.
    async hasDispenserOriginStanding(source, getAddress, action_index){
        let query = `SELECT
                        d1.action_index
                    FROM
                        dispensers d1
                        INNER JOIN actions         a1 ON (a1.action_index=d1.action_index)
                        INNER JOIN index_addresses a2 ON (a2.id=a1.source_id)
                        INNER JOIN index_addresses a3 ON (a3.id=d1.get_address_id)
                        INNER JOIN index_statuses  s1 ON (s1.id=d1.status_id)
                    WHERE
                        a2.address=? AND
                        a3.address=? AND
                        s1.status='valid' AND
                        d1.action_index<?
                    LIMIT 1`;
        let results = await this.doQuery(query, [source, getAddress, action_index]);
        return results.length > 0;
    },

    // Return dispenser edit information for given action_index.
    //
    // Escrow totals are deliberately NOT returned here: getDispenserAmountRemaining
    // sums the same refill rows itself at 64dp and is the single source for them. This
    // must not accumulate a give_escrow its only caller then drops, at 0dp, which would be a
    // lossy dead compute that a later refactor would have wired up as an accounting bug.
    async getDispenserEdits(action_index, block_time){
        // Define empty edit object
        let edit  = {
            expiration: false,
            allow_list: false,
            block_list: false
        };
        let query  = `SELECT
                        e1.expiration,
                        e1.allow_list,
                        e1.block_list,
                        b1.block_time
                    FROM 
                        dispenser_edits e1
                        INNER JOIN actions        a1 ON (a1.action_index=e1.action_index)
                        INNER JOIN blocks         b1 ON (b1.block_index=a1.block_index)
                        INNER JOIN index_statuses s1 ON (s1.id=e1.status_id)
                    WHERE 
                        e1.dispenser_action_index=? AND
                        s1.status=?
                    ORDER BY
                        e1.action_index ASC`;
        let args  = [action_index, 'valid'];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results){
                // updating expiration is immediately active
                if(!this.util.isNull(row.expiration) && this.util.isNumeric(row.expiration))
                    edit.expiration  = Number(row.expiration);
                // Determine if the list edits are active or not
                let active = this.util.bcgt(block_time, this.util.bcadd(row.block_time, this.config['DISPENSER_LIST_DELAY']));
                if(active){
                    if(!this.util.isNull(row.allow_list) && this.util.isNumeric(row.allow_list))   
                        edit.allow_list  = Number(row.allow_list);
                    if(!this.util.isNull(row.block_list) && this.util.isNumeric(row.block_list))   
                        edit.block_list  = Number(row.block_list);
                }
            }
        }
        return edit;
    },

    // DISPENSER caps (dispenser_caps_activation.js). Both counts are
    // DERIVED from existing rollback-covered tables (dispenses / dispenser_edits),
    // matching the house pattern that recomputes GIVE_REMAINING rather than storing
    // a mutable counter: a reorg that deletes those rows automatically corrects the
    // count, so no new column/table and no migration are needed.

    // Count of VALID refills (a dispenser_edits row that tops up GIVE_ESCROW, i.e.
    // give_escrow > 0) for this dispenser. Feeds the 6th-refill rejection (MAX_REFILLS).
    async getDispenserRefillCount(action_index){
        let query = `SELECT COUNT(*) AS c
                     FROM dispenser_edits e
                     INNER JOIN index_statuses s ON (s.id=e.status_id)
                     WHERE e.dispenser_action_index=? AND s.status='valid'
                       AND e.give_escrow IS NOT NULL AND e.give_escrow > 0`;
        let rows = await this.doQuery(query, [action_index]);
        return (rows.length > 0) ? Number(rows[0].c) : 0;
    },

    // Count of VALID dispenses for this dispenser SINCE its most recent refill.
    // A refill resets the dispense count (Counterparty parity), so only dispenses
    // recorded after the last refill's action_index count toward MAX_DISPENSES; no
    // refill -> all valid dispenses (since 0). The just-settled dispense is already
    // persisted when dispense.js calls this, so the returned count includes it.
    async getDispenserDispenseCount(action_index){
        let refillQ = `SELECT MAX(e.action_index) AS r
                       FROM dispenser_edits e
                       INNER JOIN index_statuses s ON (s.id=e.status_id)
                       WHERE e.dispenser_action_index=? AND s.status='valid'
                         AND e.give_escrow IS NOT NULL AND e.give_escrow > 0`;
        let refillRows = await this.doQuery(refillQ, [action_index]);
        let sinceIndex = (refillRows.length > 0 && refillRows[0].r !== null) ? refillRows[0].r : 0;
        let countQ = `SELECT COUNT(*) AS c
                      FROM dispenses d
                      INNER JOIN index_statuses s ON (s.id=d.status_id)
                      WHERE d.dispenser_action_index=? AND s.status='valid' AND d.action_index > ?`;
        let rows = await this.doQuery(countQ, [action_index, sinceIndex]);
        return (rows.length > 0) ? Number(rows[0].c) : 0;
    },

    // Lookup items that need to be cancelled and return a list
    async findCancelledDispensers(block_time){
        let cancels = [];
        // Find dispensers where latest status is 'cancelling`
        let args  = [];
        let query = `SELECT 
                        m.action_index,
                        b1.block_time
                    FROM 
                        dispensers m
                        INNER JOIN dispenser_statuses s1 ON (s1.dispenser_action_index=m.action_index)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                    WHERE 
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                dispenser_statuses s3
                            WHERE
                                s3.dispenser_action_index=m.action_index
                        ) AND
                        s2.status='cancelling'
                    ORDER BY m.action_index ASC`
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results)
                if(this.util.bcgt(block_time, this.util.bcadd(row.block_time, this.config['DISPENSER_CLOSE_DELAY'])))
                    cancels.push(Number(row.action_index));
        }
        return cancels;
    },

    // Return the address recorded as the canceller for a dispenser's most recent
    // 'cancelling' status row, or null if there isn't one. Used by dispenser_close
    // to route escrow per DISPENSER.md (canceller == GET_ADDRESS → escrow to GET_ADDRESS;
    // canceller == SOURCE → escrow to SOURCE).
    async getDispenserCanceller(action_index){
        let address = null;
        let query = `SELECT
                        a1.address
                    FROM
                        dispenser_statuses s1
                        INNER JOIN index_addresses a1 ON (a1.id=s1.cancelled_by_id)
                    WHERE
                        s1.dispenser_action_index=? AND
                        s1.cancelled_by_id IS NOT NULL
                    ORDER BY
                        s1.action_index DESC
                    LIMIT 1`;
        let results = await this.doQuery(query, [action_index]);
        if(results.length > 0)
            address = results[0].address;
        return address;
    },

    // Handle getting the sweep destination address for a given dispenser action_index
    async getSweepDestination(action_index){
        let address = null;
        // Normalize data
        let query  = `SELECT
                            a1.address
                        FROM
                            dispensers d1
                            INNER JOIN dispenser_statuses s1 ON (s1.dispenser_action_index=d1.action_index)
                            LEFT  JOIN sweeps             s2 ON (s2.action_index=s1.action_index)
                            LEFT  JOIN index_addresses    a1 ON (a1.id=s2.destination_id)
                            LEFT  JOIN index_statuses     s3 ON (s3.id=s2.status_id)
                        WHERE
                            s1.action_index = (
                                SELECT
                                    MAX(s4.action_index)
                                FROM
                                    dispenser_statuses s4
                                WHERE
                                    s4.dispenser_action_index=d1.action_index
                            ) AND
                            d1.action_index=? AND
                            s3.status='valid'
                        ORDER BY 
                            d1.action_index ASC
                        LIMIT 1`;
        let args = [action_index];
        let results = await this.doQuery(query, args);
        if(results.length > 0){
            for(let row of results)
                address = row.address;
        }
        return address;
    },

    ...writes,

    ...dispenseMatching,

};
