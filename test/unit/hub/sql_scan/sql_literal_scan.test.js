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
const { extractSqlLiterals, findMirrorIdUses } = require('../../../helpers/sql_literal_scan');

const TABLES = ['price_snapshots'];

function violations(source) {
    return extractSqlLiterals(source, 'inline.js').flatMap(({ literal, line }) =>
        findMirrorIdUses(literal, TABLES).map(use => ({ ...use, line }))
    );
}

describe('SQL literal scanner', function () {
    it('extracts property-held, array-held, call argument and concatenation operands', function () {
        const source = [
            "const held = { sql: 'SELECT * FROM price_snapshots ORDER BY id' };",
            "const list = ['SELECT * FROM price_snapshots WHERE price_snapshots.id = 1'];",
            "run('SELECT * FROM price_snapshots p JOIN price_snapshots q ON p.id = q.id');",
            "const joined = 'SELECT * FROM price_snapshots ORDER BY price_snapshots.id' + ' LIMIT 1';",
        ].join('\n');
        const found = violations(source);

        assert.deepStrictEqual(found.map(use => use.line), [1, 2, 3, 3, 4]);
        assert.deepStrictEqual(found.map(use => use.clause),
            ['ORDER BY', 'WHERE', 'JOIN ON', 'JOIN ON', 'ORDER BY']);
    });

    it('joins template quasis with one placeholder per expression and retains the line', function () {
        const source = [
            'const network = "BTC";',
            'const query = `SELECT * FROM price_snapshots p',
            'WHERE p.network = ${network} AND p.id > ${floor}',
            'ORDER BY p.id`;',
        ].join('\n');
        const literals = extractSqlLiterals(source, 'template.js');
        const template = literals.find(({ literal }) => literal.startsWith('SELECT'));

        assert.strictEqual(template.line, 2);
        assert.strictEqual(template.literal,
            'SELECT * FROM price_snapshots p\nWHERE p.network = ? AND p.id > ?\nORDER BY p.id');
        assert.deepStrictEqual(findMirrorIdUses(template.literal, TABLES), [
            { clause: 'WHERE', reference: 'p.id' },
            { clause: 'ORDER BY', reference: 'p.id' },
        ]);
    });

    it('finds table-qualified, alias-qualified and unambiguous bare id uses', function () {
        const sql = 'SELECT * FROM price_snapshots p '
            + 'JOIN price_snapshots q ON price_snapshots.id = q.id '
            + 'WHERE p.id > 2 ORDER BY id';

        assert.deepStrictEqual(findMirrorIdUses(sql, TABLES), [
            { clause: 'JOIN ON', reference: 'price_snapshots.id' },
            { clause: 'JOIN ON', reference: 'q.id' },
            { clause: 'WHERE', reference: 'p.id' },
            { clause: 'ORDER BY', reference: 'id' },
        ]);
    });

    it('ignores non-id orders and id qualified by a non-passed table', function () {
        const sql = 'SELECT * FROM price_snapshots p '
            + 'JOIN audit_rows a ON a.id = p.audit_id '
            + 'WHERE a.id > 2 ORDER BY p.round_reference, a.id';

        assert.deepStrictEqual(findMirrorIdUses(sql, TABLES), []);
    });

    it('does not treat a bare id as mirrored when a non-passed table participates', function () {
        const sql = 'SELECT * FROM price_snapshots p JOIN audit_rows a ON p.round = a.round ORDER BY id';
        assert.deepStrictEqual(findMirrorIdUses(sql, TABLES), []);
    });

    it('throws a parse error that names the source file', function () {
        assert.throws(
            () => extractSqlLiterals('const broken = ;', 'broken/source.js'),
            /broken\/source\.js/
        );
    });
});
