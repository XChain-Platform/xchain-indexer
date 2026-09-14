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
 **********************************************************************
 * test/helpers/relay_identity_db.js
 *
 * The real-MariaDB fixture behind the relay-identity suites:
 * test/integration/attest_relay_identity.test.js (the origin lookup),
 * attest_relay_identity_request_id.test.js (the request_id plane) and
 * attest_relay_identity_migration.test.js (the dated migration). Why those
 * suites need a real engine rather than a stub is written down once, in the
 * first of them.
 *
 * Each suite is several consecutive describe blocks with one shared title, so
 * every block registers the same hooks through useRelayIdentityDb(). The schema
 * is built once per database name per run, which is what the single before()
 * of the one-file suite did; each block then opens its own pool and closes it.
 * Each suite passes its own database name, so no two files share a schema.
 *
 * The requiring suite sets INDEXER_COIN and INDEXER_NETWORK before it requires
 * this file, because src/db reads them at load.
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');

const { getTestConfig } = require('../fixtures/config');
const Utility  = require('../../src/utility');
const Database = require('../../src/db');

const DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.TEST_DB_PORT) || 3306;
const DB_USER = process.env.TEST_DB_USER || 'root';
const DB_PASS = process.env.TEST_DB_PASS;            // undefined => self-skip
const DB_NAME = process.env.TEST_ATTEST_RELAY_DB || 'xchain_attest_relay_identity';

const SQL_DIR = path.join(__dirname, '../../src/sql');
// Strip `--` line comments with the PRODUCT's own stripper, for the reason
// recovery_id_determinism.test.js documents: the licence banner starts `--***` with
// no whitespace, which MySQL does not treat as a comment, so a verbatim send is
// errno 1064 on the first line.
const stripSqlLineComments = Database.prototype.stripSqlLineComments;
const ATTESTS_SQL = stripSqlLineComments(fs.readFileSync(path.join(SQL_DIR, 'attests.sql'), 'utf8'));

const ORIGIN = 'LTC';
const OTHER  = 'DOGE';
const IDX    = 4242;
// The top of the range src/db.js's `bigIntAsNumber: true` comment declares safe
// ("all indexer BIGINT columns are within Number.MAX_SAFE_INTEGER for any realistic
// chain"). Testing AT the boundary rather than below it is the point: this is the
// largest value for which the Number binding is required to be exact.
const BIG    = Number.MAX_SAFE_INTEGER;              // 9007199254740991

/**
 * The database one suite owns. The first suite keeps the historic name, so the
 * TEST_ATTEST_RELAY_DB mapping in .ci-databases reads as it always has; the
 * others append a short suffix, which keeps the ci_ prefix the venue grant covers.
 */
function relayDbName(suffix) {
    return suffix ? DB_NAME + '_' + suffix : DB_NAME;
}

function makeDb(name) {
    const config = getTestConfig();
    const util   = new Utility();
    return new Database(DB_HOST, DB_PORT, name, DB_USER, DB_PASS, { config, util });
}

async function buildSchema(name) {
    const admin = await mariadb.createConnection({
        host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, multipleStatements: true });
    await admin.query('DROP DATABASE IF EXISTS ' + name + '; CREATE DATABASE ' + name + ';');
    await admin.query('USE ' + name + '; ' + ATTESTS_SQL);
    // A stand-in for the one table getAttestationRequestById LEFT JOINs. The
    // request_id comparison case needs the SHARED lookup to actually run against
    // this schema, and without the join target its query is a 1146 that doQuery
    // swallows into [] - which would make the shared lookup look like it excludes
    // rejected rows when it does not. Columns are only what the join reads.
    await admin.query('USE ' + name +
        '; CREATE TABLE IF NOT EXISTS index_addresses (' +
        ' id BIGINT UNSIGNED NOT NULL PRIMARY KEY, address VARCHAR(128) NULL)');
    await admin.end();
}

// One schema build per database name per run, shared by the sibling blocks.
const schemas = new Map();
function ensureSchema(name) {
    if (!schemas.has(name)) schemas.set(name, buildSchema(name));
    return schemas.get(name);
}

/**
 * Register the suite hooks in the calling describe block and hand back the
 * fixture: `fx.db` is the block's Database once its before() has run, `conn`
 * lends a pooled connection, and `row` writes one attests row.
 */
function useRelayIdentityDb(name) {
    const fx = { db: null, conn, row };

    before(async function () {
        if (!DB_PASS) this.skip();
        await ensureSchema(name);
        fx.db = makeDb(name);
    });

    after(async function () {
        if (fx.db && fx.db.pool) await fx.db.pool.end();
    });

    beforeEach(async function () {
        await conn(c => c.query('DELETE FROM attests'));
    });

    async function conn(fn) {
        const c = await fx.db.getConnection();
        try { return await fn(c); } finally { await c.release(); }
    }

    /**
     * Write one attests row the way the writer does for a relay leg. `actionIndex`
     * doubles as the row identity, so a case can assert WHICH row came back.
     */
    function row({ actionIndex, version = 0, requestId, status = 'pending',
                   originChain = ORIGIN, originActionIndex = IDX }) {
        return conn(c => c.query(
            `INSERT INTO attests
                 (action_index, version, request_id, provider_id, request_status,
                  origin_chain, origin_action_index, block_index)
             VALUES (?, ?, ?, 'http_get', ?, ?, ?, 900000)`,
            [actionIndex, version, requestId || String(actionIndex).padStart(64, '0'),
             status, originChain, originActionIndex]));
    }

    return fx;
}

module.exports = {
    ORIGIN, OTHER, IDX, BIG, SQL_DIR, stripSqlLineComments, relayDbName, useRelayIdentityDb,
};
