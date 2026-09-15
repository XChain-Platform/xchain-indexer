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
 * XChain Indexer - Hub DB Sync Client: mirror table creation
 *
 * ensureTables and the two quote-aware SQL helpers it needs, for consumers that
 * have no table-creation machinery of their own.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js), which installs the
 * methods here onto HubDbSync.prototype. Vendored byte-identical into
 * xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

const fs   = require('fs');
const path = require('path');
const { getLogger } = require('../../observability/index.js');

// Remove SQL `--` line comments while respecting quoted strings, so a ';'
// appearing inside comment prose is never mistaken for a statement terminator.
// Faithful copy of the indexer src/db/index.js stripSqlLineComments logic; lives here so
// ensureTables() stays self-contained in the vendored client.
function stripSqlLineComments(sql) {
    let out = '';
    let quote = null;
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        if (quote) {
            out += ch;
            if (ch === quote) {
                if (sql[i + 1] === quote) { out += sql[++i]; }
                else { quote = null; }
            }
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
        if (ch === '-' && sql[i + 1] === '-') {
            while (i < sql.length && sql[i] !== '\n') { i++; }
            if (i < sql.length) { out += '\n'; }
            continue;
        }
        out += ch;
    }
    return out;
}

// Quote-aware SQL statement splitter. Strips `--` line comments, then breaks on
// ';' only outside quoted strings, so a ';' inside a string literal never tears a
// statement into invalid fragments. Faithful copy of the indexer src/db/index.js
// splitSqlStatements logic; lives here so ensureTables() stays self-contained in
// the vendored client.
function splitSqlStatements(sql) {
    const stripped = stripSqlLineComments(sql);
    const statements = [];
    let current = '';
    let quote = null;
    for (let i = 0; i < stripped.length; i++) {
        const ch = stripped[i];
        if (quote) {
            current += ch;
            if (ch === quote) {
                if (stripped[i + 1] === quote) { current += stripped[++i]; }
                else { quote = null; }
            }
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
        if (ch === ';') { statements.push(current); current = ''; continue; }
        current += ch;
    }
    statements.push(current);
    return statements.map((s) => s.trim()).filter(Boolean);
}

// Create the mirror tables from the vendored SQL twin files in sqlDir, for
// consumers that (unlike the indexer, whose verifyTables() owns its schema)
// have no table-creation machinery of their own, e.g. the explorer's embedded
// mirror. Must complete before HubDbSync.start(): starting against a missing
// table poisons the per-table column cache (see localColumns / the 2026-06-17
// cold-start regression). dbConn is the same doQuery-bearing object the
// HubDbSync constructor takes. Retries each file with exponential backoff so a
// transient DB blip at boot doesn't leave half-built schema.
async function ensureTables(dbConn, sqlDir) {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const files = fs.readdirSync(sqlDir).filter((f) => f.endsWith('.sql')).sort();
    if (files.length === 0)
        throw new Error('ensureTables: no .sql files found in ' + sqlDir);
    const MAX_ATTEMPTS = 5;
    for (const file of files) {
        const table   = file.slice(0, -'.sql'.length);
        const data    = fs.readFileSync(path.join(sqlDir, file), 'utf8');
        const queries = splitSqlStatements(data);
        let lastErr = null;
        let done = false;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !done; attempt++) {
            try {
                // The SQL twins use bare CREATE TABLE (byte-identical to the
                // indexer originals, whose verifyTables() gates on existence
                // before running them), so gate here the same way: an existing
                // table means this file already ran and re-running would fail
                // with ER_TABLE_EXISTS_ERROR on every restart. Probed inside
                // the retry loop so a transient blip on the probe itself also
                // retries (caught live in the keyed-feed drill 2026-07-06).
                const existing = await dbConn.doQuery('SHOW TABLES LIKE ?', [table]);
                if (existing && existing.length > 0) { done = true; break; }
                for (const query of queries)
                    await dbConn.doQuery(query);
                done = true;
            } catch (err) {
                lastErr = err;
                if (attempt >= MAX_ATTEMPTS) break;
                const backoffMs = Math.min(30000, 500 * Math.pow(2, attempt - 1));
                getLogger().info('ensureTables: error creating ' + file + ' (attempt ' + attempt + '/' + MAX_ATTEMPTS + '): '
                    + (err && err.message) + '. Retrying in ' + backoffMs + 'ms...');
                await sleep(backoffMs);
            }
        }
        if (!done)
            throw new Error('ensureTables: failed to create ' + file + ' after ' + MAX_ATTEMPTS
                + ' attempts: ' + (lastErr ? lastErr.message : 'unknown'));
    }
}

module.exports = { ensureTables };
