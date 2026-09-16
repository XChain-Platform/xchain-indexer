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
 * XChain Indexer - Database mixin: sends
 * 
 * The queries over the sends table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Create/Update record in `sends` table
    async createSend(data){
        data               = this.normalizeDataValues(data);
        let tick_id        = await this.createTicker(data['TICK']);
        let destination_id = await this.createAddress(data['DESTINATION']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let action_index   = data['ACTION_INDEX'];
        let amount         = data['AMOUNT'];
        // Check if record already exists for this send
        let query  = `SELECT
                            action_index
                        FROM
                            sends
                        WHERE
                            tick_id=? AND
                            destination_id=? AND
                            amount=? AND
                            action_index=?`;
        let args = [tick_id, destination_id, amount, action_index];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record, scoped to the LEG the exists-check matched.
            //
            // A multi-send puts several legs under one ACTION_INDEX (that is why the
            // sends index is non-unique), so `WHERE action_index=?` rewrote EVERY leg
            // of the action with this leg's values. On a re-parse of the same block
            // that also cascaded: once leg 1's update had stamped its values over the
            // other rows, leg 2's per-leg exists-check no longer matched anything and
            // INSERTed a duplicate. Same leg identity the exists-check above uses.
            query = `UPDATE
                        sends
                    SET
                        memo_id=?,
                        status_id=?
                    WHERE
                        action_index=? AND
                        tick_id=? AND
                        destination_id=? AND
                        amount=?`;
            args = [memo_id, status_id, action_index, tick_id, destination_id, amount];
        } else {
            // INSERT record, stamping this leg's position on the wire.
            //
            // The action loop settles the legs of a multi-send in broadcast order and
            // calls this method once per leg, so "the number of legs already stored for
            // this action" IS this leg's 0-based wire position. It is computed inside the
            // statement (COALESCE(MAX(leg_ordinal) + 1, 0)) rather than read first and
            // bound, so the read and the write cannot be separated. The UPDATE branch
            // above deliberately never touches leg_ordinal: a re-parse rewrites a leg's
            // VALUES, it does not move the leg on the wire.
            query = `INSERT INTO sends (tick_id, destination_id, amount, memo_id, status_id, action_index, leg_ordinal) SELECT ?, ?, ?, ?, ?, ?, COALESCE(MAX(leg_ordinal) + 1, 0) FROM sends WHERE action_index=?`;
            args = [tick_id, destination_id, amount, memo_id, status_id, action_index, action_index];
        }
        results = await this.doQuery(query, args);
    },

};
