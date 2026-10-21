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
 * XChain Indexer - migration declared-key drop guard
 *
 * Dropping an index loses no row data, but dropping a key src/sql still declares
 * UNIQUE or PRIMARY lets key-dependent writers add duplicate rows until a later boot
 * re-adds it. This guard refuses such a drop in a mode=auto file unless the same file
 * re-creates the key under the same name and kind. The indexer and decoder copies match.
 *
 ********************************************************************/

'use strict';

const { alterSpecs, stripBlockComments } = require('../migration_live_schema_guard.js');

const IDENT = '(`[^`]+`|[A-Za-z_$][\\w$]*)';
const QUALIFIED = '((?:`[^`]+`|[\\w$]+)(?:\\s*\\.\\s*(?:`[^`]+`|[\\w$]+))?)';
const STANDALONE_DROP = new RegExp('^DROP\\s+(?:(?:ONLINE|OFFLINE)\\s+)?INDEX\\s+(?:IF\\s+EXISTS\\s+)?' + IDENT + '\\s+ON\\s+' + QUALIFIED, 'i');
const STANDALONE_UNIQUE = new RegExp('^CREATE\\s+UNIQUE\\s+INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?' + IDENT + '\\s+ON\\s+' + QUALIFIED, 'i');
const SPEC_DROP_KEY = new RegExp('^DROP\\s+(?:INDEX|KEY|CONSTRAINT)\\s+(?:IF\\s+EXISTS\\s+)?' + IDENT, 'i');
const UNIQUE_KEY = new RegExp('^(?:CONSTRAINT\\s+' + IDENT + '\\s+)?UNIQUE\\b(?:\\s+(?:INDEX|KEY))?(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s*(?:' + IDENT + '\\s*)?(?:USING\\s+\\w+\\s*)?\\(\\s*' + IDENT, 'i');
const PRIMARY_KEY = new RegExp('^(?:CONSTRAINT(?:\\s+' + IDENT + ')?\\s+)?PRIMARY\\s+KEY\\b', 'i');

// Lower-case, unquoted identifier, and the bare table name of a db-qualified one.
const ident = (name) => String(name).trim().replace(/^`|`$/g, '').toLowerCase();
const tableOf = (qualified) => ident(String(qualified).split('.').pop());

