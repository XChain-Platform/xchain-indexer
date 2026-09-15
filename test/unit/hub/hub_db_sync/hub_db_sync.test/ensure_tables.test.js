// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');

// Build a HubDbSync whose enabled flag is true (needs both a hub URL and a hub DB),
// backed by a stubbed doQuery we drive per-test to simulate the local price mirror.
function makeSync(maxReferenceBlock) {
    const doQuery = sinon.stub();
    doQuery.callsFake(async () => [{ h: maxReferenceBlock }]);
    const hubDb = { doQuery };
    const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test' });
    return { sync, hubDb, doQuery };
}

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { ensureTables } = HubDbSync;

function makeSqlDir(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mirror-sql-'));
    for (const [name, content] of Object.entries(files))
        fs.writeFileSync(path.join(dir, name), content);
    return dir;
}

// ---------------------------------------------------------------------------
// ensureTables(): mirror-schema creation for consumers without their own
// table machinery (the explorer's embedded mirror). The indexer never calls
// this (verifyTables() owns its schema); these tests pin the contract the
// explorer relies on: comment-safe statement splitting, per-file retry with
// backoff, and a hard error on an empty SQL dir.
// ---------------------------------------------------------------------------
describe('HubDbSync.ensureTables @regression @tier3', function () {
    it('is exported alongside the class', function () {
        assert.strictEqual(typeof ensureTables, 'function');
    });

    it('executes every statement of every .sql file, in filename order', async function () {
        const dir = makeSqlDir({
            'b_second.sql': 'CREATE TABLE b (id INT);',
            'a_first.sql':  'CREATE TABLE a (id INT);\nCREATE INDEX idx_a ON a (id);'
        });
        const calls = [];
        await ensureTables({ doQuery: async (sql) => { calls.push(sql); return []; } }, dir);
        const creates = calls.filter((s) => !/^SHOW TABLES/.test(s));
        assert.strictEqual(creates.length, 3);
        assert.match(creates[0], /CREATE TABLE a/);
        assert.match(creates[1], /CREATE INDEX idx_a/);
        assert.match(creates[2], /CREATE TABLE b/);
    });

    it('skips a file whose table already exists (restart against a built schema)', async function () {
        // The SQL twins use bare CREATE TABLE, so a re-run must gate on
        // existence exactly like the indexer verifyTables() does; without the
        // gate a mirror consumer crash-loops with ER_TABLE_EXISTS_ERROR on
        // every restart (caught live in the keyed-feed drill 2026-07-06).
        const dir = makeSqlDir({
            'a.sql': 'CREATE TABLE a (id INT);',
            'b.sql': 'CREATE TABLE b (id INT);'
        });
        const calls = [];
        const doQuery = async (sql, args) => {
            calls.push(sql);
            if (/^SHOW TABLES/.test(sql)) return args[0] === 'a' ? [{ t: 'a' }] : [];
            return [];
        };
        await ensureTables({ doQuery }, dir);
        const creates = calls.filter((s) => !/^SHOW TABLES/.test(s));
        assert.strictEqual(creates.length, 1, 'only the missing table is created');
        assert.match(creates[0], /CREATE TABLE b/);
    });

    it('a semicolon inside a -- comment is not a statement terminator', async function () {
        // Statement bodies must not contain quoted semicolons (the split on ';'
        // is naive there, same as indexer db.js createTable); the guarantee
        // under test is comment prose only, which is what bit attests.sql.
        const dir = makeSqlDir({
            't.sql': '-- header prose; with a semicolon\nCREATE TABLE t (id INT);'
        });
        const calls = [];
        await ensureTables({ doQuery: async (sql) => { calls.push(sql); return []; } }, dir);
        const creates = calls.filter((s) => !/^SHOW TABLES/.test(s));
        assert.strictEqual(creates.length, 1, 'comment semicolons must not split statements');
        assert.match(creates[0], /CREATE TABLE t/);
    });
});

describe('HubDbSync.ensureTables @regression @tier3', function () {
    it('retries a failing file with backoff and succeeds', async function () {
        const clock = sinon.useFakeTimers();
        try {
            const dir = makeSqlDir({ 't.sql': 'CREATE TABLE t (id INT);' });
            let calls = 0;
            let created = false;
            const doQuery = async (sql) => {
                calls++;
                if (calls === 1) throw new Error('transient');
                if (/^CREATE TABLE/.test(sql)) created = true;
                return [];
            };
            const p = ensureTables({ doQuery }, dir);
            await clock.tickAsync(600);
            await p;
            assert.strictEqual(created, true, 'table created on the retry attempt');
        } finally {
            clock.restore();
        }
    });

    it('throws after exhausting attempts on a persistently failing file', async function () {
        const clock = sinon.useFakeTimers();
        try {
            const dir = makeSqlDir({ 't.sql': 'CREATE TABLE t (id INT);' });
            const p = assert.rejects(
                ensureTables({ doQuery: async () => { throw new Error('down'); } }, dir),
                /failed to create t\.sql after 5 attempts: down/
            );
            await clock.tickAsync(60000);
            await p;
        } finally {
            clock.restore();
        }
    });

    it('throws on a directory with no .sql files', async function () {
        const dir = makeSqlDir({});
        await assert.rejects(
            ensureTables({ doQuery: async () => [] }, dir),
            /no \.sql files found/
        );
    });
});
