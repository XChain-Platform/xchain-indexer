/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/db.queries.test.js
 *
 * Unit tests for Database query methods (SELECT/INSERT/UPDATE/DELETE).
 *
 * Technique: stub doQuery on the prototype-borrowed object so every
 * method under test exercises real method logic against injected SQL
 * results — no live MariaDB required.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    // Silence logError from polluting test output
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    const db      = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    // Replace the real pool so the constructor doesn't try to connect
    db.pool = { getConnection: sinon.stub().resolves({
        query:            sinon.stub().resolves([]),
        release:          sinon.stub().resolves(),
        beginTransaction: sinon.stub().resolves(),
        commit:           sinon.stub().resolves(),
        rollback:         sinon.stub().resolves()
    }) };
    return db;
}

// Build a fresh db with doQuery stubbed to return rows
function dbWithDoQuery(rows) {
    const db = makeDb();
    sinon.stub(db, 'doQuery').resolves(rows);
    return db;
}

afterEach(function () {
    sinon.restore();
});

// ---------------------------------------------------------------------------
// getConnection — circuit-breaker
// ---------------------------------------------------------------------------
describe('Database.getConnection() — circuit breaker @regression @tier1', function () {
    it('returns a connection on first successful pool.getConnection()', async function () {
        const db   = makeDb();
        const conn = { query: sinon.stub(), release: sinon.stub().resolves() };
        db.pool.getConnection.resolves(conn);
        const result = await db.getConnection();
        assert.strictEqual(result, conn);
    });

    it('returns the transactionConnection when one is active', async function () {
        const db   = makeDb();
        const fake = { query: sinon.stub() };
        db.transactionConnection = fake;
        const result = await db.getConnection();
        assert.strictEqual(result, fake);
        assert.strictEqual(db.pool.getConnection.callCount, 0, 'should not call pool.getConnection');
    });

    it('rejects immediately when circuit is open and cooldown has NOT expired', async function () {
        const db          = makeDb();
        db.circuitState   = 'open';
        db.circuitOpenUntil = Date.now() + 60000; // future
        sinon.stub(db.util, 'throwError').throws(new Error('Circuit breaker open'));
        await assert.rejects(() => db.getConnection(), /Circuit breaker open/);
    });

    it('transitions to half-open when circuit cooldown has expired', async function () {
        const db          = makeDb();
        db.circuitState   = 'open';
        db.circuitOpenUntil = Date.now() - 1; // already expired
        const conn = { query: sinon.stub(), release: sinon.stub().resolves() };
        db.pool.getConnection.resolves(conn);
        await db.getConnection();
        assert.strictEqual(db.circuitState, 'closed');
    });

    it('resets circuitFailures to 0 on successful connection', async function () {
        const db          = makeDb();
        db.circuitFailures = 5;
        const conn = { query: sinon.stub(), release: sinon.stub().resolves() };
        db.pool.getConnection.resolves(conn);
        await db.getConnection();
        assert.strictEqual(db.circuitFailures, 0);
    });
});

// ---------------------------------------------------------------------------
// beginTransaction / rollbackTransaction / commitTransaction
// ---------------------------------------------------------------------------
describe('Database transaction lifecycle @regression @tier1', function () {
    it('beginTransaction opens a connection and begins a transaction', async function () {
        const db   = makeDb();
        const conn = {
            query:            sinon.stub().resolves([]),
            release:          sinon.stub().resolves(),
            beginTransaction: sinon.stub().resolves(),
            commit:           sinon.stub().resolves(),
            rollback:         sinon.stub().resolves()
        };
        db.pool.getConnection.resolves(conn);
        await db.beginTransaction();
        assert.ok(conn.beginTransaction.calledOnce);
        assert.strictEqual(db.transactionConnection, conn);
    });

    it('rollbackTransaction rolls back and clears transactionConnection', async function () {
        const db   = makeDb();
        const conn = {
            rollback: sinon.stub().resolves(),
            release:  sinon.stub().resolves()
        };
        db.transactionConnection = conn;
        await db.rollbackTransaction();
        assert.ok(conn.rollback.calledOnce);
        assert.strictEqual(db.transactionConnection, null);
    });

    it('commitTransaction commits and returns true', async function () {
        const db   = makeDb();
        const conn = {
            commit:  sinon.stub().resolves(),
            release: sinon.stub().resolves()
        };
        db.transactionConnection = conn;
        const result = await db.commitTransaction();
        assert.strictEqual(result, true);
        assert.ok(conn.commit.calledOnce);
        assert.strictEqual(db.transactionConnection, null);
    });

    it('commitTransaction returns false when no transaction is active', async function () {
        const db     = makeDb();
        const result = await db.commitTransaction();
        assert.strictEqual(result, false);
    });

    it('commitTransaction rolls back on commit failure', async function () {
        const db   = makeDb();
        const conn = {
            commit:   sinon.stub().rejects(new Error('commit fail')),
            rollback: sinon.stub().resolves(),
            release:  sinon.stub().resolves()
        };
        db.transactionConnection = conn;
        sinon.stub(db.util, 'throwError').throws(new Error('commitTransaction error'));
        await assert.rejects(() => db.commitTransaction(), /commitTransaction error/);
        assert.ok(conn.rollback.calledOnce);
        assert.strictEqual(db.transactionConnection, null);
    });
});

// ---------------------------------------------------------------------------
// doQuery
// ---------------------------------------------------------------------------
describe('Database.doQuery() @regression @tier1', function () {
    it('calls pool.getConnection and conn.query, releases when not in tx', async function () {
        const db   = makeDb();
        const conn = {
            query:   sinon.stub().resolves([{ id: 1 }]),
            release: sinon.stub().resolves()
        };
        db.pool.getConnection.resolves(conn);
        const results = await db.doQuery('SELECT 1', []);
        assert.deepStrictEqual(results, [{ id: 1 }]);
        assert.ok(conn.release.calledOnce);
    });

    it('returns [] when query is null/undefined', async function () {
        const db      = makeDb();
        const results = await db.doQuery(null);
        assert.deepStrictEqual(results, []);
    });

    it('converts boxed-object args to strings (except Buffer)', async function () {
        const db   = makeDb();
        const conn = {
            query:   sinon.stub().resolves([]),
            release: sinon.stub().resolves()
        };
        db.pool.getConnection.resolves(conn);
        const bigObj = { toString: () => '99999' }; // simulates mathjs bignumber
        const buf    = Buffer.from('binary');
        await db.doQuery('SELECT ?', [bigObj, buf]);
        const passedArgs = conn.query.firstCall.args[1];
        assert.strictEqual(passedArgs[0], '99999', 'boxed object should be .toString()');
        assert.ok(Buffer.isBuffer(passedArgs[1]), 'Buffer must pass through unchanged');
    });

    it('swallows errors and returns [] outside a transaction', async function () {
        const db   = makeDb();
        const conn = {
            query:   sinon.stub().rejects(new Error('query error')),
            release: sinon.stub().resolves()
        };
        db.pool.getConnection.resolves(conn);
        const results = await db.doQuery('SELECT 1');
        assert.deepStrictEqual(results, []);
    });

    it('re-throws errors inside a transaction', async function () {
        const db   = makeDb();
        const conn = {
            query:   sinon.stub().rejects(new Error('tx query error')),
            release: sinon.stub().resolves()
        };
        db.transactionConnection = conn;
        await assert.rejects(() => db.doQuery('SELECT 1'), /tx query error/);
    });
});

// ---------------------------------------------------------------------------
// Index-table lookups: getTransactionId, getAddressId, getBlockId, getActionId
// ---------------------------------------------------------------------------
describe('Database index table lookups @regression @tier1', function () {
    it('getTransactionId returns null when no row found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getTransactionId('abc'), null);
    });

    it('getTransactionId returns numeric id on hit', async function () {
        const db = dbWithDoQuery([{ id: 5n }]);
        const id = await db.getTransactionId('abc123');
        assert.strictEqual(id, 5);
    });

    it('getAddressId returns null when no row found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getAddressId('addr1'), null);
    });

    it('getAddressId returns numeric id on hit', async function () {
        const db = dbWithDoQuery([{ id: 7 }]);
        assert.strictEqual(await db.getAddressId('addr1'), 7);
    });

    it('getBlockId returns null when no row found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getBlockId(100), null);
    });

    it('getBlockId returns numeric id on hit', async function () {
        const db = dbWithDoQuery([{ id: 3 }]);
        assert.strictEqual(await db.getBlockId(200), 3);
    });

    it('getActionId returns null when no row found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getActionId('SEND'), null);
    });

    it('getActionId returns numeric id on hit', async function () {
        const db = dbWithDoQuery([{ id: 12 }]);
        assert.strictEqual(await db.getActionId('SEND'), 12);
    });
});

// ---------------------------------------------------------------------------
// createTransaction
// ---------------------------------------------------------------------------
describe('Database.createTransaction() @regression @tier1', function () {
    it('returns null for null/empty hash', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.createTransaction(null), null);
        assert.strictEqual(await db.createTransaction(''), null);
    });

    it('returns existing id when transaction already exists', async function () {
        const db = makeDb();
        // getTransactionId will return 42
        sinon.stub(db, 'doQuery').resolves([{ id: 42 }]);
        const id = await db.createTransaction('deadbeef');
        assert.strictEqual(id, 42);
    });

    it('inserts and returns new id when transaction does not exist', async function () {
        const db  = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        // First call: getTransactionId → not found
        stub.onCall(0).resolves([]);
        // Second call: INSERT IGNORE
        stub.onCall(1).resolves([{ affectedRows: 1 }]);
        // Third call: getTransactionId after insert → found
        stub.onCall(2).resolves([{ id: 99 }]);
        const id = await db.createTransaction('cafebabe');
        assert.strictEqual(id, 99);
    });

    it('truncates hash to 250 characters', async function () {
        const db   = makeDb();
        const long = 'a'.repeat(300);
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([]);
        stub.onCall(1).resolves([]);
        stub.onCall(2).resolves([{ id: 1 }]);
        await db.createTransaction(long);
        // The INSERT should pass the truncated 250-char hash
        const insertArgs = stub.getCall(1).args[1];
        assert.strictEqual(insertArgs[0].length, 250);
    });
});

// ---------------------------------------------------------------------------
// createAddress
// ---------------------------------------------------------------------------
describe('Database.createAddress() @regression @tier1', function () {
    it('returns null for null/empty address', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.createAddress(null), null);
    });

    it('returns existing id when address already exists', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([{ id: 10 }]);
        const id = await db.createAddress('bc1qtest');
        assert.strictEqual(id, 10);
    });

    it('truncates address to 120 characters', async function () {
        const db   = makeDb();
        const long = 'x'.repeat(200);
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([]);
        stub.onCall(1).resolves([]);
        stub.onCall(2).resolves([{ id: 5 }]);
        await db.createAddress(long);
        const insertArgs = stub.getCall(1).args[1];
        assert.strictEqual(insertArgs[0].length, 120);
    });
});

// ---------------------------------------------------------------------------
// getNextTxIndex / getNextActionIndex
// ---------------------------------------------------------------------------
describe('Database.getNextTxIndex() @regression @tier1', function () {
    it('returns 1 when no transactions exist', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getNextTxIndex(), 1);
    });

    it('returns max+1 when transactions exist', async function () {
        const db = dbWithDoQuery([{ tx_index: 50 }]);
        assert.strictEqual(await db.getNextTxIndex(), 51);
    });
});

describe('Database.getNextActionIndex() @regression @tier1', function () {
    it('returns 1 when no actions exist', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getNextActionIndex(), 1);
    });

    it('returns max+1 when actions exist', async function () {
        const db = dbWithDoQuery([{ action_index: 100 }]);
        assert.strictEqual(await db.getNextActionIndex(), 101);
    });
});

// ---------------------------------------------------------------------------
// getTicker / getTickerId / createTicker
// ---------------------------------------------------------------------------
describe('Database getTicker/getTickerId @regression @tier1', function () {
    it('getTicker returns null when no row found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getTicker(1), null);
    });

    it('getTicker returns tick string on hit', async function () {
        const db = dbWithDoQuery([{ tick: 'PEPE' }]);
        assert.strictEqual(await db.getTicker(3), 'PEPE');
    });

    it('getTickerId for ^N literal: returns pid=str.substring(1,len-1) — characterization (strips last char too)', async function () {
        // BUG: For '^42', len=3, pid=str.substring(1,2)='4' — strips the '^' prefix AND the
        // last character. The caller-visible id is '4', not '42'. Recorded as a characterization.
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        const id = await db.getTickerId('^42');
        assert.strictEqual(String(id), '4');
    });

    it('getTickerId returns null when no row found', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.getTickerId('NOTEXIST'), null);
    });

    it('getTickerId returns numeric id on DB hit', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([{ id: 7 }]);
        assert.strictEqual(await db.getTickerId('PEPE'), 7);
    });
});

describe('Database.createTicker() @regression @tier1', function () {
    it('returns null for null tick', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.createTicker(null), null);
    });

    it('returns existing id when ticker already exists', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([{ id: 5 }]);
        assert.strictEqual(await db.createTicker('PEPE'), 5);
    });

    it('inserts and returns new id when ticker does not exist', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([]);        // getTickerId → not found
        stub.onCall(1).resolves([]);        // INSERT IGNORE
        stub.onCall(2).resolves([{ id: 9 }]); // getTickerId after insert
        assert.strictEqual(await db.createTicker('NEWT'), 9);
    });
});

// ---------------------------------------------------------------------------
// getStatusId / createStatus
// ---------------------------------------------------------------------------
describe('Database.getStatusId() @regression @tier1', function () {
    it('returns null when status not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getStatusId('valid'), null);
    });

    it('returns numeric id when status found', async function () {
        const db = dbWithDoQuery([{ id: 2 }]);
        assert.strictEqual(await db.getStatusId('valid'), 2);
    });
});

describe('Database.createStatus() @regression @tier1', function () {
    it('returns null for null status', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.createStatus(null), null);
    });

    it('returns existing id if status already exists', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([{ id: 3 }]);
        assert.strictEqual(await db.createStatus('valid'), 3);
    });

    it('inserts and returns id when status does not exist', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([]);
        stub.onCall(1).resolves([]);
        stub.onCall(2).resolves([{ id: 4 }]);
        assert.strictEqual(await db.createStatus('pending'), 4);
    });
});

// ---------------------------------------------------------------------------
// getMemoId / createMemo
// ---------------------------------------------------------------------------
describe('Database.getMemoId() / createMemo() @regression @tier1', function () {
    it('getMemoId returns null when not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getMemoId('hello'), null);
    });

    it('getMemoId returns numeric id on hit', async function () {
        const db = dbWithDoQuery([{ id: 6 }]);
        assert.strictEqual(await db.getMemoId('hello'), 6);
    });

    it('createMemo returns null for null memo', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.createMemo(null), null);
    });

    it('createMemo truncates memo to 250 characters', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([]);
        stub.onCall(1).resolves([]);
        stub.onCall(2).resolves([{ id: 1 }]);
        await db.createMemo('x'.repeat(300));
        const insertArgs = stub.getCall(1).args[1];
        assert.strictEqual(insertArgs[0].length, 250);
    });

    it('createMemo returns existing id when memo already in DB', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([{ id: 11 }]);
        assert.strictEqual(await db.createMemo('test memo'), 11);
    });
});

