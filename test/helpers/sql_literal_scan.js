'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const acorn = require('acorn');

const CLAUSE_END = {
    'WHERE': new Set(['GROUP', 'HAVING', 'ORDER', 'LIMIT', 'UNION', 'RETURNING', 'FOR']),
    'JOIN ON': new Set(['JOIN', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'UNION', 'RETURNING', 'FOR']),
    'ORDER BY': new Set(['LIMIT', 'OFFSET', 'FETCH', 'UNION', 'RETURNING', 'FOR']),
};

const SQL_KEYWORDS = new Set([
    'AS', 'ON', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS',
    'NATURAL', 'ORDER', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'FETCH', 'UNION',
    'RETURNING', 'FOR', 'USE', 'FORCE', 'IGNORE', 'INDEX', 'KEY', 'STRAIGHT_JOIN',
]);

function parseJavascript(source, file) {
    const options = {
        ecmaVersion: 'latest',
        locations: true,
        allowHashBang: true,
        onToken: [],
    };
    let scriptError;
    try {
        return acorn.parse(source, { ...options, sourceType: 'script' });
    } catch (error) {
        scriptError = error;
    }
    try {
        return acorn.parse(source, { ...options, onToken: [], sourceType: 'module' });
    } catch (_) {
        throw new SyntaxError(`${file}: ${scriptError.message}`);
    }
}

function walk(node, visit) {
    if (!node || typeof node !== 'object') return;
    visit(node);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            for (const child of value) walk(child, visit);
        } else if (value && typeof value === 'object') {
            walk(value, visit);
        }
    }
}

function templateValue(node) {
    let value = '';
    for (let i = 0; i < node.quasis.length; i++) {
        const quasi = node.quasis[i].value;
        value += quasi.cooked === null ? quasi.raw : quasi.cooked;
        if (i < node.expressions.length) value += '?';
    }
    return value;
}

function extractSqlLiterals(source, file) {
    const ast = parseJavascript(source, file);
    const literals = [];
    walk(ast, (node) => {
        if (node.type === 'Literal' && typeof node.value === 'string') {
            literals.push({ literal: node.value, line: node.loc.start.line });
        } else if (node.type === 'TemplateLiteral') {
            literals.push({ literal: templateValue(node), line: node.loc.start.line });
        }
    });
    return literals;
}

function tokenizeSql(sql) {
    const tokens = [];
    let depth = 0;
    let i = 0;

    function quotedIdentifier(quote) {
        i++;
        let value = '';
        while (i < sql.length) {
            if (sql[i] === quote) {
                if (sql[i + 1] === quote) {
                    value += quote;
                    i += 2;
                    continue;
                }
                i++;
                break;
            }
            value += sql[i++];
        }
        return value;
    }

    while (i < sql.length) {
        if (/\s/.test(sql[i])) {
            i++;
        } else if (sql.startsWith('--', i) || sql[i] === '#') {
            const end = sql.indexOf('\n', i + 1);
            i = end === -1 ? sql.length : end + 1;
        } else if (sql.startsWith('/*', i)) {
            const end = sql.indexOf('*/', i + 2);
            i = end === -1 ? sql.length : end + 2;
        } else if (sql[i] === '\'') {
            i++;
            while (i < sql.length) {
                if (sql[i] === '\\') i += 2;
                else if (sql[i++] === '\'' && sql[i] !== '\'') break;
                else if (sql[i - 1] === '\'' && sql[i] === '\'') i++;
            }
        } else if (sql[i] === '`' || sql[i] === '"') {
            const quote = sql[i];
            tokens.push({ value: quotedIdentifier(quote), depth, identifier: true, quoted: true });
        } else if (/[A-Za-z_$]/.test(sql[i])) {
            const start = i++;
            while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
            tokens.push({ value: sql.slice(start, i), depth, identifier: true, quoted: false });
        } else {
            const value = sql[i++];
            if (value === ')') depth = Math.max(0, depth - 1);
            tokens.push({ value, depth, identifier: false, quoted: false });
            if (value === '(') depth++;
        }
    }
    return tokens;
}

function keyword(token) {
    return token && token.identifier && !token.quoted ? token.value.toUpperCase() : null;
}

