// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

/*
 * The reorg purge of price_snapshots runs in bounded chunks and survives a statement
 * timeout. A single unbounded DELETE over a large mirror outlasted the per-query timeout,
 * and inside the rollback transaction that error failed the whole rollback. The stub db
 * below plays the table: it honours the statement's predicate and LIMIT, so the
 * assertions are on the statements the shipped function issues and the rows they leave.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sweeps = require('../../../../src/db/rollback/sweeps');

const CHUNK   = sweeps.PRICE_SNAPSHOT_PURGE_CHUNK;
const RETRIES = sweeps.PRICE_SNAPSHOT_PURGE_TIMEOUT_RETRIES;
const SQL_DIR = path.resolve(__dirname, '../../../../src/sql');

const norm = s => s.replace(/\s+/g, ' ').trim();

function timeoutError() {
    const error = new Error('Query execution was interrupted (max_statement_time exceeded)');
    error.errno = 1969;
    error.code  = 'ER_STATEMENT_TIMEOUT';
    return error;
}

// A price_snapshots table of `orphaned` BTC rows at or above `block`, plus rows the purge
// must keep: one BTC row below the block and one LTC-published row above it.
function makeTable(block, orphaned) {
    const rows = [
        { reference_chain: 'BTC', reference_block: block - 1, keep: true },
        { reference_chain: 'LTC', reference_block: block + 5, keep: true },
    ];
    for (let i = 0; i < orphaned; i++)
        rows.push({ reference_chain: 'BTC', reference_block: block + (i % 7), keep: false });
    return rows;
}

// A stub db over `table`. `failOn(n)` returns an error to throw on the nth statement
// (1-based) instead of running it.
function makeDb(table, failOn) {
    const statements = [];
    const db = {
        async doQuery(sql, args) {
            const n = statements.length + 1;
            statements.push({ sql: norm(sql), args: args.slice() });
            const failure = failOn ? failOn(n) : null;
            if (failure) throw failure;
            const [block, limit] = args;
            const hits = table
                .map((row, at) => ({ row, at }))
                .filter(({ row }) => row.reference_chain === 'BTC' && row.reference_block >= block)
                .slice(0, limit);
            const drop = new Set(hits.map(h => h.at));
            for (let at = table.length - 1; at >= 0; at--) if (drop.has(at)) table.splice(at, 1);
            return { affectedRows: hits.length };
        },
    };
    return { db, statements };
}

function registerChunkTests() {
    it('purges a table larger than one chunk in bounded statements', async function () {
        const table = makeTable(500, 2 * CHUNK + 501);
        const { db, statements } = makeDb(table);

        await sweeps.purgeOrphanedPriceSnapshots(db, 500);

        assert.deepStrictEqual(statements.map(s => s.args), [[500, CHUNK], [500, CHUNK], [500, CHUNK]]);
        for (const { sql } of statements) {
            assert.strictEqual(sql,
                "DELETE FROM price_snapshots WHERE reference_chain = 'BTC' AND reference_block >= ? LIMIT ?");
        }
        assert.ok(table.every(row => row.keep), 'only the rows the purge must keep remain');
        assert.strictEqual(table.length, 2);
    });

    it('stops after one statement when the first chunk is short', async function () {
        const table = makeTable(500, 3);
        const { db, statements } = makeDb(table);
        await sweeps.purgeOrphanedPriceSnapshots(db, 500);
        assert.strictEqual(statements.length, 1);
        assert.strictEqual(table.length, 2);
    });

}

function registerTimeoutTests() {
    it('retries a statement timeout at a smaller chunk and completes the purge', async function () {
        const table = makeTable(500, 2 * CHUNK + 501);
        const { db, statements } = makeDb(table, n => (n === 2 ? timeoutError() : null));

        await sweeps.purgeOrphanedPriceSnapshots(db, 500);

        const limits = statements.map(s => s.args[1]);
        assert.deepStrictEqual(limits.slice(0, 3), [CHUNK, CHUNK, CHUNK / 2],
            'the timed-out chunk is asked for again at half the size');
        assert.ok(limits.every(limit => limit <= CHUNK), 'no statement is unbounded');
        assert.ok(table.every(row => row.keep), 'the purge still removes every orphaned row');
        assert.strictEqual(table.length, 2);
    });

    it('treats MySQL ER_QUERY_TIMEOUT as a statement timeout too', async function () {
        const table = makeTable(500, 10);
        const mysqlTimeout = Object.assign(new Error('max_execution_time exceeded'), { errno: 3024, code: 'ER_QUERY_TIMEOUT' });
        const { db, statements } = makeDb(table, n => (n === 1 ? mysqlTimeout : null));
        await sweeps.purgeOrphanedPriceSnapshots(db, 500);
        assert.strictEqual(statements.length, 2);
        assert.strictEqual(table.length, 2);
    });

    it('resets the timeout budget after a chunk succeeds', async function () {
        const table = makeTable(500, 4 * CHUNK);
        // Alternate a timeout with a success: more timeouts in total than the budget allows,
        // never more than one in a row.
        const { db } = makeDb(table, n => (n % 2 === 1 && n <= 2 * (RETRIES + 2) ? timeoutError() : null));
        await sweeps.purgeOrphanedPriceSnapshots(db, 500);
        assert.strictEqual(table.length, 2);
    });

    it('gives up once consecutive timeouts exceed the retry budget', async function () {
        const table = makeTable(500, 10);
        const { db, statements } = makeDb(table, () => timeoutError());
        await assert.rejects(sweeps.purgeOrphanedPriceSnapshots(db, 500), { code: 'ER_STATEMENT_TIMEOUT' });
        assert.strictEqual(statements.length, RETRIES + 1);
        assert.strictEqual(table.length, 12, 'nothing was deleted');
    });

    it('does not retry an error that is not a statement timeout', async function () {
        const table = makeTable(500, 10);
        const deadlock = Object.assign(new Error('Deadlock found'), { errno: 1213, code: 'ER_LOCK_DEADLOCK' });
        const { db, statements } = makeDb(table, () => deadlock);
        await assert.rejects(sweeps.purgeOrphanedPriceSnapshots(db, 500), { code: 'ER_LOCK_DEADLOCK' });
        assert.strictEqual(statements.length, 1);
    });

}

function registerIndexTests() {
    it('runs off idx_refchain_block, which the schema and its migration both declare', async function () {
        const schema = fs.readFileSync(path.join(SQL_DIR, 'price_snapshots.sql'), 'utf8');
        const migration = fs.readFileSync(
            path.join(SQL_DIR, 'migrations', '2026-10-14-price-snapshots-refchain-block-idx.sql'), 'utf8');
        assert.match(schema, /^\s*KEY idx_refchain_block \(reference_chain, reference_block\)/m);
        assert.match(migration,
            /^CREATE INDEX IF NOT EXISTS idx_refchain_block ON price_snapshots \(reference_chain, reference_block\);$/m);

        // The chunk statement pins the index's first column by equality and ranges on its
        // second, so each chunk is a range read of that index.
        const { db, statements } = makeDb(makeTable(500, 1));
        await sweeps.purgeOrphanedPriceSnapshots(db, 500);
        assert.match(statements[0].sql,
            /WHERE reference_chain = 'BTC' AND reference_block >= \? LIMIT \?$/);
    });
}

describe('rollback price_snapshots purge @regression', function () {
    registerChunkTests();
    registerTimeoutTests();
    registerIndexTests();
});