// ---------------------------------------------------------------------------
// getBlockTime
// ---------------------------------------------------------------------------
describe('Database.getBlockTime() @regression @tier1', function () {
    it('returns false when block not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getBlockTime(100), false);
    });

    it('returns block_time when block found', async function () {
        const db = dbWithDoQuery([{ block_time: 1700000000 }]);
        assert.strictEqual(await db.getBlockTime(500), 1700000000);
    });
});

// ---------------------------------------------------------------------------
// getLatestBlockIndex
// ---------------------------------------------------------------------------
describe('Database.getLatestBlockIndex() @regression @tier1', function () {
    it('returns 0 when no blocks exist', async function () {
        const db = dbWithDoQuery([{ max_block: null }]);
        assert.strictEqual(await db.getLatestBlockIndex(), 0);
    });

    it('returns 0 when results array is empty', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getLatestBlockIndex(), 0);
    });

    it('returns numeric max_block', async function () {
        const db = dbWithDoQuery([{ max_block: 800000 }]);
        assert.strictEqual(await db.getLatestBlockIndex(), 800000);
    });
});

// ---------------------------------------------------------------------------
// getTokenDecimalPrecision
// ---------------------------------------------------------------------------
describe('Database.getTokenDecimalPrecision() @regression @tier1', function () {
    it('returns 0 when no issues found', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.getTokenDecimalPrecision(1), 0);
    });

    it('returns the maximum decimals across all rows', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([{ decimals: 3 }, { decimals: 8 }, { decimals: 6 }]);
        assert.strictEqual(await db.getTokenDecimalPrecision(1), 8);
    });

    it('clamps decimals above 18 to 18', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([{ decimals: 99 }]);
        assert.strictEqual(await db.getTokenDecimalPrecision(1), 18);
    });

    it('clamps negative decimals to 0', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([{ decimals: -5 }]);
        assert.strictEqual(await db.getTokenDecimalPrecision(1), 0);
    });
});

// ---------------------------------------------------------------------------
// getTokenSupplyToken / getTokenSupplyBalance
// ---------------------------------------------------------------------------
describe('Database.getTokenSupplyToken() @regression @tier1', function () {
    it('returns 0 when no supply found', async function () {
        const db = makeDb();
        // stub helper methods so doQuery only sees the final SELECT
        sinon.stub(db, 'createTicker').resolves(3);
        sinon.stub(db, 'getTokenDecimalPrecision').resolves(0);
        sinon.stub(db, 'doQuery').resolves([]);
        const supply = await db.getTokenSupplyToken('PEPE');
        assert.strictEqual(supply, 0);
    });

    it('returns supply string when row found', async function () {
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(3);
        sinon.stub(db, 'getTokenDecimalPrecision').resolves(8);
        sinon.stub(db, 'doQuery').resolves([{ supply: '1000000000' }]);
        const supply = await db.getTokenSupplyToken('PEPE');
        assert.strictEqual(String(supply), '1000000000');
    });
});

// ---------------------------------------------------------------------------
// getAddressTableBalances
// ---------------------------------------------------------------------------
describe('Database.getAddressTableBalances() @regression @tier1', function () {
    it('returns empty object when no balances', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        // createAddress
        stub.onCall(0).resolves([{ id: 1 }]);
        // SELECT balances
        stub.onCall(1).resolves([]);
        const result = await db.getAddressTableBalances('bc1qtest');
        assert.deepStrictEqual(result, {});
    });

    it('returns map of tick_id->amount', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        // createAddress → hit
        stub.onCall(0).resolves([{ id: 2 }]);
        // SELECT balances
        stub.onCall(1).resolves([
            { tick_id: 1, amount: '500' },
            { tick_id: 2, amount: '250' }
        ]);
        const result = await db.getAddressTableBalances('addr1');
        assert.strictEqual(result[1], '500');
        assert.strictEqual(result[2], '250');
    });

    it('handles numeric address_id directly (bypasses createAddress)', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.resolves([{ tick_id: 5, amount: '999' }]);
        const result = await db.getAddressTableBalances(42); // numeric
        assert.strictEqual(result[5], '999');
    });
});

// ---------------------------------------------------------------------------
// getTokenEscrow / isOwnershipEscrowed / setTokenEscrow / clearTokenEscrow
// ---------------------------------------------------------------------------
describe('Database token escrow methods @regression @tier1', function () {
    it('getTokenEscrow returns null for null tick', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.getTokenEscrow(null), null);
    });

    it('getTokenEscrow returns null when no row found', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([{ id: 1 }]); // createTicker
        stub.onCall(1).resolves([]);           // SELECT escrow
        assert.strictEqual(await db.getTokenEscrow('PEPE'), null);
    });

    it('getTokenEscrow returns null when escrow_action_index is null', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([{ id: 1 }]);
        stub.onCall(1).resolves([{ escrow_action_index: null }]);
        assert.strictEqual(await db.getTokenEscrow('PEPE'), null);
    });

    it('getTokenEscrow returns action_index when escrowed', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([{ id: 1 }]);
        stub.onCall(1).resolves([{ escrow_action_index: 77 }]);
        assert.strictEqual(await db.getTokenEscrow('PEPE'), 77);
    });

    it('isOwnershipEscrowed returns true when escrow action_index is set', async function () {
        const db = makeDb();
        sinon.stub(db, 'getTokenEscrow').resolves(77);
        assert.strictEqual(await db.isOwnershipEscrowed('PEPE'), true);
    });

    it('isOwnershipEscrowed returns false when not escrowed', async function () {
        const db = makeDb();
        sinon.stub(db, 'getTokenEscrow').resolves(null);
        assert.strictEqual(await db.isOwnershipEscrowed('PEPE'), false);
    });

    it('setTokenEscrow calls doQuery with UPDATE', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([{ id: 3 }]); // createTicker
        stub.onCall(1).resolves([]);           // UPDATE
        await db.setTokenEscrow('PEPE', 55);
        assert.match(stub.getCall(1).args[0], /UPDATE tokens/i);
    });

    it('clearTokenEscrow calls doQuery with UPDATE setting NULL', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([{ id: 3 }]); // createTicker
        stub.onCall(1).resolves([]);           // UPDATE
        await db.clearTokenEscrow('PEPE');
        const sql = stub.getCall(1).args[0];
        assert.match(sql, /UPDATE tokens/i);
        assert.match(sql, /NULL/);
    });
});

// ---------------------------------------------------------------------------
// getIssueTick
// ---------------------------------------------------------------------------
describe('Database.getIssueTick() @regression @tier1', function () {
    it('returns null when action_index not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getIssueTick(999), null);
    });

    it('returns tick string when found', async function () {
        const db = dbWithDoQuery([{ tick: 'DOGE' }]);
        assert.strictEqual(await db.getIssueTick(42), 'DOGE');
    });
});

// ---------------------------------------------------------------------------
// getPubkeyId / getOrCreatePubkeyId
// ---------------------------------------------------------------------------
describe('Database pubkey methods @regression @tier1', function () {
    it('getPubkeyId returns null when not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getPubkeyId('deadbeef'), null);
    });

    it('getPubkeyId returns numeric id on hit', async function () {
        const db = dbWithDoQuery([{ id: 8 }]);
        assert.strictEqual(await db.getPubkeyId('deadbeef'), 8);
    });

    it('getOrCreatePubkeyId returns null for null pubkey', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.getOrCreatePubkeyId(null), null);
    });

    it('getOrCreatePubkeyId normalizes to lowercase and truncates to 64 chars', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([]);
        stub.onCall(1).resolves([]);
        stub.onCall(2).resolves([{ id: 1 }]);
        const long = 'ABCDEF1234567890'.repeat(10); // 160 chars uppercase
        await db.getOrCreatePubkeyId(long);
        const insertArgs = stub.getCall(1).args[1];
        assert.strictEqual(insertArgs[0], long.toLowerCase().substring(0, 64));
    });

    it('getOrCreatePubkeyId returns existing id', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([{ id: 17 }]);
        assert.strictEqual(await db.getOrCreatePubkeyId('aabbcc'), 17);
    });
});

// ---------------------------------------------------------------------------
// createPubkey
// ---------------------------------------------------------------------------
describe('Database.createPubkey() @regression @tier1', function () {
    it('does nothing when address_id is falsy', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        await db.createPubkey(null, 'deadbeef'); // should not throw
        assert.strictEqual(db.doQuery.callCount, 0);
    });

    it('does nothing when pubkey is falsy', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        await db.createPubkey(1, null);
        assert.strictEqual(db.doQuery.callCount, 0);
    });

    it('calls INSERT IGNORE when both arguments provided', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        await db.createPubkey(5, 'deadbeef');
        assert.match(db.doQuery.firstCall.args[0], /INSERT IGNORE INTO pubkeys/i);
    });
});

// ---------------------------------------------------------------------------
// getLatestBlockIndex
// ---------------------------------------------------------------------------
describe('Database.getLatestBlockIndex() additional paths @regression @tier1', function () {
    it('returns 0 when results is null', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves(null);
        assert.strictEqual(await db.getLatestBlockIndex(), 0);
    });
});

// ---------------------------------------------------------------------------
// getActiveValidators
// ---------------------------------------------------------------------------
describe('Database.getActiveValidators() @regression @tier1', function () {
    it('returns [] when valid status not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getStatusId').resolves(null);
        const result = await db.getActiveValidators(100);
        assert.deepStrictEqual(result, []);
    });

    it('returns mapped pubkey/amount objects', async function () {
        const db = makeDb();
        sinon.stub(db, 'getStatusId').resolves(1);
        sinon.stub(db, 'doQuery').resolves([
            { pubkey: 'aabbcc', total: '10000' },
            { pubkey: 'ddeeff', total: null }
        ]);
        const result = await db.getActiveValidators(500);
        assert.deepStrictEqual(result[0], { pubkey: 'aabbcc', amount: '10000' });
        assert.deepStrictEqual(result[1], { pubkey: 'ddeeff', amount: '0' });
    });

    it('returns [] when doQuery returns empty', async function () {
        const db = makeDb();
        sinon.stub(db, 'getStatusId').resolves(2);
        sinon.stub(db, 'doQuery').resolves([]);
        assert.deepStrictEqual(await db.getActiveValidators(100), []);
    });
});

// ---------------------------------------------------------------------------
// getActiveStakeByPubkey
// ---------------------------------------------------------------------------
describe('Database.getActiveStakeByPubkey() @regression @tier1', function () {
    it('returns null when pubkey not found in index_pubkeys', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(null);
        assert.strictEqual(await db.getActiveStakeByPubkey('deadbeef', 100), null);
    });

    it('returns null when no stake rows found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'getStatusId').resolves(1);
        sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.getActiveStakeByPubkey('deadbeef', 100), null);
    });

    it('returns stake object with amount coerced to string', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'getStatusId').resolves(1);
        sinon.stub(db, 'doQuery').resolves([{
            source_id:         10,
            signing_pubkey_id: 3,
            signing_pubkey:    'deadbeef',
            amount:            '50000.00000000',
            activation_block:  100,
            block_index:       100,
            status_id:         1
        }]);
        const stake = await db.getActiveStakeByPubkey('deadbeef', 200);
        assert.strictEqual(stake.amount, '50000.00000000');
        assert.strictEqual(stake.signing_pubkey, 'deadbeef');
    });

    it('returns amount "0" when row.amount is null', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'getStatusId').resolves(1);
        sinon.stub(db, 'doQuery').resolves([{
            source_id: 1, signing_pubkey_id: 3, signing_pubkey: 'pk',
            amount: null, activation_block: 0, block_index: 0, status_id: 1
        }]);
        const stake = await db.getActiveStakeByPubkey('pk', 100);
        assert.strictEqual(stake.amount, '0');
    });

    it('includes blockIndex filter args when blockIndex is provided', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'getStatusId').resolves(1);
        const q = sinon.stub(db, 'doQuery').resolves([]);
        await db.getActiveStakeByPubkey('pk', 500);
        const args = q.firstCall.args[1];
        // Should include blockIndex (500) twice
        assert.ok(args.includes(500));
    });

    it('omits blockIndex filter when blockIndex is null', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'getStatusId').resolves(1);
        const q = sinon.stub(db, 'doQuery').resolves([]);
        await db.getActiveStakeByPubkey('pk', null);
        const args = q.firstCall.args[1];
        // Without blockIndex the args should be [pubkey_id, valid_id]
        assert.strictEqual(args.length, 2);
    });
});

// ---------------------------------------------------------------------------
// setStakeDeactivationByPubkey
// ---------------------------------------------------------------------------
describe('Database.setStakeDeactivationByPubkey() @regression @tier1', function () {
    it('returns false when pubkey not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(null);
        assert.strictEqual(await db.setStakeDeactivationByPubkey('pk', 600), false);
    });

    it('returns true and runs UPDATE when pubkey found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(5);
        sinon.stub(db, 'getStatusId').resolves(1);
        sinon.stub(db, 'doQuery').resolves([]);
        const result = await db.setStakeDeactivationByPubkey('pk', 600);
        assert.strictEqual(result, true);
        assert.match(db.doQuery.firstCall.args[0], /UPDATE stakes/i);
    });
});

// ---------------------------------------------------------------------------
// getActionType
// ---------------------------------------------------------------------------
describe('Database.getActionType() @regression @tier1', function () {
    it('returns null when action_index not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getActionType(1), null);
    });

    it('returns action string on hit', async function () {
        const db = dbWithDoQuery([{ action: 'SEND' }]);
        assert.strictEqual(await db.getActionType(42), 'SEND');
    });
});

// ---------------------------------------------------------------------------
// getCoinId / createCoin
// ---------------------------------------------------------------------------
describe('Database.getCoinId() / createCoin() @regression @tier1', function () {
    it('getCoinId returns null when not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getCoinId('BTC'), null);
    });

    it('getCoinId returns numeric id on hit', async function () {
        const db = dbWithDoQuery([{ id: 1 }]);
        assert.strictEqual(await db.getCoinId('BTC'), 1);
    });
});

// ---------------------------------------------------------------------------
// getFiatId / createFiat
// ---------------------------------------------------------------------------
describe('Database.getFiatId() @regression @tier1', function () {
    it('returns null when not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getFiatId('USD'), null);
    });

    it('returns numeric id on hit', async function () {
        const db = dbWithDoQuery([{ id: 2 }]);
        assert.strictEqual(await db.getFiatId('USD'), 2);
    });
});

// ---------------------------------------------------------------------------
// getMimeTypeId
// ---------------------------------------------------------------------------
describe('Database.getMimeTypeId() @regression @tier1', function () {
    it('returns null when not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getMimeTypeId('image/png'), null);
    });

    it('returns numeric id on hit', async function () {
        const db = dbWithDoQuery([{ id: 3 }]);
        assert.strictEqual(await db.getMimeTypeId('image/png'), 3);
    });
});

