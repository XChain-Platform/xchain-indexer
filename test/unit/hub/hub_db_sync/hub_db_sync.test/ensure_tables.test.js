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

// ---------------------------------------------------------------------------
// Index convergence on an EXISTING mirror table. ensureTables gates on table
// existence, so a KEY a twin file gained after the mirror was first built never
// reached a deployed consumer (price_snapshots.idx_status_timestamp_round, 2026-09-06:
// the barrier read behind it full-scanned a million-row mirror on every poll).
// ---------------------------------------------------------------------------
describe('HubDbSync.ensureTables index reconciliation @regression @tier3', function () {
    const { parseDeclaredIndexes } = require('../../../../../src/hub/hub_db_sync/ensure_tables.js');
    const TWIN = 'CREATE TABLE t (\n  id BIGINT PRIMARY KEY,\n  status VARCHAR(10),\n  ts BIGINT,\n  addr VARCHAR(80),\n'
        + '  UNIQUE KEY uq_status_ts (status, ts),\n  KEY idx_ts (ts),  -- a comment; with a semicolon\n  KEY idx_addr (addr(62))\n);\n'
        + 'CREATE INDEX idx_status ON t (status);';

    it('parses inline KEY, UNIQUE KEY (prefix widths stripped) and standalone CREATE INDEX', function () {
        const got = parseDeclaredIndexes(TWIN, 't').map((i) => [i.name, i.unique, i.columns.join(',')]);
        assert.deepStrictEqual(got, [
            ['uq_status_ts', true, 'status,ts'],
            ['idx_ts', false, 'ts'],
            ['idx_addr', false, 'addr'],
            ['idx_status', false, 'status']
        ]);
    });

    function liveRows(indexes) {
        const rows = [];
        for (const [name, unique, cols] of indexes)
            cols.forEach((c, i) => rows.push({ INDEX_NAME: name, NON_UNIQUE: unique ? 0 : 1, COLUMN_NAME: c, SEQ_IN_INDEX: i + 1 }));
        return rows;
    }

    async function run(live) {
        const dir = makeSqlDir({ 't.sql': TWIN });
        const alters = [];
        const doQuery = async (sql) => {
            if (/^SHOW TABLES/.test(sql)) return [{ t: 't' }];
            if (/information_schema\.statistics/.test(sql)) return live;
            if (/^ALTER TABLE/.test(sql)) { alters.push(sql); return []; }
            throw new Error('unexpected statement: ' + sql);
        };
        await ensureTables({ doQuery }, dir);
        return alters;
    }

    it('adds every declared index the live table lacks, and nothing that is already there', async function () {
        // uq_status_ts present by name; idx_ts satisfied by column set under another name;
        // idx_addr and idx_status missing.
        const alters = await run(liveRows([['PRIMARY', true, ['id']], ['uq_status_ts', true, ['status', 'ts']], ['ts_by_other_name', false, ['ts']]]));
        assert.deepStrictEqual(alters, [
            'ALTER TABLE `t` ADD INDEX `idx_addr` (addr(62))',
            'ALTER TABLE `t` ADD INDEX `idx_status` (status)'
        ]);
    });

    it('a UNIQUE declaration is not satisfied by a non-unique live index on the same columns', async function () {
        const alters = await run(liveRows([['PRIMARY', true, ['id']], ['loose', false, ['status', 'ts']], ['idx_ts', false, ['ts']], ['idx_addr', false, ['addr']], ['idx_status', false, ['status']]]));
        assert.deepStrictEqual(alters, ['ALTER TABLE `t` ADD UNIQUE INDEX `uq_status_ts` (status, ts)']);
    });

    it('does not query the live index set for a twin that declares no index', async function () {
        const dir = makeSqlDir({ 'plain.sql': 'CREATE TABLE plain (id INT);' });
        const calls = [];
        await ensureTables({ doQuery: async (sql) => { calls.push(sql); return [{ t: 'plain' }]; } }, dir);
        assert.deepStrictEqual(calls.filter((s) => !/^SHOW TABLES/.test(s)), []);
    });

    it('an ADD INDEX failure is logged and skipped, never thrown', async function () {
        const dir = makeSqlDir({ 't.sql': TWIN });
        const doQuery = async (sql) => {
            if (/^SHOW TABLES/.test(sql)) return [{ t: 't' }];
            if (/information_schema\.statistics/.test(sql)) return [];
            throw new Error('Duplicate entry');
        };
        await ensureTables({ doQuery }, dir);                      // resolves
    });
});