// Blank each quoted string to an empty pair, keeping backtick identifiers, so no value reads as SQL.
const blankStrings = (text) => text.replace(/'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"/g, m => m[0] + m[0]);

// Statement text the drop and re-create patterns read: comments gone, strings blanked.
const syntax = (stmt) => blankStrings(stripBlockComments(String(stmt))).trim();

// The top-level comma-separated parts of a parenthesised list, quote- and paren-aware.
function topLevelParts(body){
    const out = [];
    let depth = 0, quote = null, cur = '';
    for(const ch of body){
        if(quote){ cur += ch; if(ch === quote) quote = null; continue; }
        if(ch === "'" || ch === '"' || ch === '`'){ quote = ch; cur += ch; continue; }
        if(ch === '(') depth++;
        else if(ch === ')') depth--;
        if(ch === ',' && depth === 0){ out.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    if(cur.trim()) out.push(cur.trim());
    return out;
}

// The body between the parentheses of `CREATE TABLE <table> (...)`, or null when absent.
function createTableBody(sql, table){
    const head = new RegExp('CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?' + QUALIFIED + '\\s*\\(', 'ig');
    let m;
    while((m = head.exec(sql)) !== null){
        if(tableOf(m[1]) !== table) continue;
        let depth = 1, i = head.lastIndex;
        for(; i < sql.length && depth > 0; i++){
            if(sql[i] === '(') depth++;
            else if(sql[i] === ')') depth--;
        }
        return depth === 0 ? sql.slice(head.lastIndex, i - 1) : null;
    }
    return null;
}

// The UNIQUE or PRIMARY key a definition re-creates, as { name, kind }, or null.
function keyDefinition(def){
    const text = def.replace(/^ADD\s+/i, '').trim();
    if(PRIMARY_KEY.test(text)) return { name: 'primary', kind: 'PRIMARY' };
    const u = UNIQUE_KEY.exec(text);
    if(u) return { name: ident(u[2] || u[1] || u[3]), kind: 'UNIQUE' };
    return null;
}

// Every key a table's src/sql text declares UNIQUE or PRIMARY, as a Map of name to kind.
// An unnamed inline UNIQUE takes its first column's name, which is the live name the engine gives it.
function declaredKeys(sql, table){
    const keys = new Map();
    if(!sql) return keys;
    const text = blankStrings(stripBlockComments(String(sql).replace(/--[^\n]*/g, '')));
    const body = createTableBody(text, table);
    for(const part of body ? topLevelParts(body) : []){
        const key = keyDefinition(part);
        if(key){ keys.set(key.name, key.kind); continue; }
        if(/^(?:KEY|INDEX|FULLTEXT|SPATIAL|CONSTRAINT|FOREIGN|CHECK)\b/i.test(part)) continue;
        const column = /^(`[^`]+`|[\w$]+)/.exec(part);
        if(!column) continue;
        if(/\bPRIMARY\s+KEY\b/i.test(part)) keys.set('primary', 'PRIMARY');
        else if(/\bUNIQUE\b/i.test(part)) keys.set(ident(column[1]), 'UNIQUE');
    }
    for(const stmt of text.split(';')){
        const m = STANDALONE_UNIQUE.exec(stmt.trim());
        if(m && tableOf(m[2]) === table) keys.set(ident(m[1]), 'UNIQUE');
    }
    return keys;
}

// The key drops and UNIQUE/PRIMARY re-creates of one statement, in statement order.
function keyEvents(stmt){
    const text = syntax(stmt);
    const drop = STANDALONE_DROP.exec(text);
    if(drop) return [{ op: 'drop', table: tableOf(drop[2]), name: ident(drop[1]) }];
    const create = STANDALONE_UNIQUE.exec(text);
    if(create) return [{ op: 'add', table: tableOf(create[2]), name: ident(create[1]), kind: 'UNIQUE' }];
    if(/^DROP\s+(?:(?:ONLINE|OFFLINE)\s+)?INDEX\b/i.test(text)) return [{ op: 'unread', text }];
    if(!/^ALTER\b/i.test(text)) return [];
    const parsed = alterSpecs(text);
    if(!parsed) return /\bDROP\s+(?:INDEX|KEY|PRIMARY|CONSTRAINT)\b/i.test(text) ? [{ op: 'unread', text }] : [];
    const table = ident(parsed.table);
    const events = [];
    for(const raw of parsed.specs){
        const spec = raw.trim();
        if(/^DROP\s+PRIMARY\s+KEY\b/i.test(spec)){ events.push({ op: 'drop', table, name: 'primary' }); continue; }
        const dropped = SPEC_DROP_KEY.exec(spec);
        if(dropped){ events.push({ op: 'drop', table, name: ident(dropped[1]) }); continue; }
        if(/^DROP\s+(?:INDEX|KEY|PRIMARY|CONSTRAINT)\b/i.test(spec)){ events.push({ op: 'unread', text: spec }); continue; }
        const added = /^ADD\b/i.test(spec) ? keyDefinition(spec) : null;
        if(added) events.push({ op: 'add', table, name: added.name, kind: added.kind });
    }
    return events;
}

// Refuse a mode=auto file that drops a key src/sql still declares UNIQUE or PRIMARY, unless a
// later clause or statement of the same file re-creates it under the same name and kind.
// Names and kinds are compared, never columns: src/sql holds today's declaration, and an older
// pending file was written against an earlier one. sqlFor(table) returns the src/sql text or null.
function assertNoDeclaredKeyDrop(file, statements, sqlFor){
    const declaredByTable = new Map();
    const declared = (table) => {
        if(!declaredByTable.has(table)) declaredByTable.set(table, declaredKeys(sqlFor(table), table));
        return declaredByTable.get(table);
    };
    const open = new Map();
    for(const stmt of statements || []){
        for(const ev of keyEvents(stmt)){
            if(ev.op === 'unread'){
                throw new Error('runMigrations: ' + file + ' is tagged mode=auto but drops a key this guard cannot read: "' +
                    ev.text.slice(0, 120) + '". Re-tag the file mode=manual and apply it deliberately.');
            }
            const kind = declared(ev.table).get(ev.name);
            const key = ev.table + '.' + ev.name;
            if(ev.op === 'drop' && kind) open.set(key, { table: ev.table, name: ev.name, kind });
            else if(ev.op === 'add' && open.has(key) && open.get(key).kind === ev.kind) open.delete(key);
        }
    }
    for(const k of open.values()){
        throw new Error('runMigrations: ' + file + ' is tagged mode=auto but drops ' + k.kind + ' key ' + k.name +
            ' on ' + k.table + ', which src/sql/' + k.table + '.sql still declares. Re-create it in the same file, ' +
            'update src/sql/' + k.table + '.sql in the same change, or re-tag the file mode=manual and apply it deliberately.');
    }
}

module.exports = { assertNoDeclaredKeyDrop,};
