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
 *
 * oracle_prices.tick widen: the column must hold every tick PRICE v1 admits
 * (MAX_TICK_LENGTH), the dated migration must converge an aged mirror onto the
 * definition, and a fresh install must baseline the manual file rather than
 * leave it pending.
 *
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../../src/db');
const config   = require('../../../src/config');

const FILE     = '2026-09-22-oracle-prices-widen-tick.sql';
const SQL_DIR  = path.join(__dirname, '..', '..', '..', 'src', 'sql');
const MIG_PATH = path.join(SQL_DIR, 'migrations', FILE);

// Declared width of one oracle_prices column in the definition file.
function declaredWidth(column) {
    const sql  = fs.readFileSync(path.join(SQL_DIR, 'oracle_prices.sql'), 'utf8');
    const line = sql.split('\n').find(l => new RegExp('^\\s*' + column + '\\s+VARCHAR\\(', 'i').test(l));
    assert.ok(line, 'oracle_prices.' + column + ' is no longer declared as a VARCHAR');
    return Number(/VARCHAR\((\d+)\)/i.exec(line)[1]);
}

describe('oracle_prices.tick holds every PRICE v1 tick @regression @tier1', function () {
    it('the definition is at least MAX_TICK_LENGTH wide', function () {
        const max = config.getConfig('BTC', 'regtest').MAX_TICK_LENGTH;
        assert.strictEqual(max, 250);
        assert.ok(declaredWidth('tick') >= max,
            'oracle_prices.tick is ' + declaredWidth('tick') + ' but PRICE v1 admits ' + max);
    });

    it('the dated migration is manual and restates the definition spec exactly', function () {
        const body = fs.readFileSync(MIG_PATH, 'utf8');
        assert.match(body, /^-- xchain:migration mode=manual\s*$/m);
        assert.match(body, /^ALTER TABLE oracle_prices MODIFY tick VARCHAR\(250\) NOT NULL;\s*$/m);
        assert.strictEqual(declaredWidth('tick'), 250);
    });
});

describe('Database.MIGRATION_PRECONDITIONS[oracle_prices tick widen] @regression @tier1', function () {
    const pre = Database.MIGRATION_PRECONDITIONS[FILE];

    it('is registered and reads CHARACTER_MAXIMUM_LENGTH for oracle_prices.tick', function () {
        assert.ok(pre, FILE + ' must have a MIGRATION_PRECONDITIONS entry');
        assert.strictEqual(typeof pre.skipWhen, 'function');
        assert.match(pre.sql, /CHARACTER_MAXIMUM_LENGTH/);
        assert.match(pre.sql, /table_name = 'oracle_prices'/);
        assert.match(pre.sql, /column_name = 'tick'/);
        assert.strictEqual((pre.sql.match(/\?/g) || []).length, 1);
    });

    it('baselines at 250 characters and above', function () {
        assert.match(pre.skipWhen([{ len: 250 }]), /250/);
        assert.ok(pre.skipWhen([{ len: 255 }]));
    });

    it('does NOT baseline the legacy 50 or one short of the target', function () {
        assert.strictEqual(pre.skipWhen([{ len: 50 }]), null);
        assert.strictEqual(pre.skipWhen([{ len: 249 }]), null);
    });

    it('does NOT baseline an absent, NULL or unparsable length', function () {
        assert.strictEqual(pre.skipWhen([]), null);
        assert.strictEqual(pre.skipWhen([{ len: null }]), null);
        assert.strictEqual(pre.skipWhen([{ len: 'wide' }]), null);
    });
});
