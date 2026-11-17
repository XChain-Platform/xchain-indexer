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
const fs = require('fs');
const path = require('path');

const Database = require('../../../src/db');

const SQL_DIR = path.join(__dirname, '../../../src/sql');
const MIGRATION = path.join(SQL_DIR, 'migrations/2026-11-17-file-multipart-uncapped.sql');
const CREATE_MIGRATION = path.join(SQL_DIR, 'migrations/2026-11-15-file-multipart-tables.sql');
const TABLES = ['file_manifests', 'file_parts', 'file_completions'];
const parser = Database.prototype;

function tableCreate(raw, table) {
    const match = new RegExp(
        'CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?`?' + table + '`?\\s*\\([\\s\\S]+?\\)\\s*ENGINE[^;]*;',
        'i'
    ).exec(raw);
    assert.ok(match, 'missing CREATE TABLE for ' + table);
    return match[0];
}

function parsedSchema(raw, table) {
    return {
        columns: parser.parseExpectedColumns.call(parser, raw),
        indexes: parser.parseExpectedIndexes.call(parser, raw, table)
    };
}

function column(schema, name) {
    return schema.columns.find(item => item.name === name);
}

function index(schema, columns) {
    const key = columns.join(',');
    return schema.indexes.find(item => item.columns.join(',') === key);
}

function migratedColumnNames(createRaw, migrationRaw, table) {
    const names = parsedSchema(tableCreate(createRaw, table), table).columns.map(item => item.name);
    const add = new RegExp(
        'ALTER\\s+TABLE\\s+`?' + table + '`?\\s+ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?`?(\\w+)`?',
        'gi'
    );
    let match;
    while((match = add.exec(migrationRaw)) !== null) {
        if(!names.includes(match[1])) names.push(match[1]);
    }
    return names;
}

describe('uncapped multipart file schema @regression @tier1', function () {
    const migrationRaw = fs.readFileSync(MIGRATION, 'utf8');
    const createRaw = fs.readFileSync(CREATE_MIGRATION, 'utf8');

    it('keeps every migration statement auto-safe', function () {
        assert.strictEqual(parser.migrationMode.call(parser, migrationRaw), 'auto');
        const statements = parser.splitSqlStatements.call(parser, migrationRaw);
        assert.ok(statements.length >= 6, 'the migration statement parser did not find all ALTER and CREATE operations');
        for(const statement of statements) {
            assert.strictEqual(parser.destructiveAutoStatement.call(parser, [statement]), null, statement);
        }
        assert.strictEqual(parser.destructiveAutoStatement.call(parser, statements), null);
    });

    it('parses the widened manifest and fill columns through the drift reconciler', function () {
        const manifests = parsedSchema(fs.readFileSync(path.join(SQL_DIR, 'file_manifests.sql'), 'utf8'), 'file_manifests');
        const parts = parsedSchema(fs.readFileSync(path.join(SQL_DIR, 'file_parts.sql'), 'utf8'), 'file_parts');

        assert.match(column(manifests, 'total_bytes').definition, /^total_bytes\s+BIGINT UNSIGNED NULL$/i);
        assert.strictEqual(column(manifests, 'total_bytes').nullable, true);
        assert.match(column(manifests, 'filled_at_manifest').definition, /^filled_at_manifest\s+INT UNSIGNED NULL$/i);
        assert.strictEqual(column(manifests, 'filled_at_manifest').nullable, true);
        assert.match(column(parts, 'fill_ordinal').definition, /^fill_ordinal\s+INT UNSIGNED NULL$/i);
        assert.strictEqual(column(parts, 'fill_ordinal').nullable, true);
    });

    it('parses every lookup index through the drift reconciler', function () {
        const schemas = Object.fromEntries(TABLES.map(table => [
            table,
            parsedSchema(fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8'), table)
        ]));

        assert.ok(index(schemas.file_manifests, ['source_id', 'file_hash']));
        assert.ok(index(schemas.file_parts, ['source_id', 'file_hash', 'fill_ordinal']));
        assert.ok(index(schemas.file_completions, ['manifest_action_index']));
    });

    it('keeps fresh and migrated column lists identical for all multipart tables', function () {
        for(const table of TABLES) {
            const fresh = parsedSchema(fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8'), table)
                .columns.map(item => item.name);
            const migrated = migratedColumnNames(createRaw, migrationRaw, table);
            assert.deepStrictEqual(migrated, fresh, table + ' column order differs between migrated and fresh schemas');
        }
    });
});
