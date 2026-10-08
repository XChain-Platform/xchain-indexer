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
 * XChain Indexer - migration live-schema guard
 *
 * A MODIFY restates the whole column definition, so a restatement that omits an attribute
 * the live column carries silently strips it, and one that shrinks the type truncates or
 * rejects stored rows. The destructive-DDL scan cannot see either: it reads statement text,
 * not the column the statement lands on. This guard reads the live column from
 * information_schema for every MODIFY in an auto file and names each loss.
 *
 ********************************************************************/

'use strict';

const INT_RANK  = { tinyint: 1, smallint: 2, mediumint: 3, int: 4, integer: 4, bigint: 5 };
const TEXT_RANK = { tinytext: 1, text: 2, mediumtext: 3, longtext: 4 };
const BLOB_RANK = { tinyblob: 1, blob: 2, mediumblob: 3, longblob: 4 };
const CHARSET_RANK = { ascii: 1, latin1: 1, utf8: 3, utf8mb3: 3, utf8mb4: 4 };
const SIZED = new Set(['varchar', 'char', 'varbinary', 'binary']);

// Blank every quoted literal so a keyword inside a DEFAULT or COMMENT string never counts.
function blankLiterals(text){
    return text.replace(/'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|`[^`]*`/g, m => m[0] + m[0]);
}

// Split on commas outside parentheses and quotes.
function splitTopLevel(text){
    const out = [];
    let depth = 0, quote = null, cur = '';
    for(let i = 0; i < text.length; i++){
        const ch = text[i];
        if(quote){
            cur += ch;
            if(ch === '\\'){ cur += text[++i] || ''; }
            else if(ch === quote) quote = null;
            continue;
        }
        if(ch === "'" || ch === '"' || ch === '`'){ quote = ch; cur += ch; continue; }
        if(ch === '(') depth++;
        else if(ch === ')') depth--;
        if(ch === ',' && depth === 0){ out.push(cur); cur = ''; continue; }
        cur += ch;
    }
    if(cur.trim()) out.push(cur);
    return out;
}

const unquote = (id) => id.replace(/^`|`$/g, '');

function stripBlockComments(text){
    let out = '', quote = null;
    for(let i = 0; i < text.length; i++){
        const ch = text[i];
        if(quote){
            out += ch;
            if(ch === '\\') out += text[++i] || '';
            else if(ch === quote) quote = null;
            continue;
        }
        if(ch === "'" || ch === '"' || ch === '`'){ quote = ch; out += ch; continue; }
        const executable = /^(?:!|M!)/i.test(text.slice(i + 2, i + 4));
        const end = ch === '/' && text[i + 1] === '*' && !executable ? text.indexOf('*/', i + 2) : -1;
        if(end !== -1){ out += ' '; i = end + 1; continue; }
        out += ch;
    }
    return out;
}

// Every `ALTER TABLE t ... MODIFY [COLUMN] c <definition>` clause in a statement list.
function modifyClauses(statements){
    const found = [];
    for(const stmt of statements){
        const head = /^ALTER\s+(?:ONLINE\s+)?(?:IGNORE\s+)?TABLE\s+(?:IF\s+EXISTS\s+)?((?:`[^`]+`|\w+)(?:\s*\.\s*(?:`[^`]+`|\w+))?)\s+([\s\S]*)$/i.exec(stripBlockComments(stmt).trim());
        if(!head) continue;
        const table = unquote(head[1].split('.').pop().trim());
        for(const clause of splitTopLevel(head[2])){
            const m = /^\s*MODIFY\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(`[^`]+`|\w+)\s+([\s\S]+)$/i.exec(clause);
            if(!m) continue;
            const definition = m[2].replace(/\s+(?:FIRST|AFTER\s+(?:`[^`]+`|\w+))\s*$/i, '').trim();
            found.push({ table, column: unquote(m[1]), definition });
        }
    }
    return found;
}

// The data type, its arguments and unsignedness as the definition states them.
function parseType(definition){
    const m = /^\s*(\w+)\s*(?:\(([^)]*)\))?\s*(unsigned)?/i.exec(definition);
    if(!m) return null;
    return { name: m[1].toLowerCase(), args: m[2] == null ? null : m[2].trim(), unsigned: !!m[3] };
}

// The same shape from the live COLUMN_TYPE (`bigint(20) unsigned`, `enum('a','b')`).
function parseLiveType(columnType){
    return parseType(String(columnType || ''));
}

const enumValues = (args) => (args == null ? [] : splitTopLevel(args).map(s => s.trim().replace(/^'|'$/g, '')));

function declaredCharset(definition){
    const cs = /\b(?:CHARACTER\s+SET|CHARSET)\s+(\w+)/i.exec(definition);
    if(cs) return cs[1].toLowerCase();
    const co = /\bCOLLATE\s+(\w+)/i.exec(definition);
    return co ? co[1].toLowerCase().split('_')[0] : null;
}

