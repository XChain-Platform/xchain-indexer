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
 * XChain Indexer - Database mixin part: transactions (action data)
 *
 * The one-row summary of an action, read with the statement its action type names.
 * A part of the transactions mixin: src/db/transactions/index.js merges it into the one method
 * set that db/index.js installs onto Database.prototype, so call sites stay
 * this.db.<method>().
 *
 ********************************************************************/

const recordStatements = require('./action_sql_records.js');
const tokenStatements  = require('./action_sql_tokens.js');
const tradeStatements  = require('./action_sql_trades.js');

// Every action type's summary statement, keyed by action name. A null prototype, so a type
// string that names an Object.prototype member ('constructor', 'toString') finds no
// statement and getActionData returns null for it, the same as for any unlisted type.
const ACTION_DATA_SQL = Object.assign(Object.create(null), recordStatements, tokenStatements, tradeStatements);

module.exports = {

    // Get action information for a given action_index
    async getActionData(action_index){
        let data = null;
        let sql  = null;
        let type = await this.getActionType(action_index);
        if(type){
            // Placeholders for queries and arguments
            sql = ACTION_DATA_SQL[type] || null;
            // Run the SQL query to get the information on the action_index
            if(sql){
                let results = await this.doQuery(sql, [action_index]);
                if(results && results.length)
                    data = results[0];
            }
        }
        return data;
    },

};