function parseRelation(tokens, start) {
    if (!tokens[start] || !tokens[start].identifier) return null;
    let end = start + 1;
    let table = tokens[start].value;
    while (tokens[end] && tokens[end].value === '.' && tokens[end + 1] && tokens[end + 1].identifier) {
        table = tokens[end + 1].value;
        end += 2;
    }

    let alias = null;
    if (keyword(tokens[end]) === 'AS' && tokens[end + 1] && tokens[end + 1].identifier) {
        alias = tokens[end + 1].value;
        end += 2;
    } else if (tokens[end] && tokens[end].identifier && !SQL_KEYWORDS.has(keyword(tokens[end]))) {
        alias = tokens[end].value;
        end++;
    }
    return { table, alias, end };
}

function collectRelations(tokens) {
    const relations = [];
    for (let i = 0; i < tokens.length; i++) {
        const word = keyword(tokens[i]);
        if (word !== 'FROM' && word !== 'JOIN' && word !== 'STRAIGHT_JOIN') continue;
        const relation = parseRelation(tokens, i + 1);
        if (!relation) continue;
        relations.push(relation);

        if (word !== 'FROM') continue;
        let cursor = relation.end;
        const depth = tokens[i].depth;
        while (cursor < tokens.length && tokens[cursor].depth >= depth) {
            if (tokens[cursor].depth === depth && SQL_KEYWORDS.has(keyword(tokens[cursor]))) break;
            if (tokens[cursor].depth === depth && tokens[cursor].value === ',') {
                const next = parseRelation(tokens, cursor + 1);
                if (next) {
                    relations.push(next);
                    cursor = next.end;
                    continue;
                }
            }
            cursor++;
        }
    }
    return relations;
}

function clauseAt(tokens, index) {
    const word = keyword(tokens[index]);
    if (word === 'WHERE') return { name: 'WHERE', body: index + 1 };
    if (word === 'ON') return { name: 'JOIN ON', body: index + 1 };
    if (word === 'ORDER' && keyword(tokens[index + 1]) === 'BY') {
        return { name: 'ORDER BY', body: index + 2 };
    }
    return null;
}

function clauseEnd(tokens, start, clause, depth) {
    for (let i = start; i < tokens.length; i++) {
        if (tokens[i].depth < depth) return i;
        if (tokens[i].depth === depth && CLAUSE_END[clause].has(keyword(tokens[i]))) return i;
    }
    return tokens.length;
}

function findMirrorIdUses(literal, tables) {
    const passed = new Set(tables.map(table => table.toLowerCase()));
    const tokens = tokenizeSql(literal);
    const relations = collectRelations(tokens);
    const passedRelations = relations.filter(relation => passed.has(relation.table.toLowerCase()));
    if (passedRelations.length === 0) return [];

    const qualifiers = new Set();
    for (const relation of passedRelations) {
        qualifiers.add(relation.table.toLowerCase());
        if (relation.alias) qualifiers.add(relation.alias.toLowerCase());
    }
    const allowBare = relations.length > 0
        && relations.every(relation => passed.has(relation.table.toLowerCase()));
    const uses = [];

    for (let i = 0; i < tokens.length; i++) {
        const clause = clauseAt(tokens, i);
        if (!clause) continue;
        const end = clauseEnd(tokens, clause.body, clause.name, tokens[i].depth);
        for (let j = clause.body; j < end; j++) {
            const isQualified = tokens[j].identifier
                && qualifiers.has(tokens[j].value.toLowerCase())
                && tokens[j + 1] && tokens[j + 1].value === '.'
                && tokens[j + 2] && tokens[j + 2].identifier
                && tokens[j + 2].value.toLowerCase() === 'id';
            if (isQualified) {
                uses.push({ clause: clause.name, reference: `${tokens[j].value}.${tokens[j + 2].value}` });
                j += 2;
                continue;
            }
            const isBare = allowBare && tokens[j].identifier && tokens[j].value.toLowerCase() === 'id'
                && (!tokens[j - 1] || tokens[j - 1].value !== '.')
                && (!tokens[j + 1] || tokens[j + 1].value !== '.');
            if (isBare) uses.push({ clause: clause.name, reference: tokens[j].value });
        }
        i = Math.max(i, end - 1);
    }
    return uses;
}

module.exports = { extractSqlLiterals, findMirrorIdUses };
