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
 * XChain Indexer - Database mixin: sleeps
 * 
 * The queries over the sleeps table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const path    = require('path');

module.exports = {

    // Validate if ADDRESS is in SLEEP mode
    async isAddressSleeping(address, block_index){
        let sleep = false;
        if(!this.util.isNull(address) && this.isAnyCoinAddress(address, block_index) && !this.util.isNull(block_index) && this.util.isNumeric(block_index)){
            let id    = await this.createAddress(address);
            let query = `SELECT 
                            s1.resume_block 
                        FROM 
                            sleeps s1
                            INNER JOIN actions        a1 ON (a1.action_index=s1.action_index)
                            INNER JOIN transactions   t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN index_statuses s2 ON (s2.id=s1.status_id)
                        WHERE 
                            s1.type=? AND
                            t1.source_id=? AND
                            s2.status=?
                        ORDER BY 
                            s1.action_index DESC
                        LIMIT 1`;
            let args = [1, id, 'valid'];
            let results = await this.doQuery(query, args);
            if(results.length > 0){
                let resume_block = Number(results[0].resume_block);
                if(resume_block ==  -1 || resume_block > block_index)
                    sleep = true;
            }
        }
        return sleep;
    },

    // Validate if TICK is in SLEEP mode
    async isTickSleeping(tick, block_index){
        let sleep = false;
        if(!this.util.isNull(tick) && !this.util.isNull(block_index) && this.util.isNumeric(block_index)){
            let id    = await this.createTicker(tick);
            let query = `SELECT 
                            s1.resume_block 
                        FROM 
                            sleeps s1
                            INNER JOIN index_statuses s2 ON (s2.id=s1.status_id)
                        WHERE 
                            s1.type=? AND
                            s1.tick_id=? AND
                            s2.status=?
                        ORDER BY 
                            s1.action_index DESC
                        LIMIT 1`;
            let args = [2, id, 'valid'];
            let results = await this.doQuery(query, args);
            if(results.length > 0){
                let resume_block = Number(results[0].resume_block);
                if(resume_block ==  -1 || resume_block > block_index)
                    sleep = true;
            }
        }
        return sleep;
    },

    // "As of a block" variant of isTickSleeping (the token bridge policy spec
    // section 3, D3). The current read takes the NEWEST valid sleep row with no bound on
    // when it was mined, which is right for judging an action being processed right now
    // (nothing after it can exist yet) but wrong for gettokenpolicy reading the sleep state
    // at a past origin_block: a sleep row mined AFTER that height must not be seen. Bounds
    // the sleep row the same way getListAtBlock bounds the list head. Read-path only,
    // never enters isActionAllowed.
    async isTickSleepingAtBlock(tick, block_index){
        let sleep = false;
        if(!this.util.isNull(tick) && !this.util.isNull(block_index) && this.util.isNumeric(block_index)){
            let id    = await this.createTicker(tick);
            let query = `SELECT
                            s1.resume_block
                        FROM
                            sleeps s1
                            INNER JOIN actions        a1 ON (a1.action_index=s1.action_index)
                            INNER JOIN index_statuses s2 ON (s2.id=s1.status_id)
                        WHERE
                            s1.type=? AND
                            s1.tick_id=? AND
                            s2.status=? AND
                            a1.block_index<=?
                        ORDER BY
                            s1.action_index DESC
                        LIMIT 1`;
            let args = [2, id, 'valid', block_index];
            let results = await this.doQuery(query, args);
            if(results.length > 0){
                let resume_block = Number(results[0].resume_block);
                if(resume_block ==  -1 || resume_block > block_index)
                    sleep = true;
            }
        }
        return sleep;
    },

    // Create/Update record in `sleeps` table
    async createSleep(data){
        // Capture the sleep TYPE *before* normalizeDataValues runs: TYPE is a
        // NUMBER_FIELD, so the non-numeric string 'TICK'/'ADDRESS' gets nulled
        // there. Reading it after normalize made (data['TYPE']=='TICK') always
        // false, so every TICK sleep (SLEEP v1) was stored as an ADDRESS sleep
        // (type=1) - wrongly sleeping the token owner's whole address and never
        // pausing the tick (isTickSleeping looks for type=2).
        let type         = (data['TYPE']=='TICK') ? 2 : 1;
        data             = this.normalizeDataValues(data);
        let tick_id      = await this.createTicker(data['TICK']);
        let memo_id      = await this.createMemo(data['MEMO']);
        let status_id    = await this.createStatus(data['STATUS']);
        let action_index = data['ACTION_INDEX'];
        let resume_block = data['RESUME_BLOCK'];
        // Check if record already exists for this sleep
        let query  = `SELECT
                            action_index
                        FROM
                            sleeps
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
                        sleeps
                    SET
                        type=?,
                        tick_id=?,
                        resume_block=?,
                        memo_id=?,
                        status_id=?
                    WHERE 
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO sleeps (type, tick_id, resume_block, memo_id, status_id, action_index) values (?, ?, ?, ?, ?, ?)`;
        }
        args    = [type, tick_id, resume_block, memo_id, status_id, action_index];
        results = await this.doQuery(query, args);
    },

};
