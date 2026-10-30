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
 * Schema migration runner: foreign-key and CHECK constraint rule of the auto-apply scan.
 *
 * A foreign key cascades or restricts later deletes, the reorg rollback's included, and a
 * CHECK rejects later writes, so defining either runs manual only; dropping one stays auto.
 *
 ********************************************************************/

const { assert, destructiveOf } = require('./helpers/migration_fixtures.js');

describe('Database._destructiveAutoStatement() foreign key and CHECK constraints @regression @tier1', function () {
    it('flags every FOREIGN KEY, REFERENCES and CHECK constraint definition', function () {
        for (const stmt of [
            'ALTER TABLE balances ADD CONSTRAINT fk_bal_addr FOREIGN KEY (address_id) REFERENCES index_addresses (id) ON DELETE CASCADE',
            'ALTER TABLE t ADD FOREIGN KEY (a) REFERENCES u(b)',
            'alter table t add foreign key (a) references u(b)',
            'ALTER ONLINE TABLE t ADD COLUMN c INT, ADD FOREIGN KEY (c) REFERENCES u(id)',
            'ALTER TABLE t DROP FOREIGN KEY fk_old, ADD CONSTRAINT fk_new FOREIGN KEY (a) REFERENCES u(b)',
            'CREATE TABLE t (a INT, FOREIGN KEY (a) REFERENCES u(b)) ENGINE=InnoDB',
            'CREATE TABLE IF NOT EXISTS t (a INT REFERENCES u(b))',
            'ALTER TABLE t ADD CONSTRAINT ck CHECK (a > 0)',
            'CREATE TABLE t (a INT CHECK (a > 0))',
        ]) {
            assert.ok(destructiveOf([stmt]), 'expected flagged: ' + stmt);
        }
    });

    it('allows dropping a constraint and keywords inside literals or quoted identifiers', function () {
        for (const stmt of [
            'ALTER TABLE a DROP FOREIGN KEY fk_b',
            'ALTER TABLE a DROP FOREIGN KEY IF EXISTS fk_b',
            'ALTER TABLE t DROP CONSTRAINT ck',
            'ALTER TABLE t DROP CHECK ck',
            "ALTER TABLE t ADD COLUMN note VARCHAR(64) DEFAULT 'REFERENCES FOREIGN KEY CHECK(x)'",
            'ALTER TABLE t ADD COLUMN `references` INT',
            'CREATE TABLE t (`check` INT, id INT) ENGINE=InnoDB',
        ]) {
            assert.strictEqual(destructiveOf([stmt]), null, 'expected allowed: ' + stmt);
        }
    });
});