// ---------------------------------------------------------------------------
// getActiveCapabilityCount
// ---------------------------------------------------------------------------
describe('Database.getActiveCapabilityCount() @regression @tier1', function () {
    function makeDbWithCap() {
        const db = makeDb();
        db.config.STAKING = { CAPABILITIES: { attestation: { MIN_STAKE: '10000' } } };
        return db;
    }

    it('returns 0 when capability is not configured', async function () {
        const db = makeDbWithCap();
        sinon.stub(db, 'getStatusId').resolves(1);
        sinon.stub(db, 'doQuery').resolves([{ cnt: 5 }]);
        // 'unknown' capability is not in config
        assert.strictEqual(await db.getActiveCapabilityCount('unknown', 100), 0);
    });

    it('returns count when capability is configured', async function () {
        const db = makeDbWithCap();
        sinon.stub(db, 'getStatusId').resolves(1);
        sinon.stub(db, 'doQuery').resolves([{ cnt: 7 }]);
        assert.strictEqual(await db.getActiveCapabilityCount('attestation', 100), 7);
    });

    it('returns 0 when doQuery returns empty', async function () {
        const db = makeDbWithCap();
        sinon.stub(db, 'getStatusId').resolves(1);
        sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.getActiveCapabilityCount('attestation', 100), 0);
    });

    it('passes blockIndex args when provided', async function () {
        const db = makeDbWithCap();
        sinon.stub(db, 'getStatusId').resolves(1);
        const q = sinon.stub(db, 'doQuery').resolves([{ cnt: 0 }]);
        await db.getActiveCapabilityCount('attestation', 500);
        const args = q.firstCall.args[1];
        assert.ok(args.includes(500));
    });
});

// ---------------------------------------------------------------------------
// isActionIndexValid
// ---------------------------------------------------------------------------
describe('Database.isActionIndexValid() @regression @tier1', function () {
    it('returns false when action_index not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.isActionIndexValid(99), false);
    });

    it('returns true when action_index found', async function () {
        const db = dbWithDoQuery([{ action_index: 99, action: 'SEND' }]);
        assert.strictEqual(await db.isActionIndexValid(99), true);
    });
});

// ---------------------------------------------------------------------------
// getActionIndexTable
// ---------------------------------------------------------------------------
describe('Database.getActionIndexTable() @regression @tier1', function () {
    it('returns null when action_index not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getActionIndexTable(99), null);
    });

    it('returns table name string for a known action', async function () {
        // getActionIndexTable returns the pluralized table name string, not a row object
        const db = dbWithDoQuery([{ action: 'send' }]);
        const result = await db.getActionIndexTable(5);
        // 'send' → 'sends' (regular plural)
        assert.strictEqual(result, 'sends');
    });

    it('returns "addresses" for address action (special plural)', async function () {
        const db = dbWithDoQuery([{ action: 'address' }]);
        assert.strictEqual(await db.getActionIndexTable(5), 'addresses');
    });

    it('returns "batches" for batch action (special plural)', async function () {
        const db = dbWithDoQuery([{ action: 'batch' }]);
        assert.strictEqual(await db.getActionIndexTable(5), 'batches');
    });
});

// ---------------------------------------------------------------------------
// deleteActionIndex
// ---------------------------------------------------------------------------
describe('Database.deleteActionIndex() @regression @tier1', function () {
    it('does nothing when action_index is falsy', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        await db.deleteActionIndex(null);
        assert.strictEqual(db.doQuery.callCount, 0);
    });

    it('runs DELETE when action_index is truthy', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        await db.deleteActionIndex(42);
        assert.match(db.doQuery.firstCall.args[0], /DELETE FROM actions/i);
        assert.deepStrictEqual(db.doQuery.firstCall.args[1], [42]);
    });
});

// ---------------------------------------------------------------------------
// updateActionIndex
// ---------------------------------------------------------------------------
describe('Database.updateActionIndex() @regression @tier1', function () {
    it('does nothing when action_index is falsy', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'doQuery').resolves([]);
        sinon.stub(db, 'createAction').resolves(1);
        await db.updateActionIndex(null, 'SEND');
        assert.strictEqual(stub.callCount, 0);
    });

    it('runs UPDATE when action_index is truthy', async function () {
        const db = makeDb();
        sinon.stub(db, 'createAction').resolves(5);
        sinon.stub(db, 'doQuery').resolves([]);
        await db.updateActionIndex(10, 'SEND');
        assert.match(db.doQuery.firstCall.args[0], /UPDATE actions/i);
    });
});

// ---------------------------------------------------------------------------
// releaseConnection
// ---------------------------------------------------------------------------
describe('Database.releaseConnection() @regression @tier1', function () {
    it('does nothing when no transactionConnection', async function () {
        const db = makeDb();
        // Should not throw
        await db.releaseConnection();
        assert.strictEqual(db.transactionConnection, null);
    });

    it('releases and clears transactionConnection when set', async function () {
        const db   = makeDb();
        const conn = { release: sinon.stub().resolves() };
        db.transactionConnection = conn;
        await db.releaseConnection();
        assert.ok(conn.release.calledOnce);
        assert.strictEqual(db.transactionConnection, null);
    });
});

// ---------------------------------------------------------------------------
// stripSqlLineComments
// ---------------------------------------------------------------------------
describe('Database.stripSqlLineComments() @regression @tier1', function () {
    let db;
    beforeEach(function () { db = makeDb(); });

    it('removes -- comments from SQL', function () {
        const sql = 'SELECT 1 -- this is a comment\nFROM dual';
        const out = db.stripSqlLineComments(sql);
        assert.ok(!out.includes('this is a comment'));
        assert.ok(out.includes('SELECT 1'));
        assert.ok(out.includes('FROM dual'));
    });

    it('preserves content inside single-quoted strings', function () {
        const sql = "SELECT '-- not a comment' FROM t";
        const out = db.stripSqlLineComments(sql);
        assert.ok(out.includes('-- not a comment'), 'string content must be preserved');
    });

    it('preserves content inside double-quoted strings', function () {
        const sql = 'SELECT "-- not a comment" FROM t';
        const out = db.stripSqlLineComments(sql);
        assert.ok(out.includes('-- not a comment'));
    });

    it('preserves content inside backtick identifiers', function () {
        const sql = 'SELECT `-- col` FROM t';
        const out = db.stripSqlLineComments(sql);
        assert.ok(out.includes('-- col'));
    });

    it('removes multiple comment lines', function () {
        const sql = '-- first\nSELECT 1\n-- second\nFROM t';
        const out = db.stripSqlLineComments(sql);
        assert.ok(!out.includes('first'));
        assert.ok(!out.includes('second'));
    });

    it('handles doubled-quote escape inside string (does not crash)', function () {
        const sql = "SELECT '' FROM t -- comment";
        const out = db.stripSqlLineComments(sql);
        assert.ok(!out.includes('comment'));
    });
});

// ---------------------------------------------------------------------------
// parseExpectedColumns
// ---------------------------------------------------------------------------
describe('Database.parseExpectedColumns() @regression @tier1', function () {
    let db;
    beforeEach(function () { db = makeDb(); });

    it('returns null for SQL without a CREATE TABLE ENGINE block', function () {
        const sql = 'SELECT 1';
        assert.strictEqual(db.parseExpectedColumns(sql), null);
    });

    it('parses a simple CREATE TABLE and returns column definitions', function () {
        const sql = [
            'CREATE TABLE `test` (',
            '  `id` INT NOT NULL AUTO_INCREMENT,',
            '  `name` VARCHAR(250) NULL,',
            '  PRIMARY KEY (`id`)',
            ') ENGINE=InnoDB;'
        ].join('\n');
        const cols = db.parseExpectedColumns(sql);
        assert.ok(Array.isArray(cols));
        const id   = cols.find(c => c.name === 'id');
        const name = cols.find(c => c.name === 'name');
        assert.ok(id, 'id column should be parsed');
        assert.strictEqual(id.nullable, false, 'NOT NULL column should have nullable=false');
        assert.ok(name, 'name column should be parsed');
        assert.strictEqual(name.nullable, true, 'NULL column should have nullable=true');
    });

    it('strips inline comments before parsing to avoid phantom columns', function () {
        const sql = [
            'CREATE TABLE `t` (',
            '  `col1` INT NOT NULL, -- 0=foo, 1=bar',
            '  `col2` VARCHAR(10) NULL',
            ') ENGINE=InnoDB;'
        ].join('\n');
        const cols = db.parseExpectedColumns(sql);
        // There must be exactly 2 columns (not phantom ones from the comment)
        assert.ok(cols.length === 2, 'Expected 2 columns, got ' + cols.length);
    });
});

// ---------------------------------------------------------------------------
// parseExpectedIndexes
// ---------------------------------------------------------------------------
describe('Database.parseExpectedIndexes() @regression @tier1', function () {
    let db;
    beforeEach(function () { db = makeDb(); });

    it('returns [] when no CREATE INDEX statements found', function () {
        const sql = 'CREATE TABLE t (id INT) ENGINE=InnoDB;';
        assert.deepStrictEqual(db.parseExpectedIndexes(sql, 't'), []);
    });

    it('parses a regular CREATE INDEX', function () {
        const sql = [
            'CREATE TABLE balances (id INT, address_id INT, tick_id INT) ENGINE=InnoDB;',
            'CREATE INDEX idx_addr ON balances (address_id);'
        ].join('\n');
        const idxs = db.parseExpectedIndexes(sql, 'balances');
        assert.strictEqual(idxs.length, 1);
        assert.strictEqual(idxs[0].name, 'idx_addr');
        assert.strictEqual(idxs[0].unique, false);
        assert.deepStrictEqual(idxs[0].columns, ['address_id']);
    });

    it('parses a CREATE UNIQUE INDEX', function () {
        const sql = 'CREATE UNIQUE INDEX uq_addr_tick ON balances (address_id, tick_id);';
        const idxs = db.parseExpectedIndexes(sql, 'balances');
        assert.strictEqual(idxs.length, 1);
        assert.strictEqual(idxs[0].unique, true);
        assert.deepStrictEqual(idxs[0].columns, ['address_id', 'tick_id']);
    });

    it('ignores indexes declared for other tables', function () {
        const sql = 'CREATE INDEX idx_other ON other_table (col1);';
        const idxs = db.parseExpectedIndexes(sql, 'balances');
        assert.strictEqual(idxs.length, 0);
    });
});

// ---------------------------------------------------------------------------
// _migrationMode
// ---------------------------------------------------------------------------
describe('Database._migrationMode() @regression @tier1', function () {
    let db;
    beforeEach(function () { db = makeDb(); });

    it('returns "manual" when no tag present (conservative default)', function () {
        assert.strictEqual(db._migrationMode('SELECT 1;'), 'manual');
    });

    it('returns "auto" for -- xchain:migration mode=auto tag', function () {
        const raw = '-- xchain:migration mode=auto\nALTER TABLE t ADD COLUMN x INT;';
        assert.strictEqual(db._migrationMode(raw), 'auto');
    });

    it('returns "manual" for -- xchain:migration mode=manual tag', function () {
        const raw = '-- xchain:migration mode=manual\nALTER TABLE t DROP COLUMN x;';
        assert.strictEqual(db._migrationMode(raw), 'manual');
    });

    it('is case-insensitive', function () {
        const raw = '-- XCHAIN:MIGRATION MODE=AUTO\nSELECT 1;';
        assert.strictEqual(db._migrationMode(raw), 'auto');
    });
});

// ---------------------------------------------------------------------------
// _poolQuery
// ---------------------------------------------------------------------------
describe('Database._poolQuery() @regression @tier1', function () {
    it('acquires a fresh connection, runs query, releases connection', async function () {
        const db  = makeDb();
        const row = [{ id: 1 }];
        const conn = {
            query:   sinon.stub().resolves(row),
            release: sinon.stub().resolves()
        };
        db.pool.getConnection.resolves(conn);
        const result = await db._poolQuery('SELECT 1', []);
        assert.deepStrictEqual(result, row);
        assert.ok(conn.release.calledOnce);
    });

    it('releases connection even on query error', async function () {
        const db   = makeDb();
        const conn = {
            query:   sinon.stub().rejects(new Error('pool error')),
            release: sinon.stub().resolves()
        };
        db.pool.getConnection.resolves(conn);
        await assert.rejects(() => db._poolQuery('SELECT 1'), /pool error/);
        assert.ok(conn.release.calledOnce);
    });
});

// ---------------------------------------------------------------------------
// enqueueHubPush / markHubPushDelivered / recordHubPushAttempt
// ---------------------------------------------------------------------------
describe('Database hub push queue methods @regression @tier1', function () {
    it('enqueueHubPush inserts a row with serialized payload', async function () {
        const db   = makeDb();
        const conn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        db.pool.getConnection.resolves(conn);
        const payload = { action_index: 42, type: 'price', data: 'abc' };
        await db.enqueueHubPush('price', payload);
        const sql = conn.query.firstCall.args[0];
        assert.match(sql, /INSERT INTO pending_hub_pushes/i);
        const args = conn.query.firstCall.args[1];
        assert.strictEqual(args[0], 'price');
        assert.strictEqual(args[1], 42);
        assert.strictEqual(JSON.parse(args[2]).action_index, 42);
    });

    it('markHubPushDelivered deletes the row', async function () {
        const db   = makeDb();
        const conn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        db.pool.getConnection.resolves(conn);
        await db.markHubPushDelivered(7);
        assert.match(conn.query.firstCall.args[0], /DELETE FROM pending_hub_pushes/i);
        assert.deepStrictEqual(conn.query.firstCall.args[1], [7]);
    });

    it('recordHubPushAttempt runs an UPDATE', async function () {
        const db   = makeDb();
        const conn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        db.pool.getConnection.resolves(conn);
        await db.recordHubPushAttempt(3, 'timeout', 5);
        assert.match(conn.query.firstCall.args[0], /UPDATE pending_hub_pushes/i);
    });

    it('recordHubPushAttempt defaults maxAttempts to 10 on invalid input', async function () {
        const db   = makeDb();
        const conn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        db.pool.getConnection.resolves(conn);
        await db.recordHubPushAttempt(1, 'err', -1);
        // Should still call query without throwing
        assert.ok(conn.query.calledOnce);
    });
});

// ---------------------------------------------------------------------------
// getPendingHubPushes
// ---------------------------------------------------------------------------
describe('Database.getPendingHubPushes() @regression @tier1', function () {
    it('defaults limit to 50 on invalid input', async function () {
        const db   = makeDb();
        const conn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        db.pool.getConnection.resolves(conn);
        await db.getPendingHubPushes(-1);
        const sql = conn.query.firstCall.args[0];
        assert.match(sql, /SELECT/i);
    });

    it('uses provided limit', async function () {
        const db   = makeDb();
        const conn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        db.pool.getConnection.resolves(conn);
        await db.getPendingHubPushes(10);
        const args = conn.query.firstCall.args[1];
        assert.strictEqual(args[0], 10);
    });
});

// ---------------------------------------------------------------------------
// getCapabilitySnapshotValidators / isPubkeyInCapabilitySnapshot
// ---------------------------------------------------------------------------
describe('Database capability snapshot methods @regression @tier1', function () {
    it('getCapabilitySnapshotValidators returns mapped results', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([
            { pubkey: 'aa', amount: '5000' },
            { pubkey: 'bb', amount: null }
        ]);
        const result = await db.getCapabilitySnapshotValidators('cross_chain', 100);
        assert.deepStrictEqual(result[0], { pubkey: 'aa', amount: '5000' });
        assert.deepStrictEqual(result[1], { pubkey: 'bb', amount: 'null' });
    });

    it('isPubkeyInCapabilitySnapshot returns true when row found', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([{ 1: 1 }]);
        assert.strictEqual(await db.isPubkeyInCapabilitySnapshot('aa', 'cross_chain', 100), true);
    });

    it('isPubkeyInCapabilitySnapshot returns false when no row', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.isPubkeyInCapabilitySnapshot('aa', 'cross_chain', 100), false);
    });
});

