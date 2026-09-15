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
 * XChain Indexer - Database mixin: messages
 * 
 * The queries over the messages table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

module.exports = {

    // Create/Update record in `messages` table
    async createMessage(data){
        data                  = this.normalizeDataValues(data);
        let destination_id    = await this.createAddress(data['DESTINATION']);
        let status_id         = await this.createStatus(data['STATUS']);
        let action_index      = data['ACTION_INDEX'];
        let coin              = data['COIN'];
        let encryption_method = data['ENCRYPTION_METHOD'];
        let encryption_key    = data['ENCRYPTION_KEY'];
        let encrypted_message = data['ENCRYPTED_MESSAGE'];
        let plaintext_message = data['PLAINTEXT_MESSAGE'];
        // Check if record already exists for this message
        let query  = `SELECT
                            action_index
                        FROM
                            messages
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
                        messages
                    SET
                        coin=?,
                        encryption_method=?,
                        encryption_key=?,
                        encrypted_message=?,
                        plaintext_message=?,
                        destination_id=?,
                        status_id=?
                    WHERE
                        action_index=?`;
        } else {
            // INSERT record
            query = `INSERT INTO messages (coin, encryption_method, encryption_key, encrypted_message, plaintext_message, destination_id, status_id, action_index) values (?, ?, ?, ?, ?, ?, ?, ?)`;
        }
        args    = [coin, encryption_method, encryption_key, encrypted_message, plaintext_message, destination_id, status_id, action_index];
        results = await this.doQuery(query, args);
    },

};
