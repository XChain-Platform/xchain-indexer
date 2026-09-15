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
 * XChain Indexer - Database mixin: destroys
 * 
 * The queries over the destroys table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Create/Update record in `destroys` table
    async createDestroy(data){
        data               = this.normalizeDataValues(data);
        let tick_id        = await this.createTicker(data['TICK']);
        let memo_id        = await this.createMemo(data['MEMO']);
        let status_id      = await this.createStatus(data['STATUS']);
        let action_index   = data['ACTION_INDEX'];
        let amount         = data['AMOUNT'];
        // Check if record already exists for THIS LEG of the destroy.
        //
        // A multi-destroy (FORMAT 1/2) settles several TICK legs under one
        // ACTION_INDEX, exactly like a multi-send. Keyed on action_index alone,
        // leg 2 matched leg 1's row and UPDATEd it, so every leg but the last was
        // overwritten and an N-tick destroy recorded a single destruction. The
        // parse consolidates legs by TICK|MEMO before anything is written here, so
        // (action_index, tick_id, memo_id) is the leg identity and cannot repeat;
        // AMOUNT and STATUS are the values a re-parse of the block may rewrite.
        // memo_id is compared NULL-safely because createMemo returns NULL for an
        // absent MEMO, and `memo_id=NULL` is never true.
        let query  = `SELECT
                            action_index
                        FROM
                            destroys
                        WHERE
                            action_index=? AND
                            tick_id=? AND
                            memo_id<=>?`;
        let args = [action_index, tick_id, memo_id];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        if(exists){
            // UPDATE record (scoped to this leg, never the whole action)
            query = `UPDATE
                        destroys
                    SET
                        amount=?,
                        status_id=?
                    WHERE
                        action_index=? AND
                        tick_id=? AND
                        memo_id<=>?`;
            args  = [amount, status_id, action_index, tick_id, memo_id];
        } else {
            // INSERT record, stamping this leg's position on the wire. Same rule as
            // createSend: the ordinal is the count of legs already stored for this
            // action, computed inside the statement, and the UPDATE branch leaves it
            // alone so a re-parse cannot reorder an already-indexed action.
            query = `INSERT INTO destroys (tick_id, amount, memo_id, status_id, action_index, leg_ordinal) SELECT ?, ?, ?, ?, ?, COALESCE(MAX(leg_ordinal) + 1, 0) FROM destroys WHERE action_index=?`;
            args  = [tick_id, amount, memo_id, status_id, action_index, action_index];
        }
        results = await this.doQuery(query, args);
    },

};