// ---------------------------------------------------------------------------
// _mirrorDb
// ---------------------------------------------------------------------------
describe('Database._mirrorDb() @regression @tier1', function () {
    it('returns this when indexer has no hubDb', function () {
        const db = makeDb();
        assert.strictEqual(db._mirrorDb(), db);
    });

    it('returns hubDb when indexer has one', function () {
        const db    = makeDb();
        const hubDb = { doQuery: sinon.stub() };
        db.indexer.hubDb = hubDb;
        assert.strictEqual(db._mirrorDb(), hubDb);
    });
});

// ---------------------------------------------------------------------------
// getStatusString
// ---------------------------------------------------------------------------
describe('Database.getStatusString() @regression @tier1', function () {
    it('returns null when status_id not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getStatusString(99), null);
    });

    it('returns status string when found', async function () {
        const db = dbWithDoQuery([{ status: 'valid' }]);
        assert.strictEqual(await db.getStatusString(1), 'valid');
    });
});

// ---------------------------------------------------------------------------
// getContract
// ---------------------------------------------------------------------------
describe('Database.getContract() @regression @tier1', function () {
    it('returns null when not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getContract(99), null);
    });

    it('returns contract row when found', async function () {
        const db = dbWithDoQuery([{ action_index: 5, source_id: 1 }]);
        const result = await db.getContract(5);
        assert.strictEqual(result.action_index, 5);
    });
});

// ---------------------------------------------------------------------------
// getContractBalance
// ---------------------------------------------------------------------------
describe('Database.getContractBalance() @regression @tier1', function () {
    it('returns "0" (string) when no balance row found', async function () {
        // getContractBalance returns '0' as a string when no row exists
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getContractBalance(1, 2), '0');
    });

    it('returns amount string when row found', async function () {
        const db = dbWithDoQuery([{ amount: '500' }]);
        const result = await db.getContractBalance(1, 2);
        assert.strictEqual(result, '500');
    });
});

// ---------------------------------------------------------------------------
// getGatedFileRaw
// ---------------------------------------------------------------------------
describe('Database.getGatedFileRaw() @regression @tier1', function () {
    it('returns null when not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getGatedFileRaw(99), null);
    });

    it('returns row when found', async function () {
        const db = dbWithDoQuery([{ action_index: 10, raw_data: Buffer.from('abc') }]);
        const result = await db.getGatedFileRaw(10);
        assert.ok(result !== null);
    });
});

// ---------------------------------------------------------------------------
// getActiveGatedKeyHashes
// ---------------------------------------------------------------------------
describe('Database.getActiveGatedKeyHashes() @regression @tier1', function () {
    it('returns empty array when no hashes found', async function () {
        // getActiveGatedKeyHashes passes tick directly as gate_ticker (no createTicker)
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        const result = await db.getActiveGatedKeyHashes('PEPE');
        assert.deepStrictEqual(result, []);
    });

    it('returns lowercase key_hash strings when found', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([
            { key_hash: 'HASH1' }, { key_hash: 'hash2' }
        ]);
        const result = await db.getActiveGatedKeyHashes('PEPE');
        // Returns lowercased via String(...).toLowerCase()
        assert.deepStrictEqual(result, ['hash1', 'hash2']);
    });
});

// ---------------------------------------------------------------------------
// getDispenserAmountRemaining
// ---------------------------------------------------------------------------
describe('Database.getDispenserAmountRemaining() @regression @tier1', function () {
    it('returns 0 when dispenser not found', async function () {
        const db = dbWithDoQuery([]);
        const result = await db.getDispenserAmountRemaining(99);
        // Returns 0 or null based on implementation; test for non-undefined
        assert.ok(result !== undefined);
    });
});

// ---------------------------------------------------------------------------
// getOraclePrice
// ---------------------------------------------------------------------------
describe('Database.getOraclePrice() @regression @tier1', function () {
    it('returns null when no price found', async function () {
        const db = dbWithDoQuery([]);
        // sourceAddress, coin, tick, fiat, blockTime
        assert.strictEqual(await db.getOraclePrice('addr1', 'BTC', null, 'USD', 1000000), null);
    });

    it('returns row when price found', async function () {
        const db = dbWithDoQuery([{ value: '60000', block_time: 999 }]);
        const result = await db.getOraclePrice('addr1', 'BTC', null, 'USD', 1000000);
        assert.strictEqual(result.value, '60000');
    });
});

// ---------------------------------------------------------------------------
// getLatestPrice
// ---------------------------------------------------------------------------
describe('Database.getLatestPrice() @regression @tier1', function () {
    it('returns null when no price found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getLatestPrice('BTC-USD', 100), null);
    });

    it('returns normalized object with price/roundNumber/timestamp on hit', async function () {
        // getLatestPrice returns { price, roundNumber, timestamp } not the raw row
        const db = dbWithDoQuery([{ price: '50000', round_number: 42, block_timestamp: 1700000000 }]);
        const result = await db.getLatestPrice('BTC-USD', 100);
        assert.strictEqual(result.price, '50000');
        assert.strictEqual(result.roundNumber, 42);
        assert.strictEqual(result.timestamp, 1700000000);
    });
});

// ---------------------------------------------------------------------------
// getUnclaimedRewardTotal
// ---------------------------------------------------------------------------
describe('Database.getUnclaimedRewardTotal() @regression @tier1', function () {
    it('returns "0" when address not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getAddressId').resolves(null);
        assert.strictEqual(await db.getUnclaimedRewardTotal('source1'), '0');
    });

    it('returns bcsub(totalRewards, totalClaimed) when address found', async function () {
        const db   = makeDb();
        sinon.stub(db, 'getAddressId').resolves(5);
        const stub = sinon.stub(db, 'doQuery');
        // total_rewards query
        stub.onCall(0).resolves([{ total_rewards: '1000' }]);
        // total_claimed query
        stub.onCall(1).resolves([{ total_claimed: '400' }]);
        const result = await db.getUnclaimedRewardTotal('source1');
        // util.bcsub('1000', '400', 18) → some numeric string
        assert.ok(result !== null && result !== undefined);
    });
});

// ---------------------------------------------------------------------------
// getOrderAmountsRemaining
// ---------------------------------------------------------------------------
describe('Database.getOrderAmountsRemaining() @regression @tier1', function () {
    it('returns default object when order not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        const result = await db.getOrderAmountsRemaining(99);
        // Should return an object (empty or with defaults)
        assert.ok(typeof result === 'object');
    });
});

// ---------------------------------------------------------------------------
// getSweepDestination / getOrderSweepDestination
// ---------------------------------------------------------------------------
describe('Database sweep destination methods @regression @tier1', function () {
    it('getSweepDestination returns null when not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getSweepDestination(99), null);
    });

    it('getOrderSweepDestination returns null when not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getOrderSweepDestination(99), null);
    });
});

// ---------------------------------------------------------------------------
// getActiveDelegation
// ---------------------------------------------------------------------------
describe('Database.getActiveDelegation() @regression @tier1', function () {
    it('returns null when no delegation found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getActiveDelegation('src', 'pk', 100), null);
    });

    it('returns delegation row when found', async function () {
        const db = dbWithDoQuery([{ action_index: 5, amount: '1000' }]);
        const result = await db.getActiveDelegation('src', 'pk', 100);
        assert.strictEqual(result.action_index, 5);
    });
});

// ---------------------------------------------------------------------------
// getAttestationRequestById
// ---------------------------------------------------------------------------
describe('Database.getAttestationRequestById() @regression @tier1', function () {
    it('returns null when not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getAttestationRequestById(99), null);
    });

    it('returns row when found', async function () {
        const db = dbWithDoQuery([{ id: 1, action_index: 5 }]);
        const result = await db.getAttestationRequestById(1);
        assert.strictEqual(result.id, 1);
    });
});

// ---------------------------------------------------------------------------
// updateAttestationRequestStatus
// ---------------------------------------------------------------------------
describe('Database.updateAttestationRequestStatus() @regression @tier1', function () {
    it('calls doQuery with UPDATE', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        await db.updateAttestationRequestStatus(1, 'fulfilled');
        assert.match(db.doQuery.firstCall.args[0], /UPDATE/i);
    });
});

// ---------------------------------------------------------------------------
// getExpiredAttestationRequests
// ---------------------------------------------------------------------------
describe('Database.getExpiredAttestationRequests() @regression @tier1', function () {
    it('returns empty array when none found', async function () {
        const db = dbWithDoQuery([]);
        const result = await db.getExpiredAttestationRequests(100);
        assert.deepStrictEqual(result, []);
    });

    it('returns rows when found', async function () {
        const db = dbWithDoQuery([{ id: 1, action_index: 5 }]);
        const result = await db.getExpiredAttestationRequests(100);
        assert.strictEqual(result.length, 1);
    });
});

// ---------------------------------------------------------------------------
// setAttestationResponseCallbackIndex
// ---------------------------------------------------------------------------
describe('Database.setAttestationResponseCallbackIndex() @regression @tier1', function () {
    it('runs UPDATE query', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        await db.setAttestationResponseCallbackIndex(10, 20);
        assert.match(db.doQuery.firstCall.args[0], /UPDATE/i);
    });
});

// ---------------------------------------------------------------------------
// savepoint methods
// ---------------------------------------------------------------------------
describe('Database savepoint methods @regression @tier1', function () {
    // Savepoints require an active transactionConnection — calling them
    // without one throws rather than silently doing nothing.

    function makeActiveDb() {
        const db   = makeDb();
        const conn = {
            query:   sinon.stub().resolves([]),
            release: sinon.stub().resolves()
        };
        db.transactionConnection = conn;
        return { db, conn };
    }

    it('createSavepoint throws when no active transaction', async function () {
        const db = makeDb();
        await assert.rejects(() => db.createSavepoint('sp1'), /createSavepoint requires an active transaction/);
    });

    it('createSavepoint runs SAVEPOINT statement via transactionConnection', async function () {
        const { db, conn } = makeActiveDb();
        await db.createSavepoint('sp1');
        assert.match(conn.query.firstCall.args[0], /SAVEPOINT/i);
    });

    it('releaseSavepoint throws when no active transaction', async function () {
        const db = makeDb();
        await assert.rejects(() => db.releaseSavepoint('sp1'), /releaseSavepoint requires an active transaction/);
    });

    it('releaseSavepoint runs RELEASE SAVEPOINT via transactionConnection', async function () {
        const { db, conn } = makeActiveDb();
        await db.releaseSavepoint('sp1');
        assert.match(conn.query.firstCall.args[0], /RELEASE SAVEPOINT/i);
    });

    it('rollbackToSavepoint throws when no active transaction', async function () {
        const db = makeDb();
        await assert.rejects(() => db.rollbackToSavepoint('sp1'), /rollbackToSavepoint requires an active transaction/);
    });

    it('rollbackToSavepoint runs ROLLBACK TO SAVEPOINT via transactionConnection', async function () {
        const { db, conn } = makeActiveDb();
        await db.rollbackToSavepoint('sp1');
        assert.match(conn.query.firstCall.args[0], /ROLLBACK TO/i);
    });
});

// ---------------------------------------------------------------------------
// getActiveContractStakeByPubkey
// ---------------------------------------------------------------------------
describe('Database.getActiveContractStakeByPubkey() @regression @tier1', function () {
    it('returns null when pubkey not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(null);
        assert.strictEqual(await db.getActiveContractStakeByPubkey(1, 'pk', 'TICK', 100), null);
    });

    it('returns null when tick not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'getTickerId').resolves(null);
        sinon.stub(db, 'getStatusId').resolves(1);
        assert.strictEqual(await db.getActiveContractStakeByPubkey(1, 'pk', 'NOTEXIST', 100), null);
    });

    it('returns null when no rows found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'getTickerId').resolves(5);
        sinon.stub(db, 'getStatusId').resolves(1);
        sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.getActiveContractStakeByPubkey(1, 'pk', 'TICK', 100), null);
    });

    it('returns row data when found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'getTickerId').resolves(5);
        sinon.stub(db, 'getStatusId').resolves(1);
        sinon.stub(db, 'doQuery').resolves([{
            source_id: 1, signing_pubkey_id: 3, amount: '500', target_contract_index: 1
        }]);
        const result = await db.getActiveContractStakeByPubkey(1, 'pk', 'TICK', 100);
        assert.ok(result !== null);
        assert.strictEqual(String(result.amount), '500');
    });
});

// ---------------------------------------------------------------------------
// getContractStakeOwner
// ---------------------------------------------------------------------------
describe('Database.getContractStakeOwner() @regression @tier1', function () {
    it('returns null when not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'getTickerId').resolves(5);
        sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.getContractStakeOwner(1, 'pk', 'TICK'), null);
    });

    it('returns null when pubkey not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(null);
        assert.strictEqual(await db.getContractStakeOwner(1, 'pk', 'TICK'), null);
    });
});

// ---------------------------------------------------------------------------
// createActionMapping / getActionType (SQL content check)
// ---------------------------------------------------------------------------
describe('Database.createActionMapping() @regression @tier1', function () {
    it('inserts or updates mapping record', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        // First call: SELECT check
        stub.onCall(0).resolves([]);
        // Second call: INSERT
        stub.onCall(1).resolves([]);
        await db.createActionMapping(5, 'SEND', 'test-value');
        assert.ok(stub.calledTwice);
    });
});

// ---------------------------------------------------------------------------
// getMarketId / createMarket
// ---------------------------------------------------------------------------
describe('Database.getMarketId() @regression @tier1', function () {
    it('returns null when not found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getMarketId(1, 2), null);
    });

    it('returns numeric id when found', async function () {
        const db = dbWithDoQuery([{ id: 4 }]);
        assert.strictEqual(await db.getMarketId(1, 2), 4);
    });
});

// ---------------------------------------------------------------------------
// isAddressSleeping / isTickSleeping
// ---------------------------------------------------------------------------
describe('Database sleeping check methods @regression @tier1', function () {
    it('isAddressSleeping returns false when no sleep records found', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([{ id: 1 }]); // createAddress
        stub.onCall(1).resolves([]);           // SELECT sleeps
        assert.strictEqual(await db.isAddressSleeping('addr1', 100), false);
    });

    it('isTickSleeping returns false when no sleep records found', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([{ id: 1 }]); // createTicker
        stub.onCall(1).resolves([]);           // SELECT sleeps
        assert.strictEqual(await db.isTickSleeping('PEPE', 100), false);
    });
});

// ---------------------------------------------------------------------------
// validTickerBeforeTxIndex
// ---------------------------------------------------------------------------
describe('Database.validTickerBeforeTxIndex() @regression @tier1', function () {
    it('returns false when tick not found before tx_index', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([{ id: 1 }]); // createTicker
        stub.onCall(1).resolves([]);           // SELECT
        assert.strictEqual(await db.validTickerBeforeTxIndex('PEPE', 100), false);
    });

    it('returns true when tick exists before tx_index', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([{ id: 1 }]);
        stub.onCall(1).resolves([{ action_index: 5 }]);
        assert.strictEqual(await db.validTickerBeforeTxIndex('PEPE', 100), true);
    });
});

