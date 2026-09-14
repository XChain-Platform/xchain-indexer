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
 * XChain Indexer - Database class part: SQL text
 *
 * Quote-aware SQL text handling (the comment strip and the statement split) and createTable,
 * which runs one definition file statement by statement.
 *
 * A part of the Database class body: db/index.js installs it onto Database.prototype,
 * non-enumerable and in the order the class declared it, so call sites stay
 * this.db.<method>().
 *
 ********************************************************************/

// Strict, as the class body these methods came from was.
'use strict';

const fs      = require('fs');
const path    = require('path');
const { getLogger } = require('../../observability/index.js');
// Module-level state and pure helpers that the split keeps in one place, so the class
// and every mixin read the same instance of each.
const { opensBackslashEscape } = require('../shared.js');

module.exports = {

    // Handle creating database tables.
    //
    // Uses raw db.query (not doQuery) because doQuery swallows non-transactional
    // errors - a DROP TABLE that committed followed by a CREATE TABLE that
    // failed on a connection blip would leave a partial-state table missing
    // (observed on LTC regtest: `dispensers` ended up missing after a transient
    // MariaDB hiccup during init, fatal-looped the indexer on every block).
    // Retries the whole file with exponential backoff so transient DB issues
    // don't leave half-built schema.
    // Remove SQL line comments while respecting quoted strings, so a ';'
    // appearing inside comment prose is never mistaken for a statement
    // terminator. Single/double-quote and backtick spans are preserved verbatim
    // (a doubled quote escapes, and inside `'`/`"` so does a backslash - see
    // opensBackslashEscape); a `--` or `#` outside any quote or block comment
    // skips to the end of its line. Newlines are kept so error positions stay
    // meaningful.
    //
    // `#` counts because MariaDB/MySQL honour it to end-of-line exactly like
    // `--`. Missing it made a `# note` line ahead of a destructive statement
    // invisible to the ^-anchored checks in destructiveAutoStatement: the
    // chunk began with `#`, matched no keyword, scored the file auto-eligible,
    // and the server ran the DROP unattended at startup. A `;` inside a `#`
    // comment also tore the statement in two for both the classifier and the
    // apply loop.
    //
    // `/* ... */` spans are copied through verbatim rather than scanned: a `--`
    // or `#` inside one would otherwise swallow the closing `*/` and the rest of
    // that line (the server does not treat either as a comment start there), and
    // an apostrophe in block-comment prose would open a bogus quote span. The
    // verbatim copy also keeps `/*!...*/` executable-comment payloads intact for
    // destructiveAutoStatement to flag.
    stripSqlLineComments(sql){
        let out = '';
        let quote = null;
        for(let i = 0; i < sql.length; i++){
            const ch = sql[i];
            if(quote){
                out += ch;
                if(opensBackslashEscape(sql, i, quote)){ out += sql[++i]; continue; }
                if(ch === quote){
                    if(sql[i + 1] === quote){ out += sql[++i]; }
                    else { quote = null; }
                }
                continue;
            }
            if(ch === "'" || ch === '"' || ch === '`'){ quote = ch; out += ch; continue; }
            if(ch === '/' && sql[i + 1] === '*'){
                const end = sql.indexOf('*/', i + 2);
                if(end === -1){ out += sql.slice(i); break; }   // unterminated: copy the rest as-is
                out += sql.slice(i, end + 2);
                i = end + 1;
                continue;
            }
            if((ch === '-' && sql[i + 1] === '-') || ch === '#'){
                while(i < sql.length && sql[i] !== '\n'){ i++; }
                if(i < sql.length){ out += '\n'; }
                continue;
            }
            out += ch;
        }
        return out;
    },

    // Split a SQL string into individual statements on `;`, but only when the `;`
    // sits outside a quoted string. A naive `.split(';')` tears a statement whose
    // string literal contains a semicolon (e.g. `SET data = 'a;b'`) into invalid
    // fragments, so no migration or seed carrying a semicolon in quoted data can
    // ship, and destructiveAutoStatement ends up classifying fragments rather than
    // real statements. `--` and `#` line comments are stripped first (same rule as
    // the callers used); the quote model matches stripSqlLineComments exactly
    // (single/double-quote and backtick spans, doubled-quote and backslash escapes).
    // Returns trimmed, non-empty statements.
    splitSqlStatements(sql){
        const stripped = this.stripSqlLineComments(sql);
        const statements = [];
        let current = '';
        let quote = null;
        for(let i = 0; i < stripped.length; i++){
            const ch = stripped[i];
            if(quote){
                current += ch;
                if(opensBackslashEscape(stripped, i, quote)){ current += stripped[++i]; continue; }
                if(ch === quote){
                    if(stripped[i + 1] === quote){ current += stripped[++i]; }
                    else { quote = null; }
                }
                continue;
            }
            if(ch === "'" || ch === '"' || ch === '`'){ quote = ch; current += ch; continue; }
            // Block comments survive the strip (the classifier needs `/*!...*/` payloads
            // intact), so carry them across whole: an apostrophe in comment prose must not
            // open a quote span, and a ';' inside one must not terminate the statement.
            if(ch === '/' && stripped[i + 1] === '*'){
                const end = stripped.indexOf('*/', i + 2);
                if(end === -1){ current += stripped.slice(i); break; }
                current += stripped.slice(i, end + 2);
                i = end + 1;
                continue;
            }
            if(ch === ';'){ statements.push(current); current = ''; continue; }
            current += ch;
        }
        statements.push(current);
        return statements.map(s => s.trim()).filter(Boolean);
    },

    async createTable(file){
        const dir     = path.join(__dirname, '..', '..', 'sql');
        const data    = fs.readFileSync(dir + '/' + file, "utf8");
        const table   = file.substring(0, file.indexOf('.sql'));
        // Quote-aware split into statements. A ';' inside a comment (prose
        // punctuation in a header block) or inside a string literal must not be
        // treated as a statement terminator - that truncates the statement into a
        // bogus standalone query and fails schema creation (observed: a semicolon in
        // attests.sql's header split its comment, crash-looping the indexer).
        const queries = this.splitSqlStatements(data);

        const MAX_ATTEMPTS = 5;
        let lastErr = null;
        for(let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++){
            let db = null;
            try {
                db = await this.getConnection();
                for(const query of queries){
                    await db.query(query);
                }
                await db.release();
                return;
            } catch (err) {
                lastErr = err;
                if(db){
                    try { await db.release(); } catch (_){}
                }
                if(attempt >= MAX_ATTEMPTS) break;
                const backoffMs = Math.min(30000, 500 * Math.pow(2, attempt - 1));
                getLogger().info('Error creating ' + table + ' (attempt ' + attempt + '/' + MAX_ATTEMPTS + '): ', err, '. Retrying in ' + backoffMs + 'ms...');
                await this.util.sleep(backoffMs);
            }
        }
        this.util.throwError('Failed to create ' + table + ' table after ' + MAX_ATTEMPTS + ' attempts: ' + (lastErr ? lastErr.message : 'unknown'));
    },

};
