'use strict';

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
 * The four hub-mirror created_at columns (capability_snapshots,
 * cross_chain_matches, oracle_prices, price_snapshots) are DATETIME, not
 * TIMESTAMP, on every path: the table definition, the pre-ledger baseline,
 * and the dated migration that converts an aged DB. See
 * src/sql/migrations/2026-09-27-datetime-hub-mirrors.sql for why.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../../src/db');

const stripComments = (raw) => Database.prototype.stripSqlLineComments.call({}, raw);
const statementsOf   = (raw) => Database.prototype.splitSqlStatements.call(Database.prototype, raw);
const destructiveOf  = Database.prototype.destructiveAutoStatement.bind(Database.prototype);

const SQL_DIR = path.join(__dirname, '..', '..', '..', 'src', 'sql');
const MIGRATION_FILE = path.join(SQL_DIR, 'migrations', '2026-09-27-datetime-hub-mirrors.sql');

const TABLES = ['capability_snapshots', 'cross_chain_matches', 'oracle_prices', 'price_snapshots'];

// A column type of TIMESTAMP, not the DEFAULT CURRENT_TIMESTAMP clause every
// created_at also carries.
const DECLARES_TIMESTAMP_TYPE = /(?<!CURRENT_)\bTIMESTAMP\b/;

describe('hub-mirror created_at is DATETIME, not TIMESTAMP @regression', function () {
    TABLES.forEach((table) => {
        it(`${table}.sql declares no TIMESTAMP column and created_at is DATETIME`, function () {
            const raw   = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8');
            const lines = stripComments(raw).split('\n').map(l => l.trim()).filter(Boolean);

            const typedTimestamp = lines.filter(l => DECLARES_TIMESTAMP_TYPE.test(l));
            assert.deepStrictEqual(typedTimestamp, [], `${table}.sql still declares a TIMESTAMP column`);

            const createdAt = lines.find(l => /^created_at\b/.test(l));
            assert.ok(createdAt, `${table}.sql has no created_at line`);
            assert.ok(/\bDATETIME\b/.test(createdAt), `${table}.sql created_at is not DATETIME: ${createdAt}`);
        });
    });

    it('the pre-ledger baseline re-freezes all four created_at entries to DATETIME DEFAULT CURRENT_TIMESTAMP', function () {
        const baseline = JSON.parse(fs.readFileSync(
            path.join(__dirname, '..', '..', 'fixtures', 'schema-baseline.json'), 'utf8'));
        for (const table of TABLES) {
            const entry = (baseline.baseline[table] || []).find(e => e.name === 'created_at');
            assert.ok(entry, `baseline.${table} has no created_at entry`);
            assert.strictEqual(entry.spec, 'DATETIME DEFAULT CURRENT_TIMESTAMP',
                `baseline.${table}.created_at was not re-frozen: ${entry.spec}`);
        }
    });

    describe('the migration file', function () {
        const raw = fs.readFileSync(MIGRATION_FILE, 'utf8');

        it('is tagged mode=auto', function () {
            assert.strictEqual(Database.prototype.migrationMode(raw), 'auto');
        });

        it('scores auto-eligible (no destructive statement)', function () {
            assert.strictEqual(destructiveOf(statementsOf(raw)), null);
        });

        it('holds the time_zone SET and the four MODIFY statements', function () {
            const statements = statementsOf(raw);
            assert.ok(statements.some(s => /^SET\s+time_zone\s*=\s*'\+00:00'$/i.test(s)),
                'missing SET time_zone = \'+00:00\'');
            for (const table of TABLES) {
                const re = new RegExp(`^ALTER\\s+TABLE\\s+${table}\\s+MODIFY\\s+created_at\\s+DATETIME\\s+DEFAULT\\s+CURRENT_TIMESTAMP$`, 'i');
                assert.ok(statements.some(s => re.test(s)), `missing MODIFY for ${table}`);
            }
        });
    });
});