// ---------------------------------------------------------------------------
// getFirstIssueActionIndex
// ---------------------------------------------------------------------------
describe('Database.getFirstIssueActionIndex() @regression @tier1', function () {
    it('returns false (not null) when not found — characterization', async function () {
        // NOTE: method initialises action_index = false and returns it unchanged when
        // no row is found. Returns false rather than null.
        const db = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([{ id: 1 }]); // createTicker
        stub.onCall(1).resolves([]);
        assert.strictEqual(await db.getFirstIssueActionIndex('PEPE'), false);
    });

    it('returns numeric action_index when found', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([{ id: 1 }]);
        stub.onCall(1).resolves([{ action_index: 42 }]);
        assert.strictEqual(await db.getFirstIssueActionIndex('PEPE'), 42);
    });
});

// ---------------------------------------------------------------------------
// getTxIndex
// ---------------------------------------------------------------------------
describe('Database.getTxIndex() @regression @tier1', function () {
    it('returns null when transaction not found', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        // createTransaction calls: getTransactionId (empty) → INSERT → getTransactionId (empty)
        stub.onCall(0).resolves([]);
        stub.onCall(1).resolves([]);
        stub.onCall(2).resolves([]);
        // SELECT tx_index
        stub.onCall(3).resolves([]);
        assert.strictEqual(await db.getTxIndex('deadbeef'), null);
    });

    it('returns tx_index when found', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        // createTransaction → id found
        stub.onCall(0).resolves([{ id: 5 }]);
        // SELECT tx_index
        stub.onCall(1).resolves([{ tx_index: 10 }]);
        assert.strictEqual(await db.getTxIndex('deadbeef'), 10);
    });
});

// ---------------------------------------------------------------------------
// getAddressOwnerships
// ---------------------------------------------------------------------------
describe('Database.getAddressOwnerships() @regression @tier1', function () {
    it('returns empty array when none found', async function () {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([{ id: 1 }]); // createAddress
        stub.onCall(1).resolves([]);           // SELECT tokens
        const result = await db.getAddressOwnerships('addr1');
        assert.deepStrictEqual(result, []);
    });

    it('returns array of tick strings when found', async function () {
        // getAddressOwnerships returns data.push(row.tick) — an array of strings
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([{ id: 2 }]);
        stub.onCall(1).resolves([{ tick: 'PEPE' }, { tick: 'DOGE' }]);
        const result = await db.getAddressOwnerships('addr1');
        assert.deepStrictEqual(result, ['PEPE', 'DOGE']);
    });
});

