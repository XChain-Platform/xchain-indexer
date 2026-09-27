'use strict';

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
 * Pins definition, baseline and migration coverage for the three provenance
 * columns retyped from TIMESTAMP to DATETIME without session time_zone
 * conversion on read.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../../src/db');

const SQL_DIR = path.join(__dirname, '..', '..', '..', 'src', 'sql');
const MIG_DIR = path.join(SQL_DIR, 'migrations');
const MIGRATION_FILE = '2026-09-27-datetime-not-null-columns.sql';

const stripComments = (sql) => Database.prototype.stripSqlLineComments.call({}, sql);

const DEFINITIONS = [
    { file: 'cross_chain_calls.sql', table: 'cross_chain_calls', column: 'created_at' },
    { file: 'state_checkpoints.sql', table: 'state_checkpoints', column: 'created_at' },
    { file: 'state_tree_roots.sql',  table: 'state_tree_roots',  column: 'computed_at' },
];

// A TIMESTAMP token that is the column TYPE, not the CURRENT_TIMESTAMP default.
const BARE_TIMESTAMP = /(?<!CURRENT_)\bTIMESTAMP\b/i;

function trimmedLines(file) {
    const raw = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
    return stripComments(raw).split('\n').map((l) => l.trim()).filter(Boolean);
}

function columnLine(lines, column) {
    return lines.find((l) => new RegExp('^`?' + column + '`?\\b').test(l));
}

describe('SQL DATETIME retype: pre-ledger NOT NULL columns @regression', function () {
    for (const { file, column } of DEFINITIONS) {
        it(file + ' declares ' + column + ' as DATETIME NOT NULL, never bare TIMESTAMP', function () {
            const lines = trimmedLines(file);
            for (const line of lines) {
                assert.ok(!BARE_TIMESTAMP.test(line), file + ': a line still declares TIMESTAMP: ' + line);
            }
            const line = columnLine(lines, column);
            assert.ok(line, file + ': no line declares ' + column);
            assert.ok(/\bDATETIME\s+NOT\s+NULL\b/.test(line), file + ': ' + column + ' is not DATETIME NOT NULL: ' + line);
        });
    }
});

describe('schema-baseline.json: re-frozen entries read DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP @regression', function () {
    const baseline = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', '..', 'fixtures', 'schema-baseline.json'), 'utf8'));

    for (const { table, column } of DEFINITIONS) {
        it(table + '.' + column + ' is frozen as DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP', function () {
            const entry = (baseline.baseline[table] || []).find((e) => e.name === column);
            assert.ok(entry, table + '.' + column + ' missing from schema-baseline.json');
            assert.strictEqual(entry.spec, 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP');
        });
    }
});

describe('2026-09-27-datetime-not-null-columns.sql: manual mode and the three MODIFYs @regression', function () {
    const raw = fs.readFileSync(path.join(MIG_DIR, MIGRATION_FILE), 'utf8');

    it('is tagged mode=manual (the auto classifier refuses a MODIFY restating NOT NULL)', function () {
        assert.strictEqual(Database.prototype.migrationMode(raw), 'manual');
    });

    it('holds SET time_zone and MODIFYs all three columns to DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP', function () {
        const stripped = stripComments(raw);
        assert.ok(/SET\s+time_zone\s*=\s*'\+00:00'\s*;/i.test(stripped), 'missing SET time_zone statement');
        for (const { table, column } of DEFINITIONS) {
            const re = new RegExp(
                'ALTER\\s+TABLE\\s+' + table + '\\s+MODIFY\\s+' + column +
                '\\s+DATETIME\\s+NOT\\s+NULL\\s+DEFAULT\\s+CURRENT_TIMESTAMP\\s*;', 'i');
            assert.ok(re.test(stripped), table + '.' + column + ': no matching MODIFY statement');
        }
    });
});
