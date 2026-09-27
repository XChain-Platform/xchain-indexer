/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * Retype the migration ledger timestamp without wiring database methods.
 *
 ********************************************************************/

'use strict';

const COLUMN_TYPE_SQL = "SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations' AND COLUMN_NAME = 'applied_at'";
const RETYPE_SQL = 'ALTER TABLE schema_migrations MODIFY applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP';

async function retypeLedgerAppliedAt(conn){
    const rows = await conn.query(COLUMN_TYPE_SQL);
    const row = rows && rows[0];
    const dataType = row && (row.DATA_TYPE ?? row.data_type);
    if(String(dataType || '').toLowerCase() !== 'timestamp') return false;
    await conn.query(RETYPE_SQL);
    return true;
}

module.exports = { retypeLedgerAppliedAt };