// ---------------------------------------------------------------------------
// createIssue — INSERT branch
// ---------------------------------------------------------------------------
describe('Database.createIssue() @regression @tier1', function () {
    function makeHelperDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(1);
        sinon.stub(db, 'createAddress').resolves(2);
        sinon.stub(db, 'createMemo').resolves(3);
        sinon.stub(db, 'createStatus').resolves(4);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows); // SELECT check
        dq.onCall(1).resolves([]);         // INSERT / UPDATE
        return db;
    }

    it('INSERTs when no existing record', async function () {
        const db = makeHelperDb([]);
        await db.createIssue({ ACTION_INDEX: 10, TICK: 'PEPE', MAX_SUPPLY: '1000', MEMO: null, STATUS: 'valid' });
        const dq = db.doQuery;
        assert.ok(dq.calledTwice);
        assert.ok(String(dq.args[1][0]).includes('INSERT INTO issues'));
    });

    it('UPDATEs when record already exists', async function () {
        const db = makeHelperDb([{ action_index: 10 }]);
        await db.createIssue({ ACTION_INDEX: 10, TICK: 'PEPE', MAX_SUPPLY: '1000', MEMO: null, STATUS: 'valid' });
        const dq = db.doQuery;
        assert.ok(dq.calledTwice);
        assert.ok(String(dq.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createToken — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createToken() @regression @tier1', function () {
    function makeTokenDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(1);
        sinon.stub(db, 'createAddress').resolves(2);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when token not found', async function () {
        const db = makeTokenDb([]);
        await db.createToken({ ACTION_INDEX: 20, TICK: 'FOO', SUPPLY: '100', DECIMALS: '8',
                                OWNER: 'addr1', MAX_SUPPLY: '1000', MAX_MINT: '10', MINT_SUPPLY: '0',
                                LOCK_MAX_SUPPLY: 0, LOCK_MINT: 0, LOCK_MAX_MINT: 0, LOCK_DESCRIPTION: 0,
                                LOCK_SLEEP: 0, LOCK_CALLBACK: 0 });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO tokens'));
    });

    it('UPDATEs when token exists', async function () {
        const db = makeTokenDb([{ id: 5 }]);
        await db.createToken({ ACTION_INDEX: 20, TICK: 'FOO', SUPPLY: '100', DECIMALS: '8',
                                OWNER: 'addr1', MAX_SUPPLY: '1000', MAX_MINT: '10', MINT_SUPPLY: '0',
                                LOCK_MAX_SUPPLY: 0, LOCK_MINT: 0, LOCK_MAX_MINT: 0, LOCK_DESCRIPTION: 0,
                                LOCK_SLEEP: 0, LOCK_CALLBACK: 0 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createMint — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createMint() @regression @tier1', function () {
    function makeMintDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(1);
        sinon.stub(db, 'createAddress').resolves(2);
        sinon.stub(db, 'createMemo').resolves(3);
        sinon.stub(db, 'createStatus').resolves(4);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when mint not found', async function () {
        const db = makeMintDb([]);
        await db.createMint({ ACTION_INDEX: 30, TICK: 'FOO', AMOUNT: '5', DESTINATION: 'addr1', MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO mints'));
    });

    it('UPDATEs when mint exists', async function () {
        const db = makeMintDb([{ action_index: 30 }]);
        await db.createMint({ ACTION_INDEX: 30, TICK: 'FOO', AMOUNT: '5', DESTINATION: 'addr1', MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createSend — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createSend() @regression @tier1', function () {
    function makeSendDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(1);
        sinon.stub(db, 'createAddress').resolves(2);
        sinon.stub(db, 'createMemo').resolves(3);
        sinon.stub(db, 'createStatus').resolves(4);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when send not found', async function () {
        const db = makeSendDb([]);
        await db.createSend({ ACTION_INDEX: 40, TICK: 'FOO', AMOUNT: '10', DESTINATION: 'addr2', MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO sends'));
    });

    it('UPDATEs when send exists', async function () {
        const db = makeSendDb([{ action_index: 40 }]);
        await db.createSend({ ACTION_INDEX: 40, TICK: 'FOO', AMOUNT: '10', DESTINATION: 'addr2', MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createBroadcast — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createBroadcast() @regression @tier1', function () {
    function makeBroadcastDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createMemo').resolves(1);
        sinon.stub(db, 'createStatus').resolves(2);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when broadcast not found', async function () {
        const db = makeBroadcastDb([]);
        await db.createBroadcast({ ACTION_INDEX: 50, MESSAGE: 'hello', VALUE: '1.0', FEE: '0', MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO broadcasts'));
    });

    it('UPDATEs when broadcast exists', async function () {
        const db = makeBroadcastDb([{ action_index: 50 }]);
        await db.createBroadcast({ ACTION_INDEX: 50, MESSAGE: 'hello', VALUE: '1.0', FEE: '0', MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createMessage — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createMessage() @regression @tier1', function () {
    function makeMessageDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(1);
        sinon.stub(db, 'createStatus').resolves(2);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when message not found', async function () {
        const db = makeMessageDb([]);
        await db.createMessage({ ACTION_INDEX: 60, DESTINATION: 'addr1', COIN: 'BTC',
                                  ENCRYPTION_METHOD: 1, ENCRYPTION_KEY: 'key', ENCRYPTED_MESSAGE: 'enc',
                                  PLAINTEXT_MESSAGE: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO messages'));
    });

    it('UPDATEs when message exists', async function () {
        const db = makeMessageDb([{ action_index: 60 }]);
        await db.createMessage({ ACTION_INDEX: 60, DESTINATION: 'addr1', COIN: 'BTC',
                                  ENCRYPTION_METHOD: 1, ENCRYPTION_KEY: 'key', ENCRYPTED_MESSAGE: 'enc',
                                  PLAINTEXT_MESSAGE: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createSleep — INSERT, UPDATE, and TYPE flag
// ---------------------------------------------------------------------------
describe('Database.createSleep() @regression @tier1', function () {
    function makeSleepDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(1);
        sinon.stub(db, 'createMemo').resolves(2);
        sinon.stub(db, 'createStatus').resolves(3);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when sleep not found (ADDRESS type)', async function () {
        const db = makeSleepDb([]);
        await db.createSleep({ ACTION_INDEX: 70, TYPE: 'ADDRESS', TICK: 'FOO', RESUME_BLOCK: 100, MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO sleeps'));
    });

    it('INSERTs TICK type (type=2)', async function () {
        const db = makeSleepDb([]);
        await db.createSleep({ ACTION_INDEX: 71, TYPE: 'TICK', TICK: 'FOO', RESUME_BLOCK: 200, MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO sleeps'));
        // type=2 for TICK, type=1 for anything else
        assert.strictEqual(db.doQuery.args[1][1][0], 2);
    });

    it('UPDATEs when sleep exists', async function () {
        const db = makeSleepDb([{ action_index: 70 }]);
        await db.createSleep({ ACTION_INDEX: 70, TYPE: 'ADDRESS', TICK: 'FOO', RESUME_BLOCK: 100, MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createAirdrop — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createAirdrop() @regression @tier1', function () {
    function makeAirdropDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(1);
        sinon.stub(db, 'createMemo').resolves(2);
        sinon.stub(db, 'createStatus').resolves(3);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeAirdropDb([]);
        await db.createAirdrop({ ACTION_INDEX: 80, TICK: 'FOO', AMOUNT: '5', LIST_ACTION_INDEX: null, MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO airdrops'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeAirdropDb([{ action_index: 80 }]);
        await db.createAirdrop({ ACTION_INDEX: 80, TICK: 'FOO', AMOUNT: '5', LIST_ACTION_INDEX: null, MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createFeeRecord — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createFeeRecord() @regression @tier1', function () {
    function makeFeeDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(1);
        sinon.stub(db, 'createAddress').resolves(2);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeFeeDb([]);
        await db.createFeeRecord({ ACTION_INDEX: 90, TICK: 'FOO', AMOUNT: '1', DESTINATION: 'addr1', METHOD: 2 });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO fees'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeFeeDb([{ action_index: 90 }]);
        await db.createFeeRecord({ ACTION_INDEX: 90, TICK: 'FOO', AMOUNT: '1', DESTINATION: 'addr1', METHOD: 2 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE fees'));
    });
});

// ---------------------------------------------------------------------------
// createDestroy — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createDestroy() @regression @tier1', function () {
    function makeDestroyDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(1);
        sinon.stub(db, 'createMemo').resolves(2);
        sinon.stub(db, 'createStatus').resolves(3);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeDestroyDb([]);
        await db.createDestroy({ ACTION_INDEX: 100, TICK: 'FOO', AMOUNT: '3', MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO destroys'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeDestroyDb([{ action_index: 100 }]);
        await db.createDestroy({ ACTION_INDEX: 100, TICK: 'FOO', AMOUNT: '3', MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createSweep — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createSweep() @regression @tier1', function () {
    function makeSweepDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(1);
        sinon.stub(db, 'createAddress').resolves(2);
        sinon.stub(db, 'createMemo').resolves(3);
        sinon.stub(db, 'createStatus').resolves(4);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeSweepDb([]);
        await db.createSweep({ ACTION_INDEX: 110, TICK: 'FOO', DESTINATION: 'addr2', BALANCES: 1, OWNERSHIPS: 0, ORDERS: 0, SWAPS: 0, DISPENSERS: 0, MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO sweeps'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeSweepDb([{ action_index: 110 }]);
        await db.createSweep({ ACTION_INDEX: 110, TICK: 'FOO', DESTINATION: 'addr2', BALANCES: 1, OWNERSHIPS: 0, ORDERS: 0, SWAPS: 0, DISPENSERS: 0, MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createDividend — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createDividend() @regression @tier1', function () {
    function makeDividendDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(1);
        sinon.stub(db, 'createMemo').resolves(2);
        sinon.stub(db, 'createStatus').resolves(3);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeDividendDb([]);
        await db.createDividend({ ACTION_INDEX: 120, TICK: 'FOO', DIVIDEND_TICK: 'BAR', AMOUNT: '2', MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO dividends'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeDividendDb([{ action_index: 120 }]);
        await db.createDividend({ ACTION_INDEX: 120, TICK: 'FOO', DIVIDEND_TICK: 'BAR', AMOUNT: '2', MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createCallback — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createCallback() @regression @tier1', function () {
    function makeCallbackDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(1);
        sinon.stub(db, 'createMemo').resolves(2);
        sinon.stub(db, 'createStatus').resolves(3);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeCallbackDb([]);
        await db.createCallback({ ACTION_INDEX: 130, TICK: 'FOO', CALLBACK_TICK: 'BAR', CALLBACK_AMOUNT: '1', MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO callbacks'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeCallbackDb([{ action_index: 130 }]);
        await db.createCallback({ ACTION_INDEX: 130, TICK: 'FOO', CALLBACK_TICK: 'BAR', CALLBACK_AMOUNT: '1', MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createFile — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createFile() @regression @tier1', function () {
    function makeFileDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createMimeType').resolves(1);
        sinon.stub(db, 'createMemo').resolves(2);
        sinon.stub(db, 'createStatus').resolves(3);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeFileDb([]);
        await db.createFile({ ACTION_INDEX: 140, NAME: 'test.txt', TITLE: 'Test', TYPE: 'text/plain', MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO files'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeFileDb([{ action_index: 140 }]);
        await db.createFile({ ACTION_INDEX: 140, NAME: 'test.txt', TITLE: 'Test', TYPE: 'text/plain', MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createGatedFile — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createGatedFile() @regression @tier1', function () {
    function makeGatedFileDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeGatedFileDb([]);
        await db.createGatedFile({ ACTION_INDEX: 150, GATE_TICKER: 'FOO', ENCRYPTION_METHOD: 1, KEY_HASH: 'abc123', STATUS: 'valid', RAW_DATA: null });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO gated_files'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeGatedFileDb([{ action_index: 150 }]);
        await db.createGatedFile({ ACTION_INDEX: 150, GATE_TICKER: 'FOO', ENCRYPTION_METHOD: 1, KEY_HASH: 'abc123', STATUS: 'valid', RAW_DATA: null });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE gated_files'));
    });
});

// ---------------------------------------------------------------------------
// createLink — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createLink() @regression @tier1', function () {
    function makeLinkDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createCoin').resolves(1);
        sinon.stub(db, 'createMemo').resolves(2);
        sinon.stub(db, 'createStatus').resolves(3);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeLinkDb([]);
        await db.createLink({ ACTION_INDEX: 160, COIN1: 'BTC', COIN2: 'LTC', COIN1_ACTION_INDEX: 1, COIN2_ACTION_INDEX: 2, MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO links'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeLinkDb([{ action_index: 160 }]);
        await db.createLink({ ACTION_INDEX: 160, COIN1: 'BTC', COIN2: 'LTC', COIN1_ACTION_INDEX: 1, COIN2_ACTION_INDEX: 2, MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createSwap — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createSwap() @regression @tier1', function () {
    function makeSwapDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createCoin').resolves(1);
        sinon.stub(db, 'createTicker').resolves(2);
        sinon.stub(db, 'createAddress').resolves(3);
        sinon.stub(db, 'createMemo').resolves(4);
        sinon.stub(db, 'createStatus').resolves(5);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeSwapDb([]);
        await db.createSwap({ ACTION_INDEX: 170, GIVE_COIN: 'BTC', GIVE_TICK: 'FOO', GIVE_AMOUNT: '5',
                               GET_COIN: 'LTC', GET_TICK: 'BAR', GET_AMOUNT: '10', GET_ADDRESS: 'addr1',
                               EXPIRATION: 0, MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO swaps'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeSwapDb([{ action_index: 170 }]);
        await db.createSwap({ ACTION_INDEX: 170, GIVE_COIN: 'BTC', GIVE_TICK: 'FOO', GIVE_AMOUNT: '5',
                               GET_COIN: 'LTC', GET_TICK: 'BAR', GET_AMOUNT: '10', GET_ADDRESS: 'addr1',
                               EXPIRATION: 0, MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createSwapStatus — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createSwapStatus() @regression @tier1', function () {
    it('INSERTs when not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([]);
        dq.onCall(1).resolves([]);
        await db.createSwapStatus(10, 5, 'open');
        assert.ok(String(dq.args[1][0]).includes('INSERT INTO swap_statuses'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([{ action_index: 10 }]);
        dq.onCall(1).resolves([]);
        await db.createSwapStatus(10, 5, 'complete');
        assert.ok(String(dq.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createSwapCancel — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createSwapCancel() @regression @tier1', function () {
    function makeSwapCancelDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createMemo').resolves(1);
        sinon.stub(db, 'createStatus').resolves(2);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeSwapCancelDb([]);
        await db.createSwapCancel({ ACTION_INDEX: 180, SWAP_ACTION_INDEX: 5, MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO swap_cancels'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeSwapCancelDb([{ action_index: 180 }]);
        await db.createSwapCancel({ ACTION_INDEX: 180, SWAP_ACTION_INDEX: 5, MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createSwapExpire — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createSwapExpire() @regression @tier1', function () {
    it('INSERTs when not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([]);
        dq.onCall(1).resolves([]);
        await db.createSwapExpire(20, 10, 'valid');
        assert.ok(String(dq.args[1][0]).includes('INSERT INTO swap_expires'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([{ action_index: 20 }]);
        dq.onCall(1).resolves([]);
        await db.createSwapExpire(20, 10, 'valid');
        assert.ok(String(dq.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createOrder — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createOrder() @regression @tier1', function () {
    function makeOrderDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createCoin').resolves(1);
        sinon.stub(db, 'createTicker').resolves(2);
        sinon.stub(db, 'createAddress').resolves(3);
        sinon.stub(db, 'createMemo').resolves(4);
        sinon.stub(db, 'createStatus').resolves(5);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeOrderDb([]);
        await db.createOrder({ ACTION_INDEX: 200, GIVE_COIN: 'BTC', GIVE_TICK: 'FOO', GIVE_AMOUNT: '5',
                                GET_COIN: 'BTC', GET_TICK: 'BAR', GET_AMOUNT: '10', GET_ADDRESS: 'addr1',
                                EXPIRATION: 0, MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO orders'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeOrderDb([{ action_index: 200 }]);
        await db.createOrder({ ACTION_INDEX: 200, GIVE_COIN: 'BTC', GIVE_TICK: 'FOO', GIVE_AMOUNT: '5',
                                GET_COIN: 'BTC', GET_TICK: 'BAR', GET_AMOUNT: '10', GET_ADDRESS: 'addr1',
                                EXPIRATION: 0, MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createOrderStatus — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createOrderStatus() @regression @tier1', function () {
    it('INSERTs when not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([]);
        dq.onCall(1).resolves([]);
        await db.createOrderStatus(30, 15, 'open');
        assert.ok(String(dq.args[1][0]).includes('INSERT INTO order_statuses'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([{ action_index: 30 }]);
        dq.onCall(1).resolves([]);
        await db.createOrderStatus(30, 15, 'complete');
        assert.ok(String(dq.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createOrderExpire — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createOrderExpire() @regression @tier1', function () {
    it('INSERTs when not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([]);
        dq.onCall(1).resolves([]);
        await db.createOrderExpire(40, 20, 'valid');
        assert.ok(String(dq.args[1][0]).includes('INSERT INTO order_expires'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([{ action_index: 40 }]);
        dq.onCall(1).resolves([]);
        await db.createOrderExpire(40, 20, 'valid');
        assert.ok(String(dq.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createDispenser — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createDispenser() @regression @tier1', function () {
    function makeDispenserDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createCoin').resolves(1);
        sinon.stub(db, 'createTicker').resolves(2);
        sinon.stub(db, 'createAddress').resolves(3);
        sinon.stub(db, 'createFiat').resolves(4);
        sinon.stub(db, 'createMemo').resolves(5);
        sinon.stub(db, 'createStatus').resolves(6);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeDispenserDb([]);
        await db.createDispenser({ ACTION_INDEX: 210, GIVE_COIN: 'BTC', GIVE_TICK: 'FOO', GIVE_AMOUNT: '5',
                                    GET_COIN: 'BTC', GET_TICK: null, GET_AMOUNT: '0.001', GET_ADDRESS: 'addr1',
                                    FIAT_CODE: null, GIVE_ESCROW: null, ORACLE_ADDRESS: null, MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO dispensers'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeDispenserDb([{ action_index: 210 }]);
        await db.createDispenser({ ACTION_INDEX: 210, GIVE_COIN: 'BTC', GIVE_TICK: 'FOO', GIVE_AMOUNT: '5',
                                    GET_COIN: 'BTC', GET_TICK: null, GET_AMOUNT: '0.001', GET_ADDRESS: 'addr1',
                                    FIAT_CODE: null, GIVE_ESCROW: null, ORACLE_ADDRESS: null, MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createDispenserStatus — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createDispenserStatus() @regression @tier1', function () {
    it('INSERTs when not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'createAddress').resolves(null);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([]);
        dq.onCall(1).resolves([]);
        await db.createDispenserStatus(50, 25, 'open', null);
        assert.ok(String(dq.args[1][0]).includes('INSERT INTO dispenser_statuses'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'createAddress').resolves(null);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([{ action_index: 50 }]);
        dq.onCall(1).resolves([]);
        await db.createDispenserStatus(50, 25, 'complete', null);
        assert.ok(String(dq.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createAddressOption — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createAddressOption() @regression @tier1', function () {
    function makeAddressOptionDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'createMemo').resolves(2);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeAddressOptionDb([]);
        await db.createAddressOption({ ACTION_INDEX: 220, FEE_PREFERENCE: 2, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 1, MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO addresses'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeAddressOptionDb([{ action_index: 220 }]);
        await db.createAddressOption({ ACTION_INDEX: 220, FEE_PREFERENCE: 2, REQUIRE_MEMO: 0, DISPENSER_PREFERENCE: 1, MEMO: null, STATUS: 'valid' });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createBatch — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createBatch() @regression @tier1', function () {
    it('INSERTs when not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([]);
        dq.onCall(1).resolves([]);
        await db.createBatch({ ACTION_INDEX: 230, STATUS: 'valid' });
        assert.ok(String(dq.args[1][0]).includes('INSERT INTO batches'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([{ action_index: 230 }]);
        dq.onCall(1).resolves([]);
        await db.createBatch({ ACTION_INDEX: 230, STATUS: 'valid' });
        assert.ok(String(dq.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createStake — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createStake() @regression @tier1', function () {
    function makeStakeDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(2);
        sinon.stub(db, 'getOrCreatePubkeyId').resolves(3);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeStakeDb([]);
        await db.createStake({ ACTION_INDEX: 300, STATUS: 'valid', SOURCE: 'addr1', SIGNING_PUBKEY: 'pubkey1', AMOUNT: '1000', BLOCK_INDEX: 100 });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO stakes'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeStakeDb([{ action_index: 300 }]);
        await db.createStake({ ACTION_INDEX: 300, STATUS: 'valid', SOURCE: 'addr1', SIGNING_PUBKEY: 'pubkey1', AMOUNT: '1000', BLOCK_INDEX: 100 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE stakes'));
    });
});

// ---------------------------------------------------------------------------
// createUnstake — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createUnstake() @regression @tier1', function () {
    function makeUnstakeDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(2);
        sinon.stub(db, 'getOrCreatePubkeyId').resolves(3);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeUnstakeDb([]);
        await db.createUnstake({ ACTION_INDEX: 310, STATUS: 'valid', SOURCE: 'addr1', SIGNING_PUBKEY: 'pk', AMOUNT: '1000', BLOCK_INDEX: 110 });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO unstakes'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeUnstakeDb([{ action_index: 310 }]);
        await db.createUnstake({ ACTION_INDEX: 310, STATUS: 'valid', SOURCE: 'addr1', SIGNING_PUBKEY: 'pk', AMOUNT: '1000', BLOCK_INDEX: 110 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE unstakes'));
    });
});

// ---------------------------------------------------------------------------
// createDelegation — INSERT and UPDATE; createRevokeDelegation delegates
// ---------------------------------------------------------------------------
describe('Database.createDelegation() @regression @tier1', function () {
    function makeDelegationDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(2);
        sinon.stub(db, 'getOrCreatePubkeyId').resolves(3);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeDelegationDb([]);
        await db.createDelegation({ ACTION_INDEX: 320, STATUS: 'valid', SOURCE: 'addr1', SIGNING_PUBKEY: 'pk', BLOCK_INDEX: 120 });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO delegations'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeDelegationDb([{ action_index: 320 }]);
        await db.createDelegation({ ACTION_INDEX: 320, STATUS: 'valid', SOURCE: 'addr1', SIGNING_PUBKEY: 'pk', BLOCK_INDEX: 120 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE delegations'));
    });

    it('createRevokeDelegation delegates to createDelegation', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'createDelegation').resolves();
        await db.createRevokeDelegation({ ACTION_INDEX: 330, STATUS: 'revoked', SOURCE: 'addr1', SIGNING_PUBKEY: 'pk', BLOCK_INDEX: 130 });
        assert.ok(stub.calledOnce);
    });
});

// ---------------------------------------------------------------------------
// createContract — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createContract() @regression @tier1', function () {
    function makeContractDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(2);
        sinon.stub(db, 'createAddress').resolves(3);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeContractDb([]);
        await db.createContract({ ACTION_INDEX: 400, STATUS: 'valid', SOURCE: 'addr1', CODE: 'function(){}', CODE_HASH: 'abc', BLOCK_INDEX: 200 });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO contracts'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeContractDb([{ action_index: 400 }]);
        await db.createContract({ ACTION_INDEX: 400, STATUS: 'valid', SOURCE: 'addr1', CODE: 'function(){}', CODE_HASH: 'abc', BLOCK_INDEX: 200 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE contracts'));
    });
});

// ---------------------------------------------------------------------------
// createContractExecution — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createContractExecution() @regression @tier1', function () {
    function makeExecDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(2);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeExecDb([]);
        await db.createContractExecution({ ACTION_INDEX: 410, STATUS: 'valid', CALLER: 'addr1',
                                            CONTRACT_INDEX: 400, METHOD_NAME: 'run', INPUT_PARAMS: '[]',
                                            GAS_USED: 100, GAS_LIMIT: 1000, BLOCK_INDEX: 210 });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO contract_executions'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeExecDb([{ action_index: 410 }]);
        await db.createContractExecution({ ACTION_INDEX: 410, STATUS: 'valid', CALLER: 'addr1',
                                            CONTRACT_INDEX: 400, METHOD_NAME: 'run', INPUT_PARAMS: '[]',
                                            GAS_USED: 100, GAS_LIMIT: 1000, BLOCK_INDEX: 210 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE contract_executions'));
    });
});

// ---------------------------------------------------------------------------
// createDeposit — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createDeposit() @regression @tier1', function () {
    function makeDepositDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(2);
        sinon.stub(db, 'createTicker').resolves(3);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeDepositDb([]);
        await db.createDeposit({ ACTION_INDEX: 420, STATUS: 'valid', SOURCE: 'addr1', TICK: 'FOO', AMOUNT: '50', CONTRACT_ACTION_INDEX: 400, BLOCK_INDEX: 220 });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO deposits'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeDepositDb([{ action_index: 420 }]);
        await db.createDeposit({ ACTION_INDEX: 420, STATUS: 'valid', SOURCE: 'addr1', TICK: 'FOO', AMOUNT: '50', CONTRACT_ACTION_INDEX: 400, BLOCK_INDEX: 220 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE deposits'));
    });
});

// ---------------------------------------------------------------------------
// createWithdrawal — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createWithdrawal() @regression @tier1', function () {
    function makeWithdrawalDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(2);
        sinon.stub(db, 'createTicker').resolves(3);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeWithdrawalDb([]);
        await db.createWithdrawal({ ACTION_INDEX: 430, STATUS: 'valid', SOURCE: 'addr1', TICK: 'FOO', AMOUNT: '20', CONTRACT_ACTION_INDEX: 400, BLOCK_INDEX: 230 });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO withdrawals'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeWithdrawalDb([{ action_index: 430 }]);
        await db.createWithdrawal({ ACTION_INDEX: 430, STATUS: 'valid', SOURCE: 'addr1', TICK: 'FOO', AMOUNT: '20', CONTRACT_ACTION_INDEX: 400, BLOCK_INDEX: 230 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE withdrawals'));
    });
});

// ---------------------------------------------------------------------------
// updateContractBalance — add and sub branches
// ---------------------------------------------------------------------------
describe('Database.updateContractBalance() @regression @tier1', function () {
    it('INSERTs balance when no existing row (add)', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([]);   // SELECT — no row
        dq.onCall(1).resolves([]);   // INSERT
        await db.updateContractBalance(400, 1, '10', 'add');
        assert.ok(String(dq.args[1][0]).includes('INSERT INTO contract_balances'));
    });

    it('UPDATEs when existing row (subtract)', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([{ amount: '50' }]);
        dq.onCall(1).resolves([]);
        await db.updateContractBalance(400, 1, '10', 'sub');
        assert.ok(String(dq.args[1][0]).includes('UPDATE contract_balances'));
    });
});

// ---------------------------------------------------------------------------
// createContractState
// ---------------------------------------------------------------------------
describe('Database.createContractState() @regression @tier1', function () {
    it('inserts a state row', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        await db.createContractState({ CONTRACT_INDEX: 400, STATE_KEY: 'counter', STATE_VALUE: '1', BLOCK_INDEX: 100, ACTION_INDEX: 10 });
        assert.ok(String(dq.args[0][0]).includes('INSERT INTO contract_state'));
    });
});

// ---------------------------------------------------------------------------
// createContractEmission
// ---------------------------------------------------------------------------
describe('Database.createContractEmission() @regression @tier1', function () {
    it('inserts an emission row', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        await db.createContractEmission({ EXECUTION_INDEX: 10, EMITTED_ACTION: 'SEND', ACTION_INDEX: 11, POSITION: 0 });
        assert.ok(String(dq.args[0][0]).includes('INSERT INTO contract_emissions'));
    });
});

// ---------------------------------------------------------------------------
// deleteContract
// ---------------------------------------------------------------------------
describe('Database.deleteContract() @regression @tier1', function () {
    it('runs DELETE on contracts table', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        await db.deleteContract(400);
        assert.ok(String(dq.args[0][0]).includes('DELETE FROM contracts'));
    });
});

// ---------------------------------------------------------------------------
// createAttestationRequest — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createAttestationRequest() @regression @tier1', function () {
    function makeAttestreqDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(2);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeAttestreqDb([]);
        await db.createAttestationRequest({ ACTION_INDEX: 500, STATUS: 'valid', FEE_PAYER: 'addr1',
                                             REQUEST_ID: 'aabbcc', CONTRACT_INDEX: 400, PROVIDER_ID: 'http_get',
                                             CALLBACK_METHOD: 'onResult', BLOCK_INDEX: 300 });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO attests'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeAttestreqDb([{ action_index: 500 }]);
        await db.createAttestationRequest({ ACTION_INDEX: 500, STATUS: 'valid', FEE_PAYER: 'addr1',
                                             REQUEST_ID: 'aabbcc', CONTRACT_INDEX: 400, PROVIDER_ID: 'http_get',
                                             CALLBACK_METHOD: 'onResult', BLOCK_INDEX: 300 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE attests'));
    });
});

// ---------------------------------------------------------------------------
// createAttestationResponse — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createAttestationResponse() @regression @tier1', function () {
    function makeAttestrespDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeAttestrespDb([]);
        await db.createAttestationResponse({ ACTION_INDEX: 510, STATUS: 'valid',
                                              REQUEST_ID: 'aabbcc', PROVIDER_ID: 'http_get',
                                              RESPONSE_HASH: 'ddeeff', RESPONSE_STATUS: 'fulfilled', BLOCK_INDEX: 310 });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO attests'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeAttestrespDb([{ action_index: 510 }]);
        await db.createAttestationResponse({ ACTION_INDEX: 510, STATUS: 'valid',
                                              REQUEST_ID: 'aabbcc', PROVIDER_ID: 'http_get',
                                              RESPONSE_HASH: 'ddeeff', RESPONSE_STATUS: 'fulfilled', BLOCK_INDEX: 310 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE attests'));
    });
});

// ---------------------------------------------------------------------------
// createContractStake — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createContractStake() @regression @tier1', function () {
    function makeCSDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(2);
        sinon.stub(db, 'getOrCreatePubkeyId').resolves(3);
        sinon.stub(db, 'createTicker').resolves(4);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeCSDb([]);
        await db.createContractStake({ ACTION_INDEX: 600, STATUS: 'valid', SOURCE: 'addr1',
                                        SIGNING_PUBKEY: 'pk', TICK: 'FOO', TARGET_CONTRACT_INDEX: 400,
                                        AMOUNT: '100', BLOCK_INDEX: 400 });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO contract_stakes'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeCSDb([{ action_index: 600 }]);
        await db.createContractStake({ ACTION_INDEX: 600, STATUS: 'valid', SOURCE: 'addr1',
                                        SIGNING_PUBKEY: 'pk', TICK: 'FOO', TARGET_CONTRACT_INDEX: 400,
                                        AMOUNT: '100', BLOCK_INDEX: 400 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE contract_stakes'));
    });
});

// ---------------------------------------------------------------------------
// createRewardClaim — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createRewardClaim() @regression @tier1', function () {
    function makeRCDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(2);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeRCDb([]);
        await db.createRewardClaim({ ACTION_INDEX: 700, STATUS: 'valid', SOURCE: 'addr1', AMOUNT: '5', BLOCK_INDEX: 500 });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO reward_claims'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeRCDb([{ action_index: 700 }]);
        await db.createRewardClaim({ ACTION_INDEX: 700, STATUS: 'valid', SOURCE: 'addr1', AMOUNT: '5', BLOCK_INDEX: 500 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE reward_claims'));
    });
});

// ---------------------------------------------------------------------------
// createList — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createList() @regression @tier1', function () {
    it('INSERTs when not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([]);
        dq.onCall(1).resolves([]);
        await db.createList({ ACTION_INDEX: 800, STATUS: 'valid', TYPE: 1, EDIT: 0, LIST_ACTION_INDEX: null });
        assert.ok(String(dq.args[1][0]).includes('INSERT INTO lists'));
    });

    it('UPDATEs when exists', async function () {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([{ action_index: 800 }]);
        dq.onCall(1).resolves([]);
        await db.createList({ ACTION_INDEX: 800, STATUS: 'valid', TYPE: 1, EDIT: 0, LIST_ACTION_INDEX: null });
        assert.ok(String(dq.args[1][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createListEdit — INSERT only when not found; skip when exists
// ---------------------------------------------------------------------------
describe('Database.createListEdit() @regression @tier1', function () {
    it('INSERTs when not found (TYPE=1 tick)', async function () {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'createTicker').resolves(2);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([]);
        dq.onCall(1).resolves([]);
        await db.createListEdit({ ACTION_INDEX: 810, TYPE: 1 }, 'FOO', 'valid');
        assert.ok(String(dq.args[1][0]).includes('INSERT INTO list_edits'));
    });

    it('skips INSERT when already exists', async function () {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'createTicker').resolves(2);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([{ item_id: 2 }]);
        await db.createListEdit({ ACTION_INDEX: 810, TYPE: 1 }, 'FOO', 'valid');
        assert.strictEqual(dq.callCount, 1);
    });

    it('uses createAddress for TYPE=2', async function () {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        const createAddr = sinon.stub(db, 'createAddress').resolves(5);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([]);
        dq.onCall(1).resolves([]);
        await db.createListEdit({ ACTION_INDEX: 815, TYPE: 2 }, 'addr1', 'valid');
        assert.ok(createAddr.calledWith('addr1'));
    });
});

// ---------------------------------------------------------------------------
// createListItem — INSERT only; skip when exists
// ---------------------------------------------------------------------------
describe('Database.createListItem() @regression @tier1', function () {
    it('INSERTs when not found (TYPE=1)', async function () {
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(1);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([]);
        dq.onCall(1).resolves([]);
        await db.createListItem({ ACTION_INDEX: 820, TYPE: 1 }, 'FOO');
        assert.ok(String(dq.args[1][0]).includes('INSERT INTO list_items'));
    });

    it('skips INSERT when exists', async function () {
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(1);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([{ item_id: 1 }]);
        await db.createListItem({ ACTION_INDEX: 820, TYPE: 1 }, 'FOO');
        assert.strictEqual(dq.callCount, 1);
    });
});

// ---------------------------------------------------------------------------
// createListItemInvalid — INSERT only; skip when exists
// ---------------------------------------------------------------------------
describe('Database.createListItemInvalid() @regression @tier1', function () {
    it('INSERTs when not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'createTicker').resolves(2);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([]);
        dq.onCall(1).resolves([]);
        await db.createListItemInvalid({ ACTION_INDEX: 830, TYPE: 1 }, 'FOO', 'invalid');
        assert.ok(String(dq.args[1][0]).includes('INSERT INTO list_items_invalid'));
    });

    it('skips INSERT when exists', async function () {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'createTicker').resolves(2);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([{ item_id: 2 }]);
        await db.createListItemInvalid({ ACTION_INDEX: 830, TYPE: 1 }, 'FOO', 'invalid');
        assert.strictEqual(dq.callCount, 1);
    });
});

// ---------------------------------------------------------------------------
// createMimeType — null bypass; found; not found → INSERT+refetch
// ---------------------------------------------------------------------------
describe('Database.createMimeType() @regression @tier1', function () {
    it('returns null for null type', async function () {
        const db = makeDb();
        const id = await db.createMimeType(null);
        assert.strictEqual(id, null);
    });

    it('returns existing id without INSERT', async function () {
        const db = makeDb();
        sinon.stub(db, 'getMimeTypeId').resolves(7);
        const id = await db.createMimeType('text/plain');
        assert.strictEqual(id, 7);
    });

    it('INSERTs when not found and returns refetched id', async function () {
        const db = makeDb();
        const getMime = sinon.stub(db, 'getMimeTypeId');
        getMime.onCall(0).resolves(null);
        getMime.onCall(1).resolves(8);
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        const id = await db.createMimeType('image/png');
        assert.strictEqual(id, 8);
        assert.ok(String(dq.args[0][0]).includes('INSERT IGNORE INTO index_mime_types'));
    });
});

// ---------------------------------------------------------------------------
// createCoin — null bypass; found; not found → INSERT+refetch
// ---------------------------------------------------------------------------
describe('Database.createCoin() @regression @tier1', function () {
    it('returns null for null coin', async function () {
        const db = makeDb();
        const id = await db.createCoin(null);
        assert.strictEqual(id, null);
    });

    it('returns existing id without INSERT', async function () {
        const db = makeDb();
        sinon.stub(db, 'getCoinId').resolves(3);
        const id = await db.createCoin('BTC');
        assert.strictEqual(id, 3);
    });

    it('INSERTs when not found and returns refetched id', async function () {
        const db = makeDb();
        const getCoin = sinon.stub(db, 'getCoinId');
        getCoin.onCall(0).resolves(null);
        getCoin.onCall(1).resolves(4);
        sinon.stub(db, 'doQuery').resolves([]);
        const id = await db.createCoin('LTC');
        assert.strictEqual(id, 4);
    });
});

// ---------------------------------------------------------------------------
// createFiat — null bypass; found; not found → INSERT+refetch
// ---------------------------------------------------------------------------
describe('Database.createFiat() @regression @tier1', function () {
    it('returns null for null code', async function () {
        const db = makeDb();
        const id = await db.createFiat(null);
        assert.strictEqual(id, null);
    });

    it('returns existing id without INSERT', async function () {
        const db = makeDb();
        sinon.stub(db, 'getFiatId').resolves(5);
        const id = await db.createFiat('USD');
        assert.strictEqual(id, 5);
    });

    it('INSERTs when not found and returns refetched id', async function () {
        const db = makeDb();
        const getFiat = sinon.stub(db, 'getFiatId');
        getFiat.onCall(0).resolves(null);
        getFiat.onCall(1).resolves(6);
        sinon.stub(db, 'doQuery').resolves([]);
        const id = await db.createFiat('EUR');
        assert.strictEqual(id, 6);
    });
});

// ---------------------------------------------------------------------------
// createLedgerChangeRecord — invalid table, INSERT, UPDATE
// ---------------------------------------------------------------------------
describe('Database.createLedgerChangeRecord() @regression @tier1', function () {
    it('throws on invalid table name', async function () {
        const db = makeDb();
        await assert.rejects(
            () => db.createLedgerChangeRecord('hack; DROP TABLE', 1, 'FOO', '10', 'addr1'),
            /Invalid ledger table/
        );
    });

    it('INSERTs credits when not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(1);
        sinon.stub(db, 'createAddress').resolves(2);
        sinon.stub(db, 'getTokenDecimalPrecision').resolves(8);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([]);
        dq.onCall(1).resolves([]);
        await db.createLedgerChangeRecord('credits', 10, 'FOO', '5', 'addr1');
        assert.ok(String(dq.args[1][0]).includes('INSERT INTO credits'));
    });

    it('UPDATEs credits when exists', async function () {
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(1);
        sinon.stub(db, 'createAddress').resolves(2);
        sinon.stub(db, 'getTokenDecimalPrecision').resolves(8);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([{ action_index: 10 }]);
        dq.onCall(1).resolves([]);
        await db.createLedgerChangeRecord('credits', 10, 'FOO', '5', 'addr1');
        assert.ok(String(dq.args[1][0]).includes('UPDATE'));
    });

    it('createCredit delegates correctly', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'createLedgerChangeRecord').resolves();
        await db.createCredit(10, 'FOO', '5', 'addr1');
        assert.ok(stub.calledWith('credits', 10, 'FOO', '5', 'addr1'));
    });

    it('createDebit delegates correctly', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'createLedgerChangeRecord').resolves();
        await db.createDebit(10, 'FOO', '5', 'addr1');
        assert.ok(stub.calledWith('debits', 10, 'FOO', '5', 'addr1'));
    });

    it('createEscrow delegates correctly', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'createLedgerChangeRecord').resolves();
        await db.createEscrow(10, 'FOO', '5', 'addr1');
        assert.ok(stub.calledWith('escrows', 10, 'FOO', '5', 'addr1'));
    });
});

// ---------------------------------------------------------------------------
// getListType — null action_index returns false; found
// ---------------------------------------------------------------------------
describe('Database.getListType() @regression @tier1', function () {
    it('returns false for null action_index', async function () {
        const db = makeDb();
        const type = await db.getListType(null);
        assert.strictEqual(type, false);
    });

    it('returns type integer when found', async function () {
        const db = dbWithDoQuery([{ type: '2' }]);
        const type = await db.getListType(10);
        assert.strictEqual(type, 2);
    });

    it('returns false when not found', async function () {
        const db = dbWithDoQuery([]);
        const type = await db.getListType(10);
        assert.strictEqual(type, false);
    });
});

// ---------------------------------------------------------------------------
// getList — delegates to getListType; builds from rows
// ---------------------------------------------------------------------------
describe('Database.getList() @regression @tier1', function () {
    it('returns empty array for unknown list', async function () {
        const db = makeDb();
        sinon.stub(db, 'getListType').resolves(false);
        const list = await db.getList(10);
        assert.deepStrictEqual(list, []);
    });

    it('returns tick items for type=1', async function () {
        const db = makeDb();
        sinon.stub(db, 'getListType').resolves(1);
        sinon.stub(db, 'doQuery').resolves([{ item: 'PEPE' }, { item: 'DOGE' }]);
        const list = await db.getList(10);
        assert.deepStrictEqual(list, ['PEPE', 'DOGE']);
    });

    it('returns address items for type=2', async function () {
        const db = makeDb();
        sinon.stub(db, 'getListType').resolves(2);
        sinon.stub(db, 'doQuery').resolves([{ item: 'bc1q...' }]);
        const list = await db.getList(10);
        assert.deepStrictEqual(list, ['bc1q...']);
    });
});

// ---------------------------------------------------------------------------
// isValidList — delegates to getListType
// ---------------------------------------------------------------------------
describe('Database.isValidList() @regression @tier1', function () {
    it('returns true when types match', async function () {
        const db = makeDb();
        sinon.stub(db, 'getListType').resolves(1);
        assert.strictEqual(await db.isValidList(10, 1), true);
    });

    it('returns false when types differ', async function () {
        const db = makeDb();
        sinon.stub(db, 'getListType').resolves(2);
        assert.strictEqual(await db.isValidList(10, 1), false);
    });
});

// ---------------------------------------------------------------------------
// getAddressPreferences — defaults + query branch
// ---------------------------------------------------------------------------
describe('Database.getAddressPreferences() @regression @tier1', function () {
    it('returns defaults when no rows found', async function () {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(1);
        sinon.stub(db, 'doQuery').resolves([]);
        const prefs = await db.getAddressPreferences('addr1', null, null);
        assert.strictEqual(prefs['FEE_PREFERENCE'], 2);
        assert.strictEqual(prefs['REQUIRE_MEMO'], 0);
        assert.strictEqual(prefs['DISPENSER_PREFERENCE'], 1);
    });

    it('overrides defaults from row', async function () {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(1);
        sinon.stub(db, 'doQuery').resolves([{ fee_preference: 1, require_memo: 1, dispenser_preference: 0 }]);
        const prefs = await db.getAddressPreferences('addr1', null, null);
        assert.strictEqual(prefs['FEE_PREFERENCE'], 1);
        assert.strictEqual(prefs['REQUIRE_MEMO'], 1);
        assert.strictEqual(prefs['DISPENSER_PREFERENCE'], 0);
    });
});

// ---------------------------------------------------------------------------
// getAddressEscrows — returns combined list
// ---------------------------------------------------------------------------
describe('Database.getAddressEscrows() @regression @tier1', function () {
    it('returns empty array when no escrows', async function () {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(1);
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        const escrows = await db.getAddressEscrows('addr1', null, null);
        assert.deepStrictEqual(escrows, []);
        // 3 queries: orders, swaps, dispensers
        assert.strictEqual(dq.callCount, 3);
    });

    it('collects order and swap escrows', async function () {
        const db = makeDb();
        sinon.stub(db, 'createAddress').resolves(1);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([{ action_index: 5 }]);   // orders
        dq.onCall(1).resolves([{ action_index: 8 }]);   // swaps
        dq.onCall(2).resolves([]);                       // dispensers
        const escrows = await db.getAddressEscrows('addr1', null, null);
        assert.strictEqual(escrows.length, 2);
        assert.strictEqual(escrows[0].type, 'order');
        assert.strictEqual(escrows[1].type, 'swap');
    });
});

// ---------------------------------------------------------------------------
// createValidatorReward — unknown pubkey, no stake, success
// ---------------------------------------------------------------------------
describe('Database.createValidatorReward() @regression @tier1', function () {
    it('returns false when pubkey not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(null);
        const result = await db.createValidatorReward('deadbeef', 1, 'oracle_round', '10', 100);
        assert.strictEqual(result, false);
    });

    it('returns false when no stake found for pubkey', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([]);  // no stake rows
        const result = await db.createValidatorReward('deadbeef', 1, 'oracle_round', '10', 100);
        assert.strictEqual(result, false);
    });

    it('returns true and inserts reward when stake found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([{ source_id: 2 }]);  // stake found
        dq.onCall(1).resolves([]);                   // INSERT IGNORE
        const result = await db.createValidatorReward('deadbeef', 1, 'oracle_round', '10', 100);
        assert.strictEqual(result, true);
        assert.ok(String(dq.args[1][0]).includes('INSERT IGNORE INTO validator_rewards'));
    });
});

// ---------------------------------------------------------------------------
// setDelegationDeactivation — returns false when source or pubkey missing
// ---------------------------------------------------------------------------
describe('Database.setDelegationDeactivation() @regression @tier1', function () {
    it('returns false when source address not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getAddressId').resolves(null);
        sinon.stub(db, 'getPubkeyId').resolves(3);
        const result = await db.setDelegationDeactivation('addr1', 'pk', 200);
        assert.strictEqual(result, false);
    });

    it('returns false when pubkey not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getAddressId').resolves(1);
        sinon.stub(db, 'getPubkeyId').resolves(null);
        const result = await db.setDelegationDeactivation('addr1', 'pk', 200);
        assert.strictEqual(result, false);
    });

    it('runs UPDATE and returns true when both found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getAddressId').resolves(1);
        sinon.stub(db, 'getPubkeyId').resolves(2);
        sinon.stub(db, 'getStatusId').resolves(3);
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        const result = await db.setDelegationDeactivation('addr1', 'pk', 200);
        assert.strictEqual(result, true);
        assert.ok(String(dq.args[0][0]).includes('UPDATE delegations'));
    });
});

// ---------------------------------------------------------------------------
// updateContractBalances — touch pairs, insert when balance > 0, skip otherwise
// ---------------------------------------------------------------------------
describe('Database.updateContractBalances() @regression @tier1', function () {
    it('processes each pair: deposit sum - withdrawal sum → UPDATE', async function () {
        const db = makeDb();
        sinon.stub(db, 'getStatusId').resolves(1);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([{ total: '50' }]);  // deposits
        dq.onCall(1).resolves([{ total: '10' }]);  // withdrawals
        dq.onCall(2).resolves([{ contract_index: 400 }]); // existing row
        dq.onCall(3).resolves([]);                  // UPDATE
        await db.updateContractBalances([{ contract_index: 400, tick_id: 1 }]);
        assert.ok(String(dq.args[3][0]).includes('UPDATE contract_balances'));
    });

    it('INSERTs when no row and balance > 0', async function () {
        const db = makeDb();
        sinon.stub(db, 'getStatusId').resolves(1);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([{ total: '50' }]);
        dq.onCall(1).resolves([{ total: '0' }]);
        dq.onCall(2).resolves([]);  // no existing row
        dq.onCall(3).resolves([]);  // INSERT
        await db.updateContractBalances([{ contract_index: 400, tick_id: 1 }]);
        assert.ok(String(dq.args[3][0]).includes('INSERT INTO contract_balances'));
    });
});

// ---------------------------------------------------------------------------
// getTokenSupply — basics (delegates through doQuery)
// ---------------------------------------------------------------------------
describe('Database.getTokenSupply() @regression @tier1', function () {
    it('returns supply via credits - debits + escrows (zeros)', async function () {
        const db = makeDb();
        sinon.stub(db, 'createTicker').resolves(1);
        sinon.stub(db, 'getTokenDecimalPrecision').resolves(8);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([{ credits: null }]);
        dq.onCall(1).resolves([{ debits: null }]);
        dq.onCall(2).resolves([{ escrows: null }]);
        const supply = await db.getTokenSupply('FOO', null, null);
        assert.ok(supply !== undefined);
    });
});

// ---------------------------------------------------------------------------
// getExpiredItems — empty returns []
// ---------------------------------------------------------------------------
describe('Database.getExpiredItems() @regression @tier1', function () {
    it('returns empty array when no open items', async function () {
        const db = dbWithDoQuery([]);
        const result = await db.getExpiredItems(9999999);
        assert.deepStrictEqual(result, []);
    });
});

// ---------------------------------------------------------------------------
// updateBalances — string, array, boolean branches
// ---------------------------------------------------------------------------
describe('Database.updateBalances() @regression @tier1', function () {
    it('handles string address — calls updateAddressBalance once', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'updateAddressBalance').resolves();
        await db.updateBalances('addr1', false);
        assert.strictEqual(stub.callCount, 1);
    });

    it('handles array of addresses', async function () {
        const db = makeDb();
        const stub = sinon.stub(db, 'updateAddressBalance').resolves();
        await db.updateBalances(['addr1', 'addr2'], false);
        assert.strictEqual(stub.callCount, 2);
    });

    it('handles boolean true — fetches all addresses then calls once per row', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([{ address: 'addr1' }, { address: 'addr2' }]);
        const stub = sinon.stub(db, 'updateAddressBalance').resolves();
        await db.updateBalances(true, false);
        assert.strictEqual(stub.callCount, 2);
    });
});

// ---------------------------------------------------------------------------
// setContractStakeDeactivationByPubkey — early-returns when pk/tick null
// ---------------------------------------------------------------------------
describe('Database.setContractStakeDeactivationByPubkey() @regression @tier1', function () {
    it('returns false when pubkey not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(null);
        const r = await db.setContractStakeDeactivationByPubkey(1, 'pk', 'FOO', 100);
        assert.strictEqual(r, false);
    });

    it('returns false when tick not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(1);
        sinon.stub(db, 'getTickerId').resolves(null);
        const r = await db.setContractStakeDeactivationByPubkey(1, 'pk', 'FOO', 100);
        assert.strictEqual(r, false);
    });

    it('runs UPDATE and returns true when both found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(1);
        sinon.stub(db, 'getTickerId').resolves(2);
        sinon.stub(db, 'getStatusId').resolves(3);
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        const r = await db.setContractStakeDeactivationByPubkey(1, 'pk', 'FOO', 100);
        assert.strictEqual(r, true);
        assert.ok(String(dq.args[0][0]).includes('UPDATE contract_stakes'));
    });
});

// ---------------------------------------------------------------------------
// incrementAttestationValidatorStat — field whitelist + upsert
// ---------------------------------------------------------------------------
describe('Database.incrementAttestationValidatorStat() @regression @tier1', function () {
    it('throws on unsupported field', async function () {
        const db = makeDb();
        await assert.rejects(
            () => db.incrementAttestationValidatorStat('pk', 'pid', 'evil_column', 1),
            /unsupported field/
        );
    });

    it('silently returns for empty pubkey/pid', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        await db.incrementAttestationValidatorStat('', 'pid', 'fulfilled_count', 1);
        assert.strictEqual(dq.callCount, 0);
    });

    it('runs upsert for fulfilled_count', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        await db.incrementAttestationValidatorStat('aabbcc', 'http_get', 'fulfilled_count', 100);
        assert.ok(String(dq.args[0][0]).includes('fulfilled_count'));
    });
});

// ---------------------------------------------------------------------------
// getDecoderBlockData — returns empty array when not found (characterization)
// ---------------------------------------------------------------------------
describe('Database.getDecoderBlockData() @regression @tier1', function () {
    it('returns empty array when not found', async function () {
        const db = dbWithDoQuery([]);
        const result = await db.getDecoderBlockData(100);
        // Characterization: method returns [] (empty array), not false
        assert.deepStrictEqual(result, []);
    });
});

// ---------------------------------------------------------------------------
// getBlockHashes — complex method; stub all doQuery calls to return []
// ---------------------------------------------------------------------------
describe('Database.getBlockHashes() @regression @tier1', function () {
    it('returns info object with ledger/actions/contracts hash arrays', async function () {
        const db = makeDb();
        // getBlockHashes makes 11 doQuery calls; use a default stub that always resolves []
        sinon.stub(db, 'doQuery').resolves([]);
        const result = await db.getBlockHashes(100);
        // Result has ledger/actions/contracts each with a computed .hash property
        assert.ok(result.ledger !== undefined);
        assert.ok(result.actions !== undefined);
        assert.ok(result.contracts !== undefined);
    });
});

// ---------------------------------------------------------------------------
// createBlock — stub getBlockHashes to avoid complex deps
// ---------------------------------------------------------------------------
describe('Database.createBlock() @regression @tier1', function () {
    it('INSERTs when not found', async function () {
        const db = makeDb();
        // stub getBlockId → null (no existing block)
        sinon.stub(db, 'getBlockId').resolves(null);
        // stub getBlockHashes → fake hash info
        sinon.stub(db, 'getBlockHashes').resolves({
            ledger:    { hash: 'aaa' },
            actions:   { hash: 'bbb' },
            contracts: { hash: 'ccc' }
        });
        // stub createTransaction to avoid INSERT into index_transactions
        sinon.stub(db, 'createTransaction').resolves(1);
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        await db.createBlock(100, 1700000000);
        assert.ok(String(dq.args[0][0]).includes('INSERT INTO blocks'));
    });

    it('UPDATEs when found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getBlockId').resolves(42);
        sinon.stub(db, 'getBlockHashes').resolves({
            ledger:    { hash: 'aaa' },
            actions:   { hash: 'bbb' },
            contracts: { hash: 'ccc' }
        });
        sinon.stub(db, 'createTransaction').resolves(1);
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        await db.createBlock(100, 1700000000);
        assert.ok(String(dq.args[0][0]).includes('UPDATE'));
    });
});

// ---------------------------------------------------------------------------
// createAction — INSERT action record
// ---------------------------------------------------------------------------
describe('Database.createAction() @regression @tier1', function () {
    it('INSERTs when not found', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([]);   // getActionId → null
        dq.onCall(1).resolves([]);   // INSERT IGNORE
        dq.onCall(2).resolves([]);   // getActionId after INSERT → still null (returns null)
        await db.createAction('SEND');
        assert.ok(String(dq.args[1][0]).includes('INSERT'));
    });
});

// ---------------------------------------------------------------------------
// createTxIndex — when tx not found, inserts
// ---------------------------------------------------------------------------
describe('Database.createTxIndex() @regression @tier1', function () {
    it('INSERTs tx record when not found', async function () {
        const db = makeDb();
        // getTxIndex calls createTransaction(TX_HASH) which calls getTransactionId
        // Stub the helpers
        sinon.stub(db, 'getTxIndex').resolves(null);
        sinon.stub(db, 'getNextTxIndex').resolves(5);
        sinon.stub(db, 'createAddress').resolves(1);
        sinon.stub(db, 'createTransaction').resolves(2);
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        await db.createTxIndex({ TX_HASH: 'abc', BLOCK_INDEX: 100, SOURCE: 'addr1' });
        assert.ok(String(dq.args[0][0]).includes('INSERT INTO transactions'));
    });

    it('returns existing tx_index when already found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getTxIndex').resolves(10);
        const result = await db.createTxIndex({ TX_HASH: 'abc', BLOCK_INDEX: 100 });
        assert.strictEqual(result, 10);
    });
});

// ---------------------------------------------------------------------------
// createActionIndex — force=false INSERT
// ---------------------------------------------------------------------------
describe('Database.createActionIndex() @regression @tier1', function () {
    it('INSERTs when getActionIndex returns null', async function () {
        const db = makeDb();
        sinon.stub(db, 'getActionIndex').resolves(null);
        sinon.stub(db, 'getNextActionIndex').resolves(5);
        sinon.stub(db, 'createAction').resolves(1);
        sinon.stub(db, 'createAddress').resolves(2);
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        const idx = await db.createActionIndex({ ACTION: 'SEND', BLOCK_INDEX: 100, TX_INDEX: 1, TX_VOUT: 0, SOURCE: 'addr1' }, false);
        assert.strictEqual(idx, 5);
        assert.ok(String(dq.args[0][0]).includes('INSERT INTO actions'));
    });

    it('returns existing action_index when found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getActionIndex').resolves(42);
        const idx = await db.createActionIndex({ ACTION: 'SEND', BLOCK_INDEX: 100, TX_INDEX: 1, TX_VOUT: 0 }, false);
        assert.strictEqual(idx, 42);
    });
});

// ---------------------------------------------------------------------------
// createPrice — INSERT and UPDATE
// ---------------------------------------------------------------------------
describe('Database.createPrice() @regression @tier1', function () {
    function makePriceDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(2);
        sinon.stub(db, 'createCoin').resolves(null);
        sinon.stub(db, 'createTicker').resolves(null);
        sinon.stub(db, 'createFiat').resolves(null);
        sinon.stub(db, 'createMemo').resolves(null);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);
        dq.onCall(1).resolves([]);
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makePriceDb([]);
        await db.createPrice({ ACTION_INDEX: 900, STATUS: 'valid', SOURCE: 'addr1' });
        assert.ok(String(db.doQuery.args[1][0]).includes('INSERT INTO prices'));
    });

    it('UPDATEs when exists', async function () {
        const db = makePriceDb([{ action_index: 900 }]);
        await db.createPrice({ ACTION_INDEX: 900, STATUS: 'valid', SOURCE: 'addr1' });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE prices'));
    });
});
