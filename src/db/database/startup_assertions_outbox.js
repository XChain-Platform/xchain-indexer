/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * XChain Indexer - pending hub outbox startup assertion
 *
 ********************************************************************/

'use strict';

const Database = require('../index.js');

module.exports = {
    async assertPendingHubPushPayloadIsWide(){
        const remedy = ' Run the pending migration: node src/db/migration/migrate.js --file ' +
            Database.startupAssertedMigrationFile('assertPendingHubPushPayloadIsWide');
        let conn;
        try {
            conn = await this.getConnection();
            const rows = await conn.query(
                "SELECT DATA_TYPE AS data_type, CHARACTER_SET_NAME AS charset_name " +
                "FROM information_schema.columns WHERE table_schema = ? " +
                "AND table_name = 'pending_hub_pushes' AND column_name = 'payload'",
                [this.dbName]
            );
            if(!Array.isArray(rows) || !rows.length || !rows[0]) return;
            const rawType = rows[0].data_type == null ? rows[0].DATA_TYPE : rows[0].data_type;
            const rawCharset = rows[0].charset_name == null ? rows[0].CHARSET_NAME : rows[0].charset_name;
            if(rawType == null || rawCharset == null) return;
            const type = String(rawType).toLowerCase();
            const charset = String(rawCharset).toLowerCase();
            if(!['mediumtext', 'longtext'].includes(type) || charset !== 'utf8mb4'){
                throw new Error(
                    'Fatal indexer error: pending_hub_pushes.payload is ' + type + ' with ' + charset +
                    ', but MEDIUMTEXT or LONGTEXT with utf8mb4 is required; an ATTEST batch outbox ' +
                    'insert over 65,535 bytes or containing four-byte UTF-8 fails inside the block ' +
                    'transaction and stalls the indexer at that block.' + remedy
                );
            }
        } finally {
            if(conn && this.transactionConnection == null){
                try { await conn.release(); } catch(_){}
            }
        }
    },
};
