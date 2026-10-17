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
 * XChain Indexer - migration unique-key witness guard
 *
 * Key-dependent writes change meaning when a declared UNIQUE index has not yet
 * reached an aged database. This guard verifies the ordered live key before an
 * automatic migration can use INSERT IGNORE, ON DUPLICATE KEY UPDATE or REPLACE.
 *
 ********************************************************************/

'use strict';

const { stripBlockComments, blankLiterals } = require('../migration_live_schema_guard.js');

const IDENT = '(?:`[^`]+`|[A-Za-z_$][\\w$]*)';
const QUALIFIED_IDENT = IDENT + '(?:\\s*\\.\\s*' + IDENT + ')?';
const INSERT_HEAD = new RegExp('^\\s*INSERT\\s+((?:(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY|IGNORE)\\s+)*)(?:INTO\\s+)?(' + QUALIFIED_IDENT + ')\\b', 'i');
const REPLACE_HEAD = new RegExp('^\\s*REPLACE\\s+(?:(?:LOW_PRIORITY|DELAYED)\\s+)*(?:INTO\\s+)?(' + QUALIFIED_IDENT + ')\\b', 'i');
const CREATE_HEAD = new RegExp('^\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:TEMPORARY\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(' + QUALIFIED_IDENT + ')\\b', 'i');

const unquote = (name) => String(name).trim().replace(/^`|`$/g, '');
const tableName = (qualified, identifiers) => {
    const name = unquote(String(qualified).split('.').pop());
    return String(identifiers.get(name) || name).toLowerCase();
};

// The shared literal helper deliberately follows the runner's quote model. Backtick
// identifiers are tokenized first, then string literals are blanked so keywords inside
// values cannot become migration operations.
function syntaxText(statement){
    const identifiers = new Map();
    let source = stripBlockComments(String(statement));
    source = source.replace(/`([^`]*)`/g, (_match, name) => {
        let token = '$keyWitnessQuoted' + identifiers.size + 'x';
        while(source.includes(token)) token = '$' + token;
        identifiers.set(token, name);
        return token;
    });
    const text = blankLiterals(source).replace(/'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"/g,
        value => ' '.repeat(value.length));
    return { text, identifiers };
}

function keyDependentTarget(statement){
    const { text, identifiers } = syntaxText(statement);
    const insert = INSERT_HEAD.exec(text);
    if(insert){
        const modifiers = insert[1] || '';
        if(/\bIGNORE\b/i.test(modifiers) || /\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i.test(text))
            return tableName(insert[2], identifiers);
    }
    const replace = REPLACE_HEAD.exec(text);
    return replace ? tableName(replace[1], identifiers) : null;
}

function createdTarget(statement){
    const { text, identifiers } = syntaxText(statement);
    const found = CREATE_HEAD.exec(text);
    return found ? tableName(found[1], identifiers) : null;
}

function keyDependentTargets(statements){
    const out = [];
    const seen = new Set();
    for(const statement of statements || []){
        const target = keyDependentTarget(statement);
        const key = target && target.toLowerCase();
        if(target && !seen.has(key)){
            seen.add(key);
            out.push(target);
        }
    }
    return out;
}

function targetsNeedingWitness(statements){
    const created = new Set();
    const targets = [];
    const seen = new Set();
    for(const statement of statements || []){
        const made = createdTarget(statement);
        if(made) created.add(made.toLowerCase());
        const target = keyDependentTarget(statement);
        const key = target && target.toLowerCase();
        if(target && !created.has(key) && !seen.has(key)){
            seen.add(key);
            targets.push(target);
        }
    }
    return targets;
}

function liveUniqueColumnSets(rows){
    const indexes = new Map();
    for(const row of Array.isArray(rows) ? rows : []){
        const name = row.INDEX_NAME == null ? row.index_name : row.INDEX_NAME;
        const column = row.COLUMN_NAME == null ? row.column_name : row.COLUMN_NAME;
        const nonUnique = row.NON_UNIQUE == null ? row.non_unique : row.NON_UNIQUE;
        const seq = row.SEQ_IN_INDEX == null ? row.seq_in_index : row.SEQ_IN_INDEX;
        if(name == null || column == null || Number(nonUnique) !== 0) continue;
        if(!indexes.has(name)) indexes.set(name, []);
        indexes.get(name).push({ seq: Number(seq), column: String(column).toLowerCase() });
    }
    return new Set([...indexes.values()].map(columns => columns
        .sort((a, b) => a.seq - b.seq).map(part => part.column).join(',')));
}

async function assertUniqueKeyWitness(conn, dbName, file, statements, declaredUniqueIndexes){
    for(const table of targetsNeedingWitness(statements)){
        const declared = (await declaredUniqueIndexes(table) || []).filter(index => index && index.unique);
        if(!declared.length) continue;
        const rows = await conn.query(
            'SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.STATISTICS ' +
            'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX',
            [dbName, table]
        );
        const live = liveUniqueColumnSets(rows);
        for(const index of declared){
            const columns = (index.columns || []).map(column => String(column).toLowerCase());
            if(columns.length && live.has(columns.join(','))) continue;
            throw new Error('runMigrations: ' + file + ' uses a key-dependent write on ' + table +
                ', but declared UNIQUE index ' + index.name + ' (' + columns.join(', ') + ') is not live. ' +
                'Boot the indexer once so the index reconciler can add the key, or add the key in an earlier dated migration.');
        }
    }
}

module.exports = { keyDependentTargets, assertUniqueKeyWitness };
