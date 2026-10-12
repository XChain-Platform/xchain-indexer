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
 * information_schema for every MODIFY in an auto file and names each loss. A type change
 * it has no widening rule for counts as a loss, and a text MODIFY that names no charset
 * or collation is compared against the table default the server would fall back to.
 *
 ********************************************************************/

'use strict';

const { opensBackslashEscape } = require('../shared.js');

const INT_RANK  = { tinyint: 1, smallint: 2, mediumint: 3, int: 4, integer: 4, bigint: 5 };
const TEXT_RANK = { tinytext: 1, text: 2, mediumtext: 3, longtext: 4 };
const BLOB_RANK = { tinyblob: 1, blob: 2, mediumblob: 3, longblob: 4 };
const CHARSET_RANK = { ascii: 1, latin1: 1, utf8: 3, utf8mb3: 3, utf8mb4: 4 };
const SIZED = new Set(['varchar', 'char', 'varbinary', 'binary']);
// Decimal digits each integer type needs to hold its whole range, signed then unsigned.
const INT_DIGITS = { tinyint: [3, 3], smallint: [5, 5], mediumint: [7, 8], int: [10, 10], integer: [10, 10], bigint: [19, 20] };
// Spellings the server stores under another name (JSON is reported as longtext).
const TYPE_ALIAS = { integer: 'int', numeric: 'decimal', dec: 'decimal', fixed: 'decimal', real: 'double',
    bool: 'tinyint', boolean: 'tinyint', json: 'longtext' };
const FSP_TYPES = new Set(['datetime', 'timestamp', 'time']);
const TEXTUAL = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set']);