function narrowedType(live, next){
    if(!live || !next) return null;
    if(live.name in INT_RANK && next.name in INT_RANK){
        const l = INT_RANK[live.name], n = INT_RANK[next.name];
        if(n < l) return live.name + ' -> ' + next.name;
        if(n === l && live.unsigned !== next.unsigned) return live.name + (live.unsigned ? ' unsigned' : '') + ' -> ' + next.name + (next.unsigned ? ' unsigned' : '');
        return null;
    }
    if(live.name in TEXT_RANK && next.name in TEXT_RANK) return TEXT_RANK[next.name] < TEXT_RANK[live.name] ? live.name + ' -> ' + next.name : null;
    if(live.name in BLOB_RANK && next.name in BLOB_RANK) return BLOB_RANK[next.name] < BLOB_RANK[live.name] ? live.name + ' -> ' + next.name : null;
    if(SIZED.has(live.name) && next.name === live.name){
        const l = Number(live.args), n = Number(next.args);
        return Number.isFinite(l) && Number.isFinite(n) && n < l ? live.name + '(' + l + ') -> ' + next.name + '(' + n + ')' : null;
    }
    if(live.name === 'decimal' && next.name === live.name){
        const [lp, ls = 0] = String(live.args).split(',').map(Number);
        const [np, ns = 0] = String(next.args).split(',').map(Number);
        return np - ns < lp - ls || ns < ls ? 'decimal(' + live.args + ') -> decimal(' + next.args + ')' : null;
    }
    if((live.name === 'enum' || live.name === 'set') && next.name === live.name){
        const kept = new Set(enumValues(next.args));
        const lost = enumValues(live.args).filter(v => !kept.has(v));
        return lost.length ? live.name + ' drops ' + lost.join(',') : null;
    }
    if(live.name !== next.name && (live.name in INT_RANK || live.name in TEXT_RANK || live.name in BLOB_RANK || SIZED.has(live.name))){
        const widening = (live.name in INT_RANK && ['decimal', 'bigint'].includes(next.name)) ||
                         (SIZED.has(live.name) && (next.name in TEXT_RANK || next.name in BLOB_RANK)) ||
                         (live.name in TEXT_RANK && next.name === 'longtext');
        return widening ? null : live.name + ' -> ' + next.name;
    }
    return null;
}

// Every loss one MODIFY would cause against the live column row; empty when it is safe.
function losses(live, definition){
    const out  = [];
    const bare = blankLiterals(definition);
    const extra = String(live.EXTRA || '').toLowerCase();

    if(/\bauto_increment\b/.test(extra) && !/\bAUTO_INCREMENT\b/i.test(bare)) out.push('strips AUTO_INCREMENT');
    const generated = String(live.GENERATION_EXPRESSION || '') !== '' || /\b(virtual|stored|persistent) generated\b/.test(extra);
    const liveDefault = live.COLUMN_DEFAULT;
    if(!generated && liveDefault != null && String(liveDefault).toUpperCase() !== 'NULL' && !/\bDEFAULT\b/i.test(bare)) out.push('strips DEFAULT ' + liveDefault);
    if(/\bon update\b/.test(extra) && !/\bON\s+UPDATE\b/i.test(bare)) out.push('strips ON UPDATE');
    if(String(live.COLUMN_COMMENT || '') !== '' && !/\bCOMMENT\b/i.test(bare)) out.push('strips COMMENT');
    if(generated && !/\bGENERATED\b|\bAS\s*\(/i.test(bare)) out.push('strips the generation expression');

    const narrowed = narrowedType(parseLiveType(live.COLUMN_TYPE), parseType(definition));
    if(narrowed) out.push('narrows the type (' + narrowed + ')');

    const liveSet = live.CHARACTER_SET_NAME ? String(live.CHARACTER_SET_NAME).toLowerCase() : null;
    const nextSet = declaredCharset(bare);
    if(liveSet && nextSet && nextSet !== liveSet){
        const l = CHARSET_RANK[liveSet], n = CHARSET_RANK[nextSet];
        if(l == null || n == null || n < l) out.push('changes the charset (' + liveSet + ' -> ' + nextSet + ')');
    }
    return out;
}

// Throw when an auto file's MODIFY would strip or narrow a live column. An absent live
// column (a fresh install, or one the file itself adds) is not drift and passes through.
async function assertNoLiveColumnLoss(conn, file, statements){
    for(const { table, column, definition } of modifyClauses(statements)){
        const rows = await conn.query(
            'SELECT COLUMN_TYPE, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, GENERATION_EXPRESSION, CHARACTER_SET_NAME ' +
            'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
            [table, column]
        );
        const live = Array.isArray(rows) ? rows.find(r => r && r.COLUMN_TYPE != null) : null;
        if(!live) continue;
        const found = losses(live, definition);
        if(found.length){
            throw new Error('runMigrations: ' + file + ' is tagged mode=auto but its MODIFY of ' + table + '.' + column +
                ' would damage the live column: ' + found.join('; ') + '. Restate every live attribute in the MODIFY, ' +
                'or re-tag the file `-- xchain:migration mode=manual` and apply it deliberately via `node src/db/migration/migrate.js`.');
        }
    }
}

module.exports = { assertNoLiveColumnLoss, modifyClauses, losses };
