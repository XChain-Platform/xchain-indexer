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
const mariadb = require('mariadb');
const { assertUniqueKeyWitness } = require('../../../src/db/database/migration_guards/key_witness.js');

const DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.TEST_DB_PORT || '3306');
const DB_USER = process.env.TEST_DB_USER || 'root';
const DB_PASS = process.env.TEST_DB_PASS || '';
const DB_NAME = (process.env.TEST_INDEXER_DB || 'xchain_test_indexer').slice(0, 40) + '_key_witness';
const WRITE = ['INSERT IGNORE INTO witness_rows (a, b) VALUES (1, 2)'];
const DECLARED = [{ name: 'uq_witness_pair', unique: true, columns: ['a', 'b'] }];

describe('automatic migration unique-key witness against live metadata @tier3', function () {
    this.timeout(120000);
    let admin;
    let conn;

    before(async function () {
        admin = await mariadb.createConnection({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS });
        await admin.query('DROP DATABASE IF EXISTS `' + DB_NAME + '`');
        await admin.query('CREATE DATABASE `' + DB_NAME + '`');
        conn = await mariadb.createConnection({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, database: DB_NAME,
        });
    });

    after(async function () {
        if(conn) await conn.end();
        if(admin){
            await admin.query('DROP DATABASE IF EXISTS `' + DB_NAME + '`');
            await admin.end();
        }
    });

    beforeEach(async function () {
        await conn.query('DROP TABLE IF EXISTS witness_rows');
        await conn.query('CREATE TABLE witness_rows (a INT NOT NULL, b INT NOT NULL, KEY uq_witness_pair (a, b))');
    });

    it('refuses a same-column non-unique index and passes after the unique key is live', async function () {
        await assert.rejects(() => assertUniqueKeyWitness(conn, DB_NAME, 'live.sql', WRITE, () => DECLARED),
            /live\.sql[\s\S]*witness_rows[\s\S]*uq_witness_pair/);
        await conn.query('ALTER TABLE witness_rows DROP INDEX uq_witness_pair, ADD UNIQUE INDEX live_pair (a, b)');
        await assert.doesNotReject(() => assertUniqueKeyWitness(conn, DB_NAME, 'live.sql', WRITE, () => DECLARED));
    });

    it('passes when the key-dependent target does not exist live', async function () {
        await conn.query('DROP TABLE witness_rows');
        await assert.doesNotReject(() => assertUniqueKeyWitness(conn, DB_NAME, 'live.sql', WRITE, () => DECLARED));
    });
});
