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
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const SQL_DIR        = path.join(__dirname, '..', '..', '..', 'src', 'sql');
const MIGRATION_DIR  = path.join(SQL_DIR, 'migrations');
const MIGRATION_SCAN = path.join(__dirname, '..', '..', '..', 'src', 'db',
    'database', 'migration_scan.js');

const EXPECTED_MODIFIES = [
    'anchor_reward_attestations.created_at',
    'bridge_transfers.created_at',
    'capability_snapshots.created_at',
    'cross_chain_calls.created_at',
    'cross_chain_matches.created_at',
    'oracle_prices.created_at',
    'policy_snapshots.created_at',
    'price_snapshots.created_at',
    'state_checkpoints.created_at',
    'state_tree_roots.computed_at',
];

const TIMESTAMP_COLUMN = /^`?[A-Za-z_][A-Za-z0-9_$]*`?\s+TIMESTAMP\b/i;
const TIMESTAMP_TYPE   = /`?[A-Za-z_][A-Za-z0-9_$]*`?\s+TIMESTAMP\b/i;
const DATETIME_MODIFY  = new RegExp(
    '\\bALTER\\s+TABLE\\s+`?([A-Za-z_][A-Za-z0-9_$]*)`?\\s+' +
    'MODIFY(?:\\s+COLUMN)?\\s+`?([A-Za-z_][A-Za-z0-9_$]*)`?\\s+DATETIME\\b',
    'gi');

function stripLineComments(sql) {
    return sql.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');
}

function definitionFiles() {
    return fs.readdirSync(SQL_DIR, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
        .map((entry) => entry.name)
        .sort();
}

function datetimeMigrationFiles() {
    return fs.readdirSync(MIGRATION_DIR)
        .filter((file) => /^2026-09-27-datetime-.*\.sql$/.test(file))
        .sort();
}

function timestampOffenders(file) {
    const raw = stripLineComments(fs.readFileSync(path.join(SQL_DIR, file), 'utf8'));
    return raw.split('\n').flatMap((line, index) =>
        TIMESTAMP_COLUMN.test(line.trim()) ? [file + ':' + (index + 1)] : []);
}

function datetimeModifies(files) {
    return files.flatMap((file) => {
        const raw = stripLineComments(fs.readFileSync(path.join(MIGRATION_DIR, file), 'utf8'));
        return [...raw.matchAll(DATETIME_MODIFY)].map((match) => match[1] + '.' + match[2]);
    }).sort();
}

describe('SQL definitions contain no TIMESTAMP columns @regression', function () {
    it('checks every top-level SQL definition', function () {
        const offenders = definitionFiles().flatMap(timestampOffenders);
        assert.deepStrictEqual(offenders, [],
            'TIMESTAMP column declarations:\n' + offenders.join('\n'));
    });
});

describe('dated DATETIME migrations are complete @regression', function () {
    const files = datetimeMigrationFiles();

    it('MODIFYs exactly the ten expected columns once each', function () {
        assert.strictEqual(files.length, 5,
            'expected exactly five DATETIME migrations, found: ' + files.join(', '));
        assert.deepStrictEqual(datetimeModifies(files), [...EXPECTED_MODIFIES].sort());
    });

    for (const file of files) {
        it(file + ' pins UTC before its first ALTER', function () {
            const raw = fs.readFileSync(path.join(MIGRATION_DIR, file), 'utf8');
            const sql = stripLineComments(raw);
            const setAt = sql.search(/\bSET\s+time_zone\s*=\s*'\+00:00'\s*;/i);
            const alterAt = sql.search(/\bALTER\s+TABLE\b/i);
            assert.ok(alterAt >= 0, file + ': missing ALTER TABLE');
            assert.ok(setAt >= 0 && setAt < alterAt,
                file + ": SET time_zone = '+00:00'; must precede the first ALTER");
        });
    }
});

describe('schema_migrations ledger uses no TIMESTAMP type @regression', function () {
    it('keeps TIMESTAMP out of its CREATE statement', function () {
        const source = fs.readFileSync(MIGRATION_SCAN, 'utf8');
        const start = source.indexOf('CREATE TABLE IF NOT EXISTS schema_migrations (');
        const end = source.indexOf('ENGINE=InnoDB', start);
        assert.ok(start >= 0 && end > start, 'schema_migrations CREATE statement not found');

        const createSource = source.slice(start, end);
        const timestampType = createSource.match(TIMESTAMP_TYPE);
        assert.strictEqual(timestampType, null,
            'schema_migrations CREATE declares TIMESTAMP: ' + timestampType);
    });
});