describe('HubDbSync.ensureTables column reconciliation @regression @tier3', function () {
    const { parseDeclaredColumns } = require('../../../../../src/hub/hub_db_sync/ensure_tables.js');
    const PRICE_TWIN = 'CREATE TABLE price_snapshots (\n'
        + '  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,\n'
        + '  coin_pair VARCHAR(20) NOT NULL,\n'
        + '  push_generation BIGINT NOT NULL DEFAULT 0,\n'
        + '  batch_block_time BIGINT NOT NULL DEFAULT 0,\n'
        + '  round_number BIGINT NOT NULL,\n'
        + '  KEY idx_pair_batchtime_round (coin_pair, batch_block_time, round_number)\n'
        + ') ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;';

    it('parses declared columns with their verbatim definition and NOT NULL/DEFAULT shape', function () {
        const got = parseDeclaredColumns(PRICE_TWIN).map((c) => [c.name, c.notNull, c.hasDefault]);
        assert.deepStrictEqual(got, [
            ['id', true, false],
            ['coin_pair', true, false],
            ['push_generation', true, true],
            ['batch_block_time', true, true],
            ['round_number', true, false]
        ]);
    });

    async function run(liveColumnNames) {
        const dir = makeSqlDir({ 'price_snapshots.sql': PRICE_TWIN });
        const alters = [];
        const doQuery = async (sql, args) => {
            if (/^SHOW TABLES/.test(sql)) return [{ t: 'price_snapshots' }];
            if (/information_schema\.columns/.test(sql)) return liveColumnNames.map((n) => ({ COLUMN_NAME: n }));
            if (/information_schema\.statistics/.test(sql)) return liveColumnNames.includes('batch_block_time')
                ? [{ INDEX_NAME: 'idx_pair_batchtime_round', NON_UNIQUE: 1, COLUMN_NAME: 'coin_pair', SEQ_IN_INDEX: 1 }]
                : [];
            if (/^ALTER TABLE/.test(sql)) { alters.push(sql); return []; }
            throw new Error('unexpected statement: ' + sql);
        };
        await ensureTables({ doQuery }, dir);
        return alters;
    }

    it('adds a missing column the twin declares, with its DEFAULT and AFTER the nearest live preceding column', async function () {
        const alters = await run(['id', 'coin_pair', 'push_generation', 'round_number']);
        assert.strictEqual(alters[0], 'ALTER TABLE `price_snapshots` ADD COLUMN batch_block_time BIGINT NOT NULL DEFAULT 0 AFTER `push_generation`');
    });

    it('does not touch a mirror that already has every declared column', async function () {
        const alters = await run(['id', 'coin_pair', 'push_generation', 'batch_block_time', 'round_number']);
        assert.deepStrictEqual(alters.filter((s) => /ADD COLUMN/.test(s)), []);
    });

    it('places a safe missing leading column FIRST when it has no live preceding anchor', async function () {
        const dir = makeSqlDir({
            't.sql': 'CREATE TABLE t (\n  added BIGINT DEFAULT 0,\n  existing BIGINT\n) ENGINE=InnoDB DEFAULT CHARSET=utf8;'
        });
        const alters = [];
        const doQuery = async (sql) => {
            if (/^SHOW TABLES/.test(sql)) return [{ t: 't' }];
            if (/information_schema\.columns/.test(sql)) return [{ COLUMN_NAME: 'existing' }];
            if (/^ALTER TABLE/.test(sql)) { alters.push(sql); return []; }
            throw new Error('unexpected statement: ' + sql);
        };
        await ensureTables({ doQuery }, dir);
        assert.deepStrictEqual(alters, ['ALTER TABLE `t` ADD COLUMN added BIGINT DEFAULT 0 FIRST']);
    });

    it('never MODIFYs or DROPs, only ADD COLUMN', async function () {
        const alters = await run(['id', 'coin_pair', 'push_generation', 'round_number']);
        assert.deepStrictEqual(alters.filter((s) => /ADD COLUMN/.test(s)), [
            'ALTER TABLE `price_snapshots` ADD COLUMN batch_block_time BIGINT NOT NULL DEFAULT 0 AFTER `push_generation`'
        ]);
        assert.ok(!alters.some((s) => /MODIFY|DROP/.test(s)));
    });

    it('a NOT NULL column with no DEFAULT is skipped, not added', async function () {
        const dir = makeSqlDir({
            't.sql': 'CREATE TABLE t (\n  id BIGINT NOT NULL,\n  owner VARCHAR(40) NOT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8;'
        });
        const alters = [];
        const doQuery = async (sql) => {
            if (/^SHOW TABLES/.test(sql)) return [{ t: 't' }];
            if (/information_schema\.columns/.test(sql)) return [{ COLUMN_NAME: 'id' }];
            if (/information_schema\.statistics/.test(sql)) return [];
            if (/^ALTER TABLE/.test(sql)) { alters.push(sql); return []; }
            throw new Error('unexpected statement: ' + sql);
        };
        await ensureTables({ doQuery }, dir);
        assert.deepStrictEqual(alters, []);
    });

    it('an ADD COLUMN failure is logged and skipped, never thrown', async function () {
        const dir = makeSqlDir({ 'price_snapshots.sql': PRICE_TWIN });
        const doQuery = async (sql) => {
            if (/^SHOW TABLES/.test(sql)) return [{ t: 'price_snapshots' }];
            if (/information_schema\.columns/.test(sql)) return [{ COLUMN_NAME: 'id' }, { COLUMN_NAME: 'coin_pair' }, { COLUMN_NAME: 'push_generation' }, { COLUMN_NAME: 'round_number' }];
            if (/information_schema\.statistics/.test(sql)) return [];
            throw new Error('Duplicate column name');
        };
        await ensureTables({ doQuery }, dir);                      // resolves
    });

    it('does not query live columns for a twin the parser cannot recognize (no ENGINE clause)', async function () {
        const dir = makeSqlDir({ 'plain.sql': 'CREATE TABLE plain (id INT);' });
        const calls = [];
        await ensureTables({ doQuery: async (sql) => { calls.push(sql); return [{ t: 'plain' }]; } }, dir);
        assert.deepStrictEqual(calls.filter((s) => !/^SHOW TABLES/.test(s)), []);
    });
});
