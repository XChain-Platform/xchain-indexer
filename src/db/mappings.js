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
 * XChain Indexer - Database mixin: mappings
 * 
 * The queries over the mappings table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Create records in the 'mappings_actions' table
    async createActionMapping(action_index, type, value){
        let type_id = null,
            id      = null;
        if(type=='tick'){
            type_id = 1;
            id      = await this.createTicker(value);
        }
        if(type=='address'){
            type_id = 2;
            id      = await this.createAddress(value);
        }
        // A wire ^<id> reference that does not resolve to an existing block-stamped row
        // yields a null id (getAddressId/getTickerId, commit 0b023b2). There is no entity
        // to map, so skip the row rather than INSERT NULL into the NOT-NULL id column,
        // which aborts the whole block on a reindex. Matches 0b023b2's "treat as a no-op
        // rather than mint a bogus row" contract; mappings_actions is a lookup index, not
        // consensus-hashed, so skipping a dangling-ref mapping changes no block hashes.
        if(this.util.isNull(id))
            return;
        // Check if record already exists
        let query  = `SELECT
                            action_index
                        FROM
                            mappings_actions
                        WHERE
                            action_index=? AND
                            type_id=? AND
                            id=?`;
        let args = [action_index, type_id, id];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        // Create record if it does not already exist
        if(!exists){
            query   = `INSERT INTO mappings_actions (action_index, type_id, id) values (?, ?, ?)`;
            results = await this.doQuery(query, args);
        }
    },

    // Batched sibling of createActionMapping(): resolves every value's id and writes all
    // rows for one (action_index, type) in as few round-trips as possible instead of one
    // SELECT+INSERT pair per value. Used by mapper.js for recipient-scaling actions
    // (DIVIDEND/AIRDROP/CALLBACK) where the address/tick list can hold thousands of entries.
    // Preserves createActionMapping's semantics exactly: same dangling-^<id>-reference skip,
    // same existing-row de-duplication, no rows written for an empty list.
    async createActionMappings(action_index, type, values){
        if(this.util.isNull(values) || values.length === 0)
            return;
        let type_id = null;
        if(type=='tick')
            type_id = 1;
        if(type=='address')
            type_id = 2;
        if(this.util.isNull(type_id))
            return;

        // Resolve ids one at a time (createTicker/createAddress are themselves cached lookups),
        // skipping dangling ^<id> references (null id) and de-duplicating within this batch.
        let ids = [];
        for(let value of values){
            let id = (type=='tick') ? await this.createTicker(value) : await this.createAddress(value);
            if(this.util.isNull(id))
                continue;
            if(!ids.includes(id))
                ids.push(id);
        }
        if(ids.length === 0)
            return;

        // Skip ids that already carry a mapping row for this action_index/type, matching
        // createActionMapping's existing-record guard, so the batched INSERT never collides.
        let existsQuery = `SELECT id FROM mappings_actions WHERE action_index=? AND type_id=? AND id IN (${ids.map(() => '?').join(', ')})`;
        let existsRows  = await this.doQuery(existsQuery, [action_index, type_id, ...ids]);
        let existingIds = existsRows.map(row => row.id);
        let toInsert    = ids.filter(id => !existingIds.includes(id));
        if(toInsert.length === 0)
            return;

        // Chunk the multi-row INSERT so a very large recipient list cannot exceed the
        // driver's bound-parameter limit.
        let chunkSize = 500;
        for(let i = 0; i < toInsert.length; i += chunkSize){
            let chunk        = toInsert.slice(i, i + chunkSize);
            let placeholders = chunk.map(() => '(?, ?, ?)').join(', ');
            let args         = [];
            for(let id of chunk)
                args.push(action_index, type_id, id);
            let query = `INSERT INTO mappings_actions (action_index, type_id, id) values ${placeholders}`;
            await this.doQuery(query, args);
        }
    },

    // Create records in the 'mappings_files' table
    async createFileMapping(action_index, type, value){
        let type_id = null,
            id      = null;
        if(type=='tick'){
            type_id = 1;
            id      = await this.createTicker(value);
        }
        // Same null-guard as createActionMapping: a dangling ^<id> ticker reference
        // resolves to null (0b023b2); skip the lookup-index row instead of inserting NULL
        // into the NOT-NULL id column and aborting the block. mappings_files is not
        // consensus-hashed, so this changes no block hashes.
        if(this.util.isNull(id))
            return;
        // Check if record already exists
        let query  = `SELECT
                            action_index
                        FROM
                            mappings_files
                        WHERE
                            action_index=? AND
                            type_id=? AND
                            id=?`;
        let args = [action_index, type_id, id];
        let exists = false;
        let results = await this.doQuery(query, args);
        if(results.length > 0)
            exists = true;
        // Create record if it does not already exist
        if(!exists){
            query   = `INSERT INTO mappings_files (action_index, type_id, id) values (?, ?, ?)`;
            results = await this.doQuery(query, args);
        }
    },

};
