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

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const acorn  = require('acorn');

const { listSrcTreeFiles } = require('../../helpers/src_tree_files.js');

const DB_ROOT = path.join(__dirname, '..', '..', '..', 'src', 'db');
const MIRRORED_TABLES = [
    'price_snapshots',
    'oracle_prices',
    'cross_chain_matches',
    'cross_chain_calls',
    'bridge_transfers',
    'policy_snapshots',
    'list_snapshots',
    'state_checkpoints',
    'anchor_reward_attestations',
    'capability_snapshots',
    'attestation_responses',
];
const INDIRECT_SITES = [
    'contracts/delegation_rotation.js',
    'escrow_journal/index.js',
    'index_tables/expired_items.js',
    'index_tables/index.js',
    'lists/rematch.js',
    'markets/market_pairs.js',
    'misc/index.js',
    'misc/table_dump.js',
    'rollback/read_phase.js',
    'tokens/sanity_check.js',
];
const ALLOW_LIST = new Set([]);
const SQL_ALIAS_STOP_WORDS = new Set([
    'where', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross',
    'on', 'order', 'group', 'having', 'limit', 'offset', 'union',
]);

function walk(node, visit, skipNestedFunctions = false, root = node) {
    if(!node || typeof node !== 'object') return;
    visit(node);
    for(const value of Object.values(node)) {
        if(Array.isArray(value)) {
            for(const child of value) {
                if(skipNestedFunctions && child !== root && isFunction(child)) continue;
                walk(child, visit, skipNestedFunctions, root);
            }
        } else if(value && typeof value === 'object') {
            if(skipNestedFunctions && value !== root && isFunction(value)) continue;
            walk(value, visit, skipNestedFunctions, root);
        }
    }
}

function isFunction(node) {
    return node && (node.type === 'FunctionDeclaration'
        || node.type === 'FunctionExpression'
        || node.type === 'ArrowFunctionExpression');
}

function functionBindings(ast) {
    const functions = new Map();
    walk(ast, node => {
        if(node.type === 'FunctionDeclaration' && node.id) {
            functions.set(node.id.name, node);
        } else if(node.type === 'VariableDeclarator' && node.id.type === 'Identifier'
            && isFunction(node.init)) {
            functions.set(node.id.name, node.init);
        }
    });
    return functions;
}

function functionReturnText(fn, call, values, functions, resolving) {
    const localValues = new Map(values);
    for(let i = 0; i < fn.params.length; i++) {
        if(fn.params[i].type !== 'Identifier') continue;
        const argument = staticText(call.arguments[i], values, functions, resolving);
        if(argument != null) localValues.set(fn.params[i].name, argument);
    }

    if(fn.body.type !== 'BlockStatement') {
        return staticText(fn.body, localValues, functions, resolving);
    }
    const returns = [];
    walk(fn.body, node => {
        if(node.type !== 'ReturnStatement') return;
        const text = staticText(node.argument, localValues, functions, resolving);
        if(text != null) returns.push(text);
    }, true, fn.body);
    return returns.length ? returns.join(' ') : null;
}

function staticText(node, values = new Map(), functions = new Map(), resolving = new Set()) {
    if(!node) return null;
    if(node.type === 'Literal') return typeof node.value === 'string' ? node.value : null;
    if(node.type === 'Identifier') return values.get(node.name) || null;
    if(node.type === 'TemplateLiteral') {
        return node.quasis.map((quasi, i) => {
            const value = quasi.value.cooked == null ? quasi.value.raw : quasi.value.cooked;
            if(i >= node.expressions.length) return value;
            return value + (staticText(node.expressions[i], values, functions, resolving) || ' __EXPR__ ');
        }).join('');
    }
    if(node.type === 'BinaryExpression' && node.operator === '+') {
        const left  = staticText(node.left, values, functions, resolving);
        const right = staticText(node.right, values, functions, resolving);
        if(left == null && right == null) return null;
        return (left == null ? ' __EXPR__ ' : left) + (right == null ? ' __EXPR__ ' : right);
    }
    if(node.type === 'ConditionalExpression') {
        const yes = staticText(node.consequent, values, functions, resolving);
        const no  = staticText(node.alternate, values, functions, resolving);
        if(yes == null && no == null) return null;
        return (yes || '') + ' ' + (no || '');
    }
    if(node.type === 'CallExpression') {
        if(node.callee.type === 'Identifier' && functions.has(node.callee.name)
            && !resolving.has(node.callee.name)) {
            const nextResolving = new Set(resolving).add(node.callee.name);
            const returned = functionReturnText(
                functions.get(node.callee.name), node, values, functions, nextResolving);
            if(returned != null) return returned;
        }
        const argumentsText = node.arguments.map(argument =>
            staticText(argument, values, functions, resolving)).filter(text => text != null);
        return argumentsText.length ? argumentsText.join(' ') : null;
    }
    return null;
}

