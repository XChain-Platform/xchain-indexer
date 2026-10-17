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

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('../../../../src/db');
const { keyDependentTargets } = require('../../../../src/db/database/migration_guards/key_witness.js');

const MIGRATIONS = path.join(__dirname, '../../../../src/sql/migrations');
const PINNED = {};

describe('committed automatic migration key-dependent writes @regression @tier1', function () {
    it('matches the reviewed file-to-table map', function () {
        const found = {};
        for(const file of fs.readdirSync(MIGRATIONS).filter(name => name.endsWith('.sql')).sort()){
            const raw = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
            if(Database.prototype.migrationMode(raw) !== 'auto') continue;
            const targets = keyDependentTargets(Database.prototype.splitSqlStatements.call(Database.prototype, raw));
            if(targets.length) found[file] = targets;
        }
        assert.deepStrictEqual(found, PINNED);
    });
});
