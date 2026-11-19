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
 * Pure checks for generated-column definitions and ordered ALTER dependencies.
 ********************************************************************/

'use strict';

const { opensBackslashEscape } = require('../../shared.js');

// Unquoted MariaDB identifiers may use any character from U+0080 to U+FFFF.
const WORD = '[\\w$\\u0080-\\uFFFF]';
const IDENT = '(?:`[^`]+`|' + WORD + '+)';
const CREATE_TABLE = new RegExp('^CREATE\\s+(?:TEMPORARY\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(' +
    IDENT + '(?:\\s*\\.\\s*' + IDENT + ')?)(?=\\s|\\(|$)', 'i');
// MariaDB reserved words (every version, Oracle mode too); bare, one is never a column reference.
const RESERVED_WORDS = new Set(('accessible add all alter analyze and as asc asensitive before between bigint binary ' +
    'blob both by call cascade case change char character check collate column condition constraint continue ' +
    'conversion convert create cross current_date current_path current_role current_time current_timestamp ' +
    'current_user cursor database databases day_hour day_microsecond day_minute day_second dec decimal declare ' +
    'default delayed delete delete_domain_id desc describe deterministic distinct distinctrow div do_domain_ids ' +
    'double drop dual each else elseif enclosed escaped except exists exit explain false fetch float float4 float8 ' +
    'for force foreign from fulltext general grant group having high_priority hour_microsecond hour_minute ' +
    'hour_second if ignore ignore_domain_ids ignore_server_ids in index infile inner inout insensitive insert int ' +
    'int1 int2 int3 int4 int8 integer intersect interval into is iterate join key keys kill leading leave left like ' +
    'limit linear lines load localtime localtimestamp lock long longblob longtext loop low_priority ' +
    'master_demote_to_replica master_demote_to_slave master_heartbeat_period master_ssl_verify_server_cert match ' +
    'maxvalue mediumblob mediumint mediumtext middleint minute_microsecond minute_second mod modifies natural not ' +
    'no_write_to_binlog null numeric offset on optimize option optionally or order out outer outfile over ' +
    'page_checksum parse_vcol_expr partition portion position precision primary procedure purge range read reads ' +
    'read_write real recursive ref_system_id references regexp release rename repeat replace require resignal ' +
    'restrict return returning revoke right rlike row_number rows schema schemas second_microsecond select sensitive ' +
    'separator set show signal slow smallint spatial specific sql sql_after_gtids sql_before_gtids sqlexception ' +
    'sqlstate sqlwarning sql_big_result sql_calc_found_rows sql_small_result ssl starting stats_auto_recalc ' +
    'stats_persistent stats_sample_pages straight_join table terminated then tinyblob tinyint tinytext to to_date ' +
    'trailing trigger true undo union unique unlock unsigned update usage use using utc_date utc_time utc_timestamp ' +
    'values varbinary varchar varcharacter varying vector when where while window with write xor year_month zerofill ' +
    'body elsif goto minus others package raise rownum rowtype sysdate').split(' '));
const columnName = (value) => String(value).trim().replace(/^`|`$/g, '').toLowerCase();
const tableName = (value) => columnName(String(value).split('.').pop());

function quotedEnd(text, start){
    const quote = text[start];
    for(let i = start + 1; i < text.length; i++){
        if(opensBackslashEscape(text, i, quote)){ i++; continue; }
        if(text[i] !== quote) continue;
        if(text[i + 1] === quote){ i++; continue; }
        return i;
    }
    return -1;
}

function generationClause(definition){
    const text = String(definition);
    let depth = 0;
    for(let i = 0; i < text.length; i++){
        if(text[i] === "'" || text[i] === '"' || text[i] === '`'){
            const end = quotedEnd(text, i);
            if(end === -1) return { present: false };
            i = end;
            continue;
        }
        if(text[i] === '('){ depth++; continue; }
        if(text[i] === ')'){ depth--; continue; }
        if(depth || !/[A-Za-z_]/.test(text[i])) continue;
        const word = /^[A-Za-z_][\w$]*/.exec(text.slice(i))[0];
        if(word.toLowerCase() !== 'as'){ i += word.length - 1; continue; }
        let open = i + word.length;
        while(/\s/.test(text[open] || '')) open++;
        if(text[open] !== '('){ i += word.length - 1; continue; }
        let nested = 1;
        for(let j = open + 1; j < text.length; j++){
            if(text[j] === "'" || text[j] === '"' || text[j] === '`'){
                const end = quotedEnd(text, j);
                if(end === -1) return { present: true, unreadable: true };
                j = end;
            } else if(text[j] === '(') nested++;
            else if(text[j] === ')' && --nested === 0){
                const kind = /^\s*(VIRTUAL|STORED|PERSISTENT)\b/i.exec(text.slice(j + 1));
                return { present: true, expression: text.slice(open + 1, j),
                    kind: kind && /^(?:STORED|PERSISTENT)$/i.test(kind[1]) ? 'stored' : 'virtual' };
            }
        }
        return { present: true, unreadable: true };
    }
    return { present: false };
}