function topLevelBindings(ast, functions) {
    const values = new Map();
    for(const statement of ast.body) {
        if(statement.type !== 'VariableDeclaration') continue;
        for(const declaration of statement.declarations) {
            if(declaration.id.type !== 'Identifier') continue;
            const text = staticText(declaration.init, values, functions);
            if(text != null) values.set(declaration.id.name, text);
        }
    }
    return values;
}

function candidateSql(ast) {
    const candidates = [];
    const scopes = [ast];
    const functions = functionBindings(ast);
    const inherited = topLevelBindings(ast, functions);
    walk(ast, node => { if(isFunction(node)) scopes.push(node); });

    for(const scope of scopes) {
        const events = [];
        walk(scope, node => {
            if(node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
                events.push({ start: node.start, line: node.loc.start.line, name: node.id.name,
                    operator: '=', expression: node.init });
            } else if(node.type === 'AssignmentExpression' && node.left.type === 'Identifier') {
                events.push({ start: node.start, line: node.loc.start.line, name: node.left.name,
                    operator: node.operator, expression: node.right });
            } else if(node.type === 'CallExpression' || node.type === 'ReturnStatement') {
                const expressions = node.type === 'CallExpression' ? node.arguments : [node.argument];
                events.push({ start: node.start, line: node.loc.start.line, expressions });
            }
        }, true, scope);
        events.sort((a, b) => a.start - b.start);

        const values = scope === ast ? new Map() : new Map(inherited);
        for(const event of events) {
            if(event.expressions) {
                for(const expression of event.expressions) {
                    const text = staticText(expression, values, functions);
                    if(text != null) candidates.push({ line: event.line, text });
                }
                continue;
            }
            const text = staticText(event.expression, values, functions);
            if(text == null) {
                if(event.operator === '=') values.delete(event.name);
                continue;
            }
            const combined = event.operator === '+=' && values.has(event.name)
                ? values.get(event.name) + text
                : text;
            values.set(event.name, combined);
            candidates.push({ line: event.line, text: combined });
        }
    }

    const seen = new Set();
    return candidates.filter(candidate => {
        const key = candidate.line + '\0' + candidate.text;
        if(seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function hasIndirectReadTable(sql) {
    return /\bSELECT\b[\s\S]*?\b(?:FROM|JOIN)\s+`?\s*__EXPR__\s*`?/i.test(sql);
}

function indirectSites(sources) {
    const sites = new Set();
    for(const { relative, source } of sources) {
        const ast = acorn.parse(source, {
            ecmaVersion: 'latest', sourceType: 'script', locations: true,
        });
        if(candidateSql(ast).some(candidate => hasIndirectReadTable(candidate.text))) {
            sites.add(relative);
        }
    }
    return [...sites].sort();
}

function dbSources() {
    return listSrcTreeFiles(DB_ROOT).map(relative => ({
        relative,
        source: fs.readFileSync(path.join(DB_ROOT, relative), 'utf8'),
    }));
}

function aliasesFor(sql, table) {
    const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('\\b(?:FROM|JOIN)\\s+`?' + escaped
        + '`?(?:\\s+(?:AS\\s+)?`?([A-Za-z_][A-Za-z0-9_]*)`?)?', 'gi');
    const aliases = new Set([table.toLowerCase()]);
    let match;
    while((match = re.exec(sql)) !== null) {
        if(match[1] && !SQL_ALIAS_STOP_WORDS.has(match[1].toLowerCase())) {
            aliases.add(match[1].toLowerCase());
        }
    }
    return aliases;
}

function readsTable(sql, table) {
    const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('\\b(?:FROM|JOIN)\\s+`?' + escaped + '`?', 'ig');
    let match;
    while((match = re.exec(sql)) !== null) {
        const prefixes = [...sql.slice(0, match.index).matchAll(/\b(SELECT|DELETE|UPDATE|INSERT)\b/ig)];
        if(prefixes.length && prefixes[prefixes.length - 1][1].toUpperCase() === 'SELECT') return true;
    }
    return false;
}

function clauseIdReference(body, aliases) {
    const re = /(^|[^A-Za-z0-9_])(?:`?([A-Za-z_][A-Za-z0-9_]*)`?\s*\.\s*)?`?id`?(?![A-Za-z0-9_])/ig;
    let match;
    while((match = re.exec(body)) !== null) {
        if(!match[2] || aliases.has(match[2].toLowerCase())) return match[0].trim();
    }
    return null;
}

function scanSql(sql) {
    const violations = [];
    const clauseRe = /\b(WHERE|HAVING|ON|ORDER\s+BY)\b([\s\S]*?)(?=\b(?:WHERE|HAVING|ON|ORDER\s+BY|GROUP\s+BY|LIMIT|OFFSET|UNION|(?:LEFT|RIGHT|INNER|OUTER|FULL|CROSS)\s+JOIN|JOIN)\b|$)/ig;
    for(const table of MIRRORED_TABLES) {
        if(!readsTable(sql, table)) continue;
        const aliases = aliasesFor(sql, table);
        let clause;
        while((clause = clauseRe.exec(sql)) !== null) {
            const reference = clauseIdReference(clause[2], aliases);
            if(reference) violations.push({ table, clause: clause[1].toUpperCase(), reference });
        }
        clauseRe.lastIndex = 0;
    }
    return violations;
}

function sourceViolations() {
    const violations = [];
    for(const { relative, source } of dbSources()) {
        const ast = acorn.parse(source, {
            ecmaVersion: 'latest', sourceType: 'script', locations: true,
        });
        for(const candidate of candidateSql(ast)) {
            for(const violation of scanSql(candidate.text)) {
                const key = `${relative}:${violation.table}:${violation.clause}`;
                if(!ALLOW_LIST.has(key)) violations.push({ relative, line: candidate.line, ...violation });
            }
        }
    }
    return violations;
}

describe('consensus mirror reads never consume local mirror ids @regression @tier1', function () {
    it('recognizes id ordering, filtering and joining across SQL construction styles', function () {
        const samples = [
            'SELECT * FROM oracle_prices op WHERE op.id = ?',
            'SELECT * FROM policy_snapshots ORDER BY id DESC',
            'SELECT c.* FROM cross_chain_calls c JOIN local_rows l ON c.id = l.mirror_id',
            'SELECT * FROM anchor_reward_attestations ara WHERE ara.network = ? ORDER BY ara.id',
        ];
        assert.deepStrictEqual(samples.map(sql => scanSql(sql).map(hit => hit.clause)), [
            ['WHERE'], ['ORDER BY'], ['ON'], ['ORDER BY'],
        ]);
    });

    it('reconstructs SQL assembled through identifier-based fragments', function () {
        const ast = acorn.parse(`
            const table = 'oracle_prices';
            const predicate = ' WHERE id = ?';
            const order = ' ORDER BY id DESC';
            async function read(db) {
                let query = 'SELECT * FROM ' + table;
                query += predicate;
                return db.doQuery(query + order);
            }
        `, { ecmaVersion: 'latest', locations: true });
        const clauses = candidateSql(ast).flatMap(candidate =>
            scanSql(candidate.text).map(hit => hit.clause));
        assert.deepStrictEqual(clauses.slice(-2), ['WHERE', 'ORDER BY']);
    });

    it('preserves mirrored table names introduced through calls', function () {
        const ast = acorn.parse(`
            const tableName = table => table;
            function fixedTable() {
                return 'anchor_reward_attestations';
            }
            async function read(db) {
                const filtered = 'SELECT * FROM ' + tableName('oracle_prices') + ' WHERE id = ?';
                const ordered = \`SELECT * FROM \${fixedTable()} ORDER BY id DESC\`;
                const joined = 'SELECT * FROM ' + externalTable('cross_chain_calls')
                    + ' c JOIN local_rows l ON c.id = l.call_id';
                await db.doQuery(filtered);
                await db.doQuery(ordered);
                return db.doQuery(joined);
            }
        `, { ecmaVersion: 'latest', locations: true });
        const clauses = candidateSql(ast).flatMap(candidate =>
            scanSql(candidate.text).map(hit => hit.clause));
        assert.deepStrictEqual([...new Set(clauses)], ['WHERE', 'ORDER BY', 'ON']);
    });

    it('finds opaque table names returned by inline and member calls', function () {
        const sources = [
            {
                relative: 'inline.js',
                source: `const sql = 'SELECT * FROM ' + (() => 'oracle_prices')()
                    + ' WHERE id = ?';`,
            },
            {
                relative: 'member.js',
                source: `const tables = {
                    mirrored() { return 'policy_snapshots'; },
                };
                const sql = \`SELECT * FROM \${tables.mirrored()} ORDER BY id\`;`,
            },
        ];
        const directViolations = sources.flatMap(({ source }) => {
            const ast = acorn.parse(source, { ecmaVersion: 'latest', locations: true });
            return candidateSql(ast).flatMap(candidate => scanSql(candidate.text));
        });
        assert.deepStrictEqual(directViolations, []);
        assert.deepStrictEqual(indirectSites(sources), ['inline.js', 'member.js']);
    });

    it('does not confuse projection or local-table ids with a mirrored id', function () {
        const sql = `SELECT op.id, local.id
                     FROM oracle_prices op
                     JOIN local_rows local ON local.id = op.action_index
                     WHERE local.id > 0
                     ORDER BY op.action_index`;
        assert.deepStrictEqual(scanSql(sql), []);
    });

    it('keeps the exception list empty', function () {
        assert.strictEqual(ALLOW_LIST.size, 0);
    });

    it('keeps every runtime-computed read table site under review', function () {
        assert.deepStrictEqual(indirectSites(dbSources()), INDIRECT_SITES,
            'review a new computed table site before it can hide a mirrored-table id read');
    });

    it('finds no mirrored id in a consensus read under src/db', function () {
        const violations = sourceViolations();
        assert.deepStrictEqual(violations, [], violations.map(v =>
            `${v.relative}:${v.line} ${v.table} ${v.clause} ${v.reference}`).join('\n'));
    });
});
