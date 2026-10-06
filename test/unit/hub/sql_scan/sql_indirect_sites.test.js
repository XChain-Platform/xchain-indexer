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
const { findIndirectTableSites } = require('../../../helpers/sql_literal_scan');

const TABLES = ['price_snapshots'];

describe('SQL indirect table site scanner', function () {
    it('finds one template, bare-name and concatenation site', function () {
        const source = [
            'const template = `SELECT * FROM ${table}`;',
            "const bareName = 'price_snapshots';",
            "const concatenated = 'SELECT * FROM ' + table;",
        ].join('\n');

        assert.deepStrictEqual(findIndirectTableSites(source, 'indirect.js', TABLES), [
            { line: 1, kind: 'template', table: null },
            { line: 2, kind: 'bare-name', table: 'price_snapshots' },
            { line: 3, kind: 'concat', table: null },
        ]);
    });

    it('ignores placeholders outside table position and direct table SQL', function () {
        const source = [
            'const filtered = `SELECT * FROM price_snapshots WHERE id = ${id}`;',
            "const direct = 'SELECT * FROM price_snapshots';",
        ].join('\n');

        assert.deepStrictEqual(findIndirectTableSites(source, 'direct.js', TABLES), []);
    });

    it('ignores a bare name outside the passed table list', function () {
        assert.deepStrictEqual(
            findIndirectTableSites("const table = 'audit_rows';", 'other.js', TABLES),
            []
        );
    });

    it('throws a parse error that names the source file', function () {
        assert.throws(
            () => findIndirectTableSites('const broken = ;', 'broken/indirect.js', TABLES),
            /broken\/indirect\.js/
        );
    });
});