// Blank every quoted literal so a keyword inside a DEFAULT or COMMENT string never counts.
function blankLiterals(text){
    return text.replace(/'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|`[^`]*`/g, m => m[0] + m[0]);
}

// Split on commas outside parentheses and quotes. The quote model is splitSqlStatements'
// (doubled quotes, no backslash escape inside backticks), so both read the same spans.
function splitTopLevel(text){
    const out = [];
    let depth = 0, quote = null, cur = '';
    for(let i = 0; i < text.length; i++){
        const ch = text[i];
        if(quote){
            cur += ch;
            if(opensBackslashEscape(text, i, quote)){ cur += text[++i]; }
            else if(ch === quote){
                if(text[i + 1] === quote){ cur += text[++i]; }
                else { quote = null; }
            }
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

// Replace each block comment outside a quoted literal with a space, so a comment can neither
// hide a clause nor stand in for a restated attribute. The quote model is splitSqlStatements'
// (a regex strip would delete real SQL between a '/*' literal and a later '*/' literal).
// Executable `/*!` and `/*M!` comments stay: the server runs them, and the destructive-DDL
// scan already refuses them. An unterminated `/*` is kept as written, as the splitter does.
function stripBlockComments(text){
    text = String(text);
    let out = '', quote = null;
    for(let i = 0; i < text.length; i++){
        const ch = text[i];
        if(quote){
            out += ch;
            if(opensBackslashEscape(text, i, quote)){ out += text[++i]; }
            else if(ch === quote){
                if(text[i + 1] === quote){ out += text[++i]; }
                else { quote = null; }
            }
            continue;
        }
        if(ch === "'" || ch === '"' || ch === '`'){ quote = ch; out += ch; continue; }
        const executable = /^(?:!|M!)/i.test(text.slice(i + 2, i + 4));
        if(ch === '/' && text[i + 1] === '*' && !executable){
            const end = text.indexOf('*/', i + 2);
            if(end === -1){ out += text.slice(i); break; }
            out += ' ';
            i = end + 1;
            continue;
        }
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

// The type under the name the server stores it as.
const canonicalType = (t) => Object.assign({}, t, { name: TYPE_ALIAS[t.name] || t.name });

// DECIMAL(p,s) with the server's defaults filled in: bare DECIMAL is (10,0), DECIMAL(p) is (p,0).
function decimalArgs(args){
    if(args == null) return [10, 0];
    const [p, s = 0] = String(args).split(',').map(Number);
    return [p, s];
}

// Fractional-second digits of a datetime, timestamp or time type; absent means 0.
const fsp = (args) => (args == null ? 0 : Number(args));

const shownType = (t) => t.name + (t.args == null ? '' : '(' + t.args + ')') + (t.unsigned ? ' unsigned' : '');

// A change of type name the server applies without losing a stored value. Everything else
// counts as a loss, so a type this table does not know fails closed instead of passing.
function widensAcross(live, next){
    if(live.name in INT_DIGITS && next.name === 'decimal'){
        const [p, s] = decimalArgs(next.args);
        return p - s >= INT_DIGITS[live.name][live.unsigned ? 1 : 0] && !(next.unsigned && !live.unsigned);
    }
    if(SIZED.has(live.name)) return TEXT_RANK[next.name] > 1 || BLOB_RANK[next.name] > 1;
    if(live.name === 'timestamp' && next.name === 'datetime') return fsp(next.args) >= fsp(live.args);
    if(live.name === 'date' && next.name === 'datetime') return true;
    return live.name === 'float' && next.name === 'double' && next.args == null && !next.unsigned;
}

// The loss when a type keeps its name but its precision, fractional seconds or width shrink.
function narrowedPrecision(live, next){
    if(live.name === 'decimal'){
        const [lp, ls] = decimalArgs(live.args), [np, ns] = decimalArgs(next.args);
        const lost = np - ns < lp - ls || ns < ls || (next.unsigned && !live.unsigned);
        return lost ? 'decimal(' + lp + ',' + ls + ') -> decimal(' + np + ',' + ns + ')' + (next.unsigned ? ' unsigned' : '') : null;
    }
    if(FSP_TYPES.has(live.name)) return fsp(next.args) < fsp(live.args) ? shownType(live) + ' -> ' + shownType(next) : null;
    if(live.name === 'bit') return Number(next.args || 1) < Number(live.args || 1) ? shownType(live) + ' -> ' + shownType(next) : null;
    if(live.name === 'float' || live.name === 'double'){
        const sign = next.unsigned && !live.unsigned;
        if(next.args == null) return sign ? shownType(live) + ' -> ' + shownType(next) : null;
        if(live.args == null) return shownType(live) + ' -> ' + shownType(next);
        const [lm, ld = 0] = String(live.args).split(',').map(Number), [nm, nd = 0] = String(next.args).split(',').map(Number);
        return sign || nm - nd < lm - ld || nd < ld ? shownType(live) + ' -> ' + shownType(next) : null;
    }
    return null;
}

function narrowedType(rawLive, rawNext){
    if(!rawLive || !rawNext) return null;
    const live = canonicalType(rawLive), next = canonicalType(rawNext);
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
    if((live.name === 'enum' || live.name === 'set') && next.name === live.name){
        const kept = new Set(enumValues(next.args));
        const lost = enumValues(live.args).filter(v => !kept.has(v));
        return lost.length ? live.name + ' drops ' + lost.join(',') : null;
    }
    if(live.name === next.name) return narrowedPrecision(live, next);
    if(widensAcross(live, next)) return null;
    const familiar = live.name in INT_RANK || live.name in TEXT_RANK || live.name in BLOB_RANK || SIZED.has(live.name);
    return familiar ? live.name + ' -> ' + next.name : shownType(live) + ' -> ' + shownType(next);
}

// A collation name as the server compares it: MariaDB 10.6+ reports utf8 as utf8mb3.
const collationKey = (name) => (name == null || name === '' ? null : String(name).toLowerCase().replace(/^utf8_/, 'utf8mb3_'));

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
    // A text MODIFY naming neither CHARACTER SET nor COLLATE takes the table's default collation,
    // so a column widened apart from its table (utf8mb4 in a utf8mb3 table) silently reverts.
    const nextType = parseType(definition);
    const liveCollation = collationKey(live.COLLATION_NAME), tableCollation = collationKey(live.TABLE_COLLATION);
    if(liveSet && !nextSet && nextType && TEXTUAL.has(nextType.name) && liveCollation && tableCollation &&
       liveCollation !== tableCollation){
        const what = liveCollation.split('_')[0] === tableCollation.split('_')[0] ? 'omits COLLATE' : 'omits CHARACTER SET';
        out.push(what + ' (' + liveCollation + ' -> table default ' + tableCollation + ')');
    }
    return out;
}

// Throw when an auto file's MODIFY would strip or narrow a live column. An absent live
// column (a fresh install, or one the file itself adds) is not drift and passes through.
async function assertNoLiveColumnLoss(conn, file, statements){
    for(const { table, column, definition } of modifyClauses(statements)){
        const rows = await conn.query(
            'SELECT COLUMN_TYPE, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, GENERATION_EXPRESSION, CHARACTER_SET_NAME, ' +
            'COLLATION_NAME, TABLE_COLLATION FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ' +
            'ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME ' +
            'WHERE c.TABLE_SCHEMA = DATABASE() AND t.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = ? AND c.COLUMN_NAME = ?',
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

module.exports = { assertNoLiveColumnLoss, modifyClauses, losses, stripBlockComments };