function expressionTokens(expression){
    const text = String(expression), tokens = [];
    for(let i = 0; i < text.length;){
        if(/\s/.test(text[i])){ i++; continue; }
        if(text[i] === "'" || text[i] === '"' || text[i] === '`'){
            const end = quotedEnd(text, i);
            if(end === -1) return null;
            const raw = text.slice(i, end + 1);
            tokens.push(text[i] === '`' ? 'id:' + raw.slice(1, -1).replace(/``/g, '`').toLowerCase() : 'str:' + raw);
            i = end + 1;
            continue;
        }
        // A charset introducer stays a token: _latin1'x' and _utf8mb4'x' are different values.
        const word = /^[A-Za-z_$][\w$]*/.exec(text.slice(i));
        if(word){
            const lower = word[0].toLowerCase();
            // A bare reserved word or call is never the backticked column of that name (NOT + 1, USER()).
            const calls = /^\s*\(/.test(text.slice(i + word[0].length));
            tokens.push((calls ? 'fn:' : RESERVED_WORDS.has(lower) ? 'kw:' : 'id:') + lower);
            i += word[0].length;
            continue;
        }
        const number = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(text.slice(i));
        if(number){ tokens.push('num:' + number[0].toLowerCase()); i += number[0].length; continue; }
        tokens.push(text[i++]);
    }
    if(tokens[0] === '(' && tokens[tokens.length - 1] === ')'){
        let depth = 0, wraps = true;
        for(let i = 0; i < tokens.length - 1; i++){
            if(tokens[i] === '(') depth++;
            else if(tokens[i] === ')' && --depth === 0){ wraps = false; break; }
        }
        if(wraps) return tokens.slice(1, -1);
    }
    return tokens;
}

function generationLosses(live, definition, blankLiterals){
    const out = [], extra = String(live.EXTRA || '').toLowerCase();
    const liveExpression = String(live.GENERATION_EXPRESSION || '');
    const generated = liveExpression !== '' || /\b(?:virtual|stored|persistent) generated\b/.test(extra);
    const clause = generationClause(definition);
    if(!generated){
        if(clause.present || /\bGENERATED\b|\bAS\s*\(/i.test(blankLiterals(definition)))
            out.push('turns a stored column into a generated one');
        return out;
    }
    if(!clause.present){
        if(/\bGENERATED\b|\bAS\s*\(/i.test(blankLiterals(definition))) out.push('carries a generation clause this guard cannot read');
        return out;
    }
    const liveTokens = expressionTokens(liveExpression);
    const nextTokens = clause.unreadable ? null : expressionTokens(clause.expression);
    if(!liveTokens || !nextTokens) return ['carries a generation clause this guard cannot read'];
    if(JSON.stringify(liveTokens) !== JSON.stringify(nextTokens)) out.push('changes the generation expression');
    const liveKind = /\b(?:stored|persistent) generated\b/.test(extra) ? 'stored' : 'virtual';
    if(clause.kind !== liveKind) out.push('changes the generation kind (' + liveKind + ' -> ' + clause.kind + ')');
    return out;
}

function addedColumns(clause, splitTopLevel){
    const match = /^\s*ADD\b\s*(?:COLUMN\b\s*)?(?:IF\s+NOT\s+EXISTS\s+)?([\s\S]+)$/i.exec(clause);
    if(!match || /^(?:PARTITION|PERIOD|SYSTEM)\b/i.test(match[1])) return null;
    if(/^(?:INDEX|KEY|UNIQUE|PRIMARY|FULLTEXT|SPATIAL|CONSTRAINT|FOREIGN|CHECK)\b/i.test(match[1])) return [];
    const body = match[1].trim();
    const parts = body[0] === '(' && body[body.length - 1] === ')' ? splitTopLevel(body.slice(1, -1)) : [body];
    const names = parts.map(part => new RegExp('^\\s*(' + IDENT + ')(?=\\s|$)').exec(part)).filter(Boolean).map(m => columnName(m[1]));
    return names.length === parts.length ? names : null;
}

// Alter clauses that leave every column definition as it was. Any clause not listed here
// and not read below as naming its columns marks the whole table as changed by the file.
const NEUTRAL_CLAUSE = new RegExp('^(?:ADD\\s+(?:INDEX|KEY|UNIQUE|PRIMARY|FULLTEXT|SPATIAL|CONSTRAINT|FOREIGN|CHECK)\\b|' +
    'DROP\\s+(?:INDEX|KEY|PRIMARY|FOREIGN|CONSTRAINT|CHECK)\\b|RENAME\\s+(?:INDEX|KEY)\\b|' +
    '(?:ALGORITHM|LOCK)\\b|FORCE$|COMMENT\\b|AUTO_INCREMENT\\b|(?:ENABLE|DISABLE)\\s+KEYS$)', 'i');
const ANY_TABLE = Symbol('any table');
const NAME = '(' + IDENT + ')';
const COLUMN_CLAUSES = [
    new RegExp('^MODIFY\\s+(?:COLUMN\\s+)?(?:IF\\s+EXISTS\\s+)?' + NAME + '(?=\\s|$)', 'i'),
    new RegExp('^ALTER\\s+(?:COLUMN\\s+)?(?:IF\\s+EXISTS\\s+)?' + NAME + '\\s', 'i'),
    new RegExp('^CHANGE\\s+(?:COLUMN\\s+)?(?:IF\\s+EXISTS\\s+)?' + NAME + '\\s+' + NAME, 'i'),
    new RegExp('^RENAME\\s+COLUMN\\s+(?:IF\\s+EXISTS\\s+)?' + NAME + '\\s+TO\\s+' + NAME, 'i'),
    new RegExp('^DROP\\s+(?:COLUMN\\s+)?(?:IF\\s+EXISTS\\s+)?' + NAME + '\\s*$', 'i'),
];

// The columns one alter clause changes, [] for a neutral clause, or null when it cannot tell.
function clauseColumns(clause, splitTopLevel){
    const text = clause.trim();
    if(NEUTRAL_CLAUSE.test(text)) return [];
    if(/^ADD\b/i.test(text)) return addedColumns(text, splitTopLevel);
    for(const pattern of COLUMN_CLAUSES){
        const match = pattern.exec(text);
        if(match) return match.slice(1).filter(Boolean).map(columnName);
    }
    return null;
}

function recordAlterEffects(parsed, touched, wildcard, dependencies, splitTopLevel){
    const table = tableName(parsed.table);
    if(!touched.has(table)) touched.set(table, new Set());
    for(const clause of parsed.specs){
        const modify = COLUMN_CLAUSES[0].exec(clause.trim());
        if(modify){
            const column = columnName(modify[1]);
            if(wildcard.has(table) || wildcard.has(ANY_TABLE) || touched.get(table).has(column)) dependencies.push({ table, column, earlier: 'an earlier ALTER clause' });
            touched.get(table).add(column);
            continue;
        }
        const renamed = /^RENAME\s+(?:TO\s+|AS\s+)?((?:`[^`]+`|[\w$]+)(?:\s*\.\s*(?:`[^`]+`|[\w$]+))?)\s*$/i.exec(clause.trim());
        if(renamed && !/^RENAME\s+(?:COLUMN|INDEX|KEY)\b/i.test(clause.trim())){ wildcard.add(tableName(renamed[1])); continue; }
        const columns = clauseColumns(clause, splitTopLevel);
        if(columns === null){ wildcard.add(table); continue; }
        for(const column of columns) touched.get(table).add(column);
    }
}

function intraFileColumnDependencies(statements, parsers){
    const touched = new Map(), wildcard = new Set(), created = new Set(), dependencies = [];
    for(const statement of statements){
        const text = parsers.stripBlockComments(statement).trim();
        const create = CREATE_TABLE.exec(text);
        if(create){ created.add(tableName(create[1])); continue; }
        if(/^CREATE\s+(?:TEMPORARY\s+)?TABLE\b/i.test(text)){ wildcard.add(ANY_TABLE); continue; }
        const parsed = parsers.alterSpecs(statement);
        if(!parsed){ if(/^ALTER\b/i.test(text)) wildcard.add(ANY_TABLE); continue; }
        const before = dependencies.length;
        recordAlterEffects(parsed, touched, wildcard, dependencies, parsers.splitTopLevel);
        if(created.has(tableName(parsed.table))){
            for(const item of dependencies.slice(before)) item.earlier = 'an earlier CREATE TABLE';
            for(const clause of parsed.specs){
                const modify = COLUMN_CLAUSES[0].exec(clause.trim());
                if(modify && !dependencies.slice(before).some(item => item.column === columnName(modify[1])))
                    dependencies.push({ table: tableName(parsed.table), column: columnName(modify[1]), earlier: 'an earlier CREATE TABLE' });
            }
        }
    }
    return dependencies;
}

// Name, literal and punctuation tokens of a statement, or null on an unterminated quote.
function statementTokens(statement){
    const text = String(statement), tokens = [];
    for(let i = 0; i < text.length;){
        if(/\s/.test(text[i])){ i++; continue; }
        if(text[i] === "'" || text[i] === '"' || text[i] === '`'){
            const end = quotedEnd(text, i);
            if(end === -1) return null;
            tokens.push(text[i] === '`' ? { name: true } : { literal: true });
            i = end + 1;
            continue;
        }
        const word = new RegExp('^' + WORD + '+').exec(text.slice(i));
        if(word){ tokens.push({ name: !/^\d+$/.test(word[0]), word: word[0].toUpperCase() }); i += word[0].length; continue; }
        tokens.push({ punct: text[i++] });
    }
    return tokens;
}

const qualifiedAt = (tokens, i) => Boolean(tokens[i] && tokens[i].name && tokens[i + 1] &&
    tokens[i + 1].punct === '.' && tokens[i + 2] && tokens[i + 2].name);

function skipWords(tokens, i, words){
    while(tokens[i] && words.includes(tokens[i].word)) i++;
    return i;
}

// A target this scan can prove local: one name token with no dot after it.
const bareAt = (tokens, i) => Boolean(tokens[i] && tokens[i].name && !(tokens[i + 1] && tokens[i + 1].punct === '.'));

// True for a qualified name in the top-level span from i up to the stop word, or, with stop
// ON, unless the table after the first top-level ON is bare.
function qualifiedBefore(tokens, i, stop){
    for(let depth = 0; i < tokens.length; i++){
        if(tokens[i].punct === '(') depth++;
        else if(tokens[i].punct === ')') depth--;
        else if(!depth && tokens[i].word === stop) return stop === 'ON' ? !bareAt(tokens, i + 1) : false;
        else if(!depth && stop !== 'ON' && qualifiedAt(tokens, i)) return true;
    }
    return stop === 'ON';
}

// True unless an allow-listed auto statement's write target is provably a bare local table:
// a qualified target, a target this scan cannot place, or an unterminated quote all count.
function qualifiedWriteTarget(statement){
    const tokens = statementTokens(statement);
    if(!tokens) return true;
    const head = tokens[0] && tokens[0].word;
    if(head === 'ALTER' || head === 'CREATE'){
        const i = skipWords(tokens, 1, ['ONLINE', 'IGNORE', 'OR', 'REPLACE', 'TEMPORARY', 'UNIQUE', 'FULLTEXT', 'SPATIAL']);
        if(tokens[i] && tokens[i].word === 'INDEX') return qualifiedBefore(tokens, i + 1, 'ON');
        return Boolean(tokens[i] && tokens[i].word === 'TABLE') && !bareAt(tokens, skipWords(tokens, i + 1, ['IF', 'NOT', 'EXISTS']));
    }
    if(head === 'DROP'){
        if(tokens[1] && tokens[1].word === 'INDEX') return qualifiedBefore(tokens, 2, 'ON');
        return tokens.some((token, i) => qualifiedAt(tokens, i));
    }
    if(head === 'UPDATE'){
        const i = skipWords(tokens, 1, ['LOW_PRIORITY', 'IGNORE']);
        return !bareAt(tokens, i) || qualifiedBefore(tokens, i, 'SET');
    }
    if(head === 'INSERT' || head === 'REPLACE')
        return !bareAt(tokens, skipWords(tokens, 1, ['LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY', 'IGNORE', 'INTO']));
    return false;
}

module.exports = { generationLosses, intraFileColumnDependencies, qualifiedWriteTarget };
