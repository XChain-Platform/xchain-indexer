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
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mariadb = require('mariadb');

const DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.TEST_DB_PORT || '3306');
const DB_USER = process.env.TEST_DB_USER || 'root';
const DB_PASS = process.env.TEST_DB_PASS || '';
const DB_BASE = process.env.TEST_INDEXER_DB || 'xchain_test_indexer';
const suffix = '_outbox_' + crypto.createHash('sha1').update(__filename).digest('hex').slice(0, 6);
const DB_NAME = (DB_BASE.slice(0, 64 - suffix.length) + suffix).replace(/[^A-Za-z0-9_$]/g, '_');
const SQL_DIR = path.join(__dirname, '..', '..', '..', 'src', 'sql');
const MIGRATION = path.join(SQL_DIR, 'migrations',
    '2026-11-19-pending-hub-pushes-widen-payload.sql');
let connection;

function statements(file) {
    return fs.readFileSync(file, 'utf8').split('\n')
        .filter(line => !/^\s*--/.test(line))
        .map(line => line.replace(/\s--\s.*$/, '')).join('\n')
        .split(';').map(sql => sql.trim()).filter(Boolean);
}

async function runFile(file) {
    for (const sql of statements(file)) await connection.query(sql);
}

async function payloadShape() {
    const rows = await connection.query(
        "SELECT DATA_TYPE AS data_type, CHARACTER_SET_NAME AS charset_name " +
        "FROM information_schema.columns WHERE table_schema = ? " +
        "AND table_name = 'pending_hub_pushes' AND column_name = 'payload'", [DB_NAME]);
    return { data_type: rows[0].data_type.toLowerCase(), charset_name: rows[0].charset_name.toLowerCase() };
}

describe('pending_hub_pushes payload widen against MariaDB @tier3', function () {
    this.timeout(120000);

    before(async function () {
        connection = await mariadb.createConnection({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS
        });
        await connection.query('DROP DATABASE IF EXISTS `' + DB_NAME + '`');
        await connection.query('CREATE DATABASE `' + DB_NAME + '`');
        await connection.query('USE `' + DB_NAME + '`');
    });

    after(async function () {
        if (!connection) return;
        await connection.query('DROP DATABASE IF EXISTS `' + DB_NAME + '`');
        await connection.end();
    });

    it('fresh schema stores a large payload with four-byte UTF-8 byte-for-byte', async function () {
        await runFile(path.join(SQL_DIR, 'pending_hub_pushes.sql'));
        assert.deepStrictEqual(await payloadShape(), {
            data_type: 'mediumtext', charset_name: 'utf8mb4'
        });
        const payload = JSON.stringify({ rows: ['x'.repeat(70 * 1024)], provider_text: '😀' });
        await connection.beginTransaction();
        try {
            await connection.query(
                "INSERT INTO pending_hub_pushes (push_type, action_index, payload) VALUES ('attest_batch', 1, ?)",
                [payload]);
            const rows = await connection.query('SELECT payload FROM pending_hub_pushes');
            assert.strictEqual(rows[0].payload, payload);
        } finally {
            await connection.rollback();
        }
    });

    it('manual migration converges the legacy TEXT utf8mb3 shape', async function () {
        await connection.query('DROP TABLE pending_hub_pushes');
        await connection.query('CREATE TABLE pending_hub_pushes (payload TEXT NOT NULL) ' +
            'ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci');
        assert.deepStrictEqual(await payloadShape(), {
            data_type: 'text', charset_name: 'utf8mb3'
        });
        await runFile(MIGRATION);
        assert.deepStrictEqual(await payloadShape(), {
            data_type: 'mediumtext', charset_name: 'utf8mb4'
        });
    });
});
