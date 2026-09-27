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
const MIGRATION = path.join(SQL_DIR, 'migrations/2026-09-27-datetime-bridge-policy.sql');
const DEFINITIONS = ['bridge_transfers.sql', 'policy_snapshots.sql'];
const modeOf = Database.prototype.migrationMode.bind(Database.prototype);
const destructiveOf = Database.prototype.destructiveAutoStatement.bind(Database.prototype);
const statementsOf = (raw) => Database.prototype.splitSqlStatements.call(Database.prototype, raw);

function uncommentedLines(raw) {
    return raw.split('\n').map((line) => line.replace(/--.*$/, '').trim());
}

describe('bridge policy DATETIME schema @regression @tier1', function () {
    for(const file of DEFINITIONS) {
        it(file + ' uses DATETIME for created_at and declares no TIMESTAMP column', function () {
            const lines = uncommentedLines(fs.readFileSync(path.join(SQL_DIR, file), 'utf8'));
            assert.strictEqual(lines.some((line) => /^`?\w+`?\s+TIMESTAMP\b/i.test(line)), false);
            assert.ok(lines.some((line) => /^`?created_at`?\s+DATETIME\b/i.test(line)));
        });
    }

    it('keeps the conversion auto-safe and UTC-preserving', function () {
        const raw = fs.readFileSync(MIGRATION, 'utf8');
        assert.strictEqual(modeOf(raw), 'auto');
        assert.strictEqual(destructiveOf(statementsOf(raw)), null);
        assert.ok(raw.includes("SET time_zone = '+00:00';"));
        assert.ok(raw.includes('ALTER TABLE bridge_transfers MODIFY created_at DATETIME DEFAULT CURRENT_TIMESTAMP;'));
        assert.ok(raw.includes('ALTER TABLE policy_snapshots MODIFY created_at DATETIME DEFAULT CURRENT_TIMESTAMP;'));
    });
});
