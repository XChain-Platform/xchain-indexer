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
 * anchor_reward_attestations.created_at is DATETIME on both the definition and
 * the dated migration path, and the migration is manual with the SET and MODIFY
 * the parity suite (test/unit/migration/sql_schema_column_parity.test) requires.
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../../src/db');

const stripComments = (sql) => Database.prototype.stripSqlLineComments.call({}, sql);

const DEFINITION_PATH = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'anchor_reward_attestations.sql');
const MIGRATION_PATH  = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'migrations',
    '2026-09-27-datetime-anchor-reward-attestations.sql');

describe('anchor_reward_attestations.created_at is DATETIME @regression', function () {
    it('the definition declares no column of type TIMESTAMP', function () {
        const raw     = stripComments(fs.readFileSync(DEFINITION_PATH, 'utf8'));
        const lines   = raw.split('\n');
        const offender = lines.find(line => /^\s*`?\w+`?\s+TIMESTAMP\b/i.test(line.trim()));
        assert.strictEqual(offender, undefined,
            'a column still declares TIMESTAMP: ' + offender);
    });

    it('created_at is declared DATETIME NOT NULL', function () {
        const raw = stripComments(fs.readFileSync(DEFINITION_PATH, 'utf8'));
        assert.ok(/\bcreated_at\s+DATETIME\s+NOT\s+NULL\b/i.test(raw),
            'created_at is no longer declared DATETIME NOT NULL in the definition');
    });

    it('the dated migration is mode=manual', function () {
        const raw = fs.readFileSync(MIGRATION_PATH, 'utf8');
        assert.strictEqual(Database.prototype.migrationMode(raw), 'manual',
            'this MODIFY restates NOT NULL, so it must never auto-run');
    });

    it('the dated migration pins the session time zone and MODIFYs the column', function () {
        const raw = fs.readFileSync(MIGRATION_PATH, 'utf8');
        assert.ok(/SET\s+time_zone\s*=\s*'\+00:00'\s*;/i.test(raw),
            'the migration no longer pins the session to UTC before retyping');
        assert.ok(/ALTER\s+TABLE\s+anchor_reward_attestations\s+MODIFY\s+created_at\s+DATETIME\s+NOT\s+NULL\s+DEFAULT\s+CURRENT_TIMESTAMP\s*;/i.test(raw),
            'the migration no longer MODIFYs created_at to DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP');
    });
});
