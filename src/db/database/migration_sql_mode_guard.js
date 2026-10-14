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
 * XChain Indexer - migration session sql_mode guard
 *
 * The auto-apply classifier relies on strict mode (a narrowing write fails instead of
 * clamping) and the migration quote walkers on backslash escapes (opensBackslashEscape).
 * The pool only requests that mode through initSql, so this reads back what the server
 * reports on the connection that will run the files and refuses any other mode.
 *
 ********************************************************************/

'use strict';

const { SESSION_SQL_MODE, sqlModeAllowsBackslashEscapes } = require('../shared.js');

// True when a reported sql_mode carries a strict-mode flag.
function sqlModeIsStrict(mode){
    return String(mode || '').split(',').some(f => /^STRICT_(?:TRANS|ALL)_TABLES$/i.test(f.trim()));
}

// Throw before any migration work when conn's session is lax or carries NO_BACKSLASH_ESCAPES.
// An empty or unreadable answer throws too: '' is a real, lax sql_mode. onRefuse runs first,
// so the caller can retire the connection instead of returning it to the pool.
async function assertMigrationSqlMode(conn, onRefuse){
    const rows = await conn.query('SELECT @@SESSION.sql_mode AS mode');
    const mode = Array.isArray(rows) && rows[0] && rows[0].mode != null ? String(rows[0].mode) : '';
    if(sqlModeIsStrict(mode) && sqlModeAllowsBackslashEscapes(mode)) return;
    if(onRefuse) onRefuse();
    throw new Error("runMigrations: the migration session runs sql_mode '" + mode + "', but it must be strict and must not " +
        "carry NO_BACKSLASH_ESCAPES (the pool pins '" + SESSION_SQL_MODE + "'). Under a lax mode a narrowing auto migration " +
        'truncates silently instead of failing, and NO_BACKSLASH_ESCAPES breaks the migration quote walkers. The pool pins ' +
        'the mode on every new connection, so something between the indexer and MariaDB (a proxy or a server-side override) changed it.');
}

module.exports = { assertMigrationSqlMode, sqlModeIsStrict };
