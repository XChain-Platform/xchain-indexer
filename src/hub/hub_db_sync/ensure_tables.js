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

// The indexes a twin file declares: inline `KEY name (cols)` / `UNIQUE KEY name (cols)`
// lines inside the CREATE TABLE block plus standalone `CREATE [UNIQUE] INDEX name ON
// table (cols)`. Column names are lowercased with prefix widths stripped for the live
// comparison; `cols` keeps the declared text for the ADD. PRIMARY KEY and FULLTEXT are
// left to the CREATE TABLE that made the table.
function parseDeclaredIndexes(sql, table) {
    const stripped = stripSqlLineComments(sql);
    const declared = [];
    const seen = new Set();
    const push = (unique, name, colsText) => {
        const key = name.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        const columns = colsText.split(',').map((c) => c.trim().replace(/`/g, '').replace(/\(.*$/, '').toLowerCase()).filter(Boolean);
        declared.push({ unique, name, columns, cols: colsText.trim() });
    };
    // The column list runs to the paren that balances the opener, so a prefix width such
    // as `addr(62)` inside it is kept whole.
    const balanced = (from) => {
        let depth = 0;
        for (let i = from; i < stripped.length; i++) {
            if (stripped[i] === '(') depth++;
            else if (stripped[i] === ')' && --depth === 0) return stripped.slice(from + 1, i);
        }
        return null;
    };
    const scan = (re, uniqueGroup, nameGroup) => {
        let m;
        while ((m = re.exec(stripped)) !== null) {
            const colsText = balanced(m.index + m[0].length - 1);
            if (colsText !== null) push(Boolean(m[uniqueGroup]), m[nameGroup], colsText);
        }
    };
    scan(/^\s*(UNIQUE\s+)?(?:KEY|INDEX)\s+`?([A-Za-z0-9_]+)`?\s*\(/gim, 1, 2);
    scan(new RegExp('CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?`?([A-Za-z0-9_]+)`?\\s+ON\\s+`?' + table + '`?\\s*\\(', 'gi'), 1, 2);
    return declared;
}

// Add to an EXISTING mirror table every index its twin file declares that the live table
// lacks. ensureTables gates on table existence, so a KEY added to a twin after the mirror
// was first built (idx_status_timestamp_round on price_snapshots, 2026-09-06) otherwise
// never reaches a deployed consumer: the barrier reads that lead on it fell back to a
// full scan of a million-row mirror on every poll (measured 2026-09-23 on the regtest
// rail, 2 s per read per indexer). Satisfied by name OR by ordered column set, never
// DROPs, and every failure is logged and skipped: an index is a speed matter and must
// never crash-loop the consumer that is applying rows.
async function reconcileDeclaredIndexes(dbConn, table, data) {
    const declared = parseDeclaredIndexes(data, table);
    if (declared.length === 0) return;
    const rows = await dbConn.doQuery(
        'SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.statistics '
        + 'WHERE table_schema = DATABASE() AND table_name = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX', [table]);
    const liveByName = new Map();
    for (const r of rows || []) {
        const name = String(r.INDEX_NAME);
        if (!liveByName.has(name)) liveByName.set(name, { unique: Number(r.NON_UNIQUE) === 0, columns: [] });
        liveByName.get(name).columns.push(String(r.COLUMN_NAME).toLowerCase());
    }
    const liveNames  = new Set([...liveByName.keys()].map((n) => n.toLowerCase()));
    const liveByCols = new Map([...liveByName.values()].map((i) => [i.columns.join(','), i]));
    for (const idx of declared) {
        if (liveNames.has(idx.name.toLowerCase())) continue;
        const live = liveByCols.get(idx.columns.join(','));
        if (live && (!idx.unique || live.unique)) continue;
        const ddl = 'ALTER TABLE `' + table + '` ADD ' + (idx.unique ? 'UNIQUE ' : '') + 'INDEX `' + idx.name + '` (' + idx.cols + ')';
        try {
            await dbConn.doQuery(ddl);
            getLogger().info('ensureTables: added missing index ' + idx.name + ' (' + idx.columns.join(',') + ') on mirror table ' + table);
        } catch (err) {
            getLogger().warn('ensureTables: could not add index ' + idx.name + ' on mirror table ' + table
                + ' (' + (err && err.message) + '); continuing without it');
        }
    }
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
                if (existing && existing.length > 0) {
                    // An existing table skipped the CREATE, so its index set is whatever
                    // the twin declared when it was first built; converge it now.
                    await reconcileDeclaredIndexes(dbConn, table, data);
                    done = true;
                    break;
                }
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

module.exports = { ensureTables, parseDeclaredIndexes, reconcileDeclaredIndexes };
