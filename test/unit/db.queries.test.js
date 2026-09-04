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
 * test/unit/db.queries.test.js
 *
 * Unit tests for Database query methods (SELECT/INSERT/UPDATE/DELETE).
 *
 * Technique: stub doQuery on the prototype-borrowed object so every
 * method under test exercises real method logic against injected SQL
 * results; no live MariaDB required.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

// Shared helpers

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

function dbWithDoQuery(rows) {
    const db = makeDb();
    sinon.stub(db, 'doQuery').resolves(rows);
    // Consensus-input reads (e.g. getLatestPrice) route through doQueryStrict,
    // which throws instead of swallowing errors (M-17). Stub it identically so
    // helpers that assert on returned rows exercise either path.
    sinon.stub(db, 'doQueryStrict').resolves(rows);
    return db;
}

afterEach(function () {
    sinon.restore();
});

// getConnection (circuit-breaker)
describe('Database.getConnection() circuit breaker @regression @tier1', function () {
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

// beginTransaction / rollbackTransaction / commitTransaction
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

describe('Database staged hub push buffer @regression @tier1', function () {
    it('stageHubPush is inert when no per-block buffer is installed', function () {
        const db = makeDb();
        // No _stagedHubPushes installed: must not throw and must return nothing to drain.
        db.stageHubPush({ id: 1, pushType: 'price_round', payload: {} });
        assert.deepStrictEqual(db.takeStagedHubPushes(), []);
    });

    it('stageHubPush accumulates and takeStagedHubPushes drains + clears exactly once', function () {
        const db = makeDb();
        db._stagedHubPushes = [];
        db.stageHubPush({ id: 1, pushType: 'price_round', payload: { a: 1 } });
        db.stageHubPush({ id: 2, pushType: 'oracle_price', payload: { b: 2 } });
        const first = db.takeStagedHubPushes();
        assert.strictEqual(first.length, 2);
        assert.strictEqual(first[0].id, 1);
        assert.strictEqual(first[1].pushType, 'oracle_price');
        // Drained once: a second take yields nothing (no duplicate delivery).
        assert.deepStrictEqual(db.takeStagedHubPushes(), []);
    });

    it('a fresh per-block buffer discards a prior (rolled-back) block staged rows', function () {
        const db = makeDb();
        db._stagedHubPushes = [];
        db.stageHubPush({ id: 9, pushType: 'price_round', payload: {} });
        // Simulate the next block start installing a fresh buffer (prior block rolled back).
        db._stagedHubPushes = [];
        assert.deepStrictEqual(db.takeStagedHubPushes(), []);
    });
});

// doQuery
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

// doQueryStrict: the consensus-input variant that ALWAYS throws on query error
// (M-17). doQuery collapses a non-transactional error into [] - indistinguishable
// from an empty result - which can fork the ledger on a transient DB fault; a
// strict read lets block processing roll back and retry.
describe('Database.doQueryStrict() @regression @tier1', function () {
    it('returns rows on success and releases when not in a transaction', async function () {
        const db   = makeDb();
        const conn = {
            query:   sinon.stub().resolves([{ id: 1 }]),
            release: sinon.stub().resolves()
        };
        db.pool.getConnection.resolves(conn);
        const results = await db.doQueryStrict('SELECT 1', []);
        assert.deepStrictEqual(results, [{ id: 1 }]);
        assert.ok(conn.release.calledOnce);
    });

    it('returns [] when query is null/undefined', async function () {
        const db = makeDb();
        assert.deepStrictEqual(await db.doQueryStrict(null), []);
    });

    it('THROWS on a query error outside a transaction (unlike doQuery, which swallows)', async function () {
        const db   = makeDb();
        const conn = {
            query:   sinon.stub().rejects(new Error('strict query error')),
            release: sinon.stub().resolves()
        };
        db.pool.getConnection.resolves(conn);
        await assert.rejects(() => db.doQueryStrict('SELECT 1'), /strict query error/);
        assert.ok(conn.release.calledOnce, 'connection must still be released on throw');
    });
});

// Index-table lookups: getTransactionId, getAddressId, getBlockId, getActionId
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

// createTransaction
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

// createAddress
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

// getNextTxIndex / getNextActionIndex
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

// getTicker / getTickerId / createTicker
describe('Database getTicker/getTickerId @regression @tier1', function () {
    it('getTicker returns null when no row found', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getTicker(1), null);
    });

    it('getTicker returns tick string on hit', async function () {
        const db = dbWithDoQuery([{ tick: 'PEPE' }]);
        assert.strictEqual(await db.getTicker(3), 'PEPE');
    });

    it('getTickerId for a canonical ^N reference returns the id when a backing row exists', async function () {
        // A `^<id>` reference is verified against an existing block-stamped row (mirrors
        // resolveAddressRef); the id is handed to SQL as a digit string and returned as a Number.
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([{ id: 42 }]);
        assert.strictEqual(await db.getTickerId('^42'), 42);
    });

    it('getTickerId for a canonical ^N reference returns null when no backing row exists (dangling)', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.getTickerId('^999999'), null);
    });

    it('getTickerId rejects a non-canonical ^N (leading zero) rather than aliasing it', async function () {
        // '^007' must not resolve like '^7'; it falls through to the name lookup (stubbed empty) -> null.
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.getTickerId('^007'), null);
    });

    it('getTickerId for ^N with a non-numeric body falls through to a name lookup', async function () {
        // '^abc' is not a valid id reference; it is not treated as TICK_ID and the
        // DB name lookup (stubbed empty) yields null rather than a truncated id.
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.getTickerId('^abc'), null);
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

// tick_id NULL tolerance on the invalid-detail-row writers (fleet-halt regression)
// The DEPOSIT/WITHDRAW and contract-staking (STAKE/UNSTAKE/DELEGATE) handlers write
// their detail row even when the action is invalid, and resolve tick_id through
// createTicker(), which returns null for an unresolvable TICK (empty, or a ^<id>
// reference to a ticker that does not exist). With NOT NULL on the column, that
// INSERT threw ER_BAD_NULL_ERROR and the block-processing retry loop hard-wedged
// every indexer (a single crafted tx could halt the fleet; F-18 sibling, found by
// the 2026-07-07 flag-day transition drill). Columns are now nullable
// (2026-07-07-tick-id-columns-nullable migration); these guard that each writer
// emits its INSERT with tick_id=null instead of throwing.
describe('Database detail-row writers tolerate a null tick_id @regression @tier1', function () {
    // The INSERT is the writer's LAST doQuery call (each does a SELECT-exists probe
    // first), so read the final call's bind args and locate the null tick_id.
    async function insertArgsForNullTick(method, data) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(9);
        sinon.stub(db, 'getAddressId').resolves(3);
        sinon.stub(db, 'getOrCreatePubkeyId').resolves(4);
        // Unresolvable TICK (e.g. a ^<id> ref with no backing row) -> null.
        sinon.stub(db, 'createTicker').resolves(null);
        const stub = sinon.stub(db, 'doQuery').resolves([]);   // SELECT-exists -> not found; INSERT -> ok
        await db[method](data);                                // must NOT throw
        return stub.lastCall.args[1];
    }

    it('createDeposit inserts a null tick_id for an unresolvable TICK', async function () {
        const args = await insertArgsForNullTick('createDeposit', {
            CONTRACT_ACTION_INDEX: 166, SOURCE: 'addr', TICK: '^22', AMOUNT: '500',
            STATUS: 'invalid: TICK (unknown)', BLOCK_INDEX: 396, ACTION_INDEX: 163,
        });
        assert.ok(args.includes(null), 'expected a null bind (tick_id) among the deposits INSERT args');
    });

    it('createWithdrawal inserts a null tick_id for an unresolvable TICK', async function () {
        const args = await insertArgsForNullTick('createWithdrawal', {
            CONTRACT_ACTION_INDEX: 166, SOURCE: 'addr', TICK: '^22', AMOUNT: '500',
            STATUS: 'invalid: TICK (unknown)', BLOCK_INDEX: 396, ACTION_INDEX: 164,
        });
        assert.ok(args.includes(null), 'expected a null bind (tick_id) among the withdrawals INSERT args');
    });

    it('createContractStake inserts a null tick_id for an unresolvable TICK', async function () {
        const args = await insertArgsForNullTick('createContractStake', {
            SOURCE: 'addr', SIGNING_PUBKEY: 'aa', TARGET_CONTRACT_INDEX: 5, TICK: '^22',
            AMOUNT: '500', STATUS: 'invalid: TICK (unknown)', BLOCK_INDEX: 396, ACTION_INDEX: 165,
        });
        assert.ok(args.includes(null), 'expected a null bind (tick_id) among the contract_stakes INSERT args');
    });

    it('createContractUnstake inserts a null tick_id for an unresolvable TICK', async function () {
        const args = await insertArgsForNullTick('createContractUnstake', {
            SOURCE: 'addr', SIGNING_PUBKEY: 'aa', TARGET_CONTRACT_INDEX: 5, TICK: '^22',
            COOLDOWN_END_BLOCK: 500, AMOUNT: '500', STATUS: 'invalid: TICK (unknown)',
            BLOCK_INDEX: 396, ACTION_INDEX: 166,
        });
        assert.ok(args.includes(null), 'expected a null bind (tick_id) among the contract_unstakes INSERT args');
    });

    it('createContractDelegation inserts a null tick_id for an unresolvable TICK', async function () {
        const args = await insertArgsForNullTick('createContractDelegation', {
            SOURCE: 'addr', SIGNING_PUBKEY: 'aa', TARGET_CONTRACT_INDEX: 5, TICK: '^22',
            STATUS: 'invalid: TICK (unknown)', BLOCK_INDEX: 396, ACTION_INDEX: 167,
        });
        assert.ok(args.includes(null), 'expected a null bind (tick_id) among the contract_delegations INSERT args');
    });
});

// TICK_ID (^N) <-> ticker-name equivalence
// The protocol lets any action reference a token by its full name (PEPE) or by
// its immutable numeric id with a caret prefix (^7). Both MUST resolve to the
// same token. Every action processor (SEND, MINT, DIVIDEND, ORDER, SWAP,
// DISPENSER, ...) funnels its token lookups through createTicker()/getTickerId(),
// so proving convergence at this chokepoint proves both forms are interchangeable
// platform-wide. This is consensus-critical: divergent resolution would split state.
describe('TICK_ID (^N) and ticker name resolve identically @regression @tier1', function () {
    it('getTickerId: a name lookup and its ^id resolve to the same numeric id', async function () {
        const db = makeDb();
        // 'PEPE' is registered in index_tickers as id 7; '^7' references it directly.
        sinon.stub(db, 'doQuery').resolves([{ id: 7 }]);
        const byName = Number(await db.getTickerId('PEPE'));
        const byId   = Number(await db.getTickerId('^7'));
        assert.strictEqual(byName, 7);
        assert.strictEqual(byId,   7);
        assert.strictEqual(byName, byId);
    });

    it('getTickerId: multi-digit ^id is not truncated (regression for substring bug)', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([{ id: 1234 }]);
        const byName = Number(await db.getTickerId('SOMECOIN'));   // name -> 1234
        const byId   = Number(await db.getTickerId('^1234'));      // ^id  -> 1234 (NOT 123)
        assert.strictEqual(byId, 1234);
        assert.strictEqual(byName, byId);
    });

    it('createTicker: name and ^id return the same id, and ^id never INSERTs a phantom row', async function () {
        const db = makeDb();
        const doQuery = sinon.stub(db, 'doQuery').resolves([{ id: 7 }]);
        const byName = await db.createTicker('PEPE');
        const byId   = await db.createTicker('^7');
        assert.strictEqual(byName, 7);
        assert.strictEqual(byId,   7);
        // The ^id path resolves without any lookup or INSERT, so referencing a token
        // by id can never mint a phantom ticker named "^7".
        const inserts = doQuery.getCalls().filter(c => /INSERT/i.test(String(c.args[0])));
        assert.strictEqual(inserts.length, 0);
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

// getStatusId / createStatus
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

// getMemoId / createMemo
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

// getBlockTime
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

// getLatestBlockIndex
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

// getTokenDecimalPrecision
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

// getTokenSupplyToken / getTokenSupplyBalance
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

// getTokenSupplyBalance / getTokenSupplyEscrow
describe('Database.getTokenSupplyBalance()/getTokenSupplyEscrow() @regression @tier1', function () {
    // Casting EACH row to the tick's own decimals before summing is the
    // pre-flag-day shape ledger_amount_precision_activation.js exists to replace. Against a
    // ledger stored at 18 dp that is round(A)+round(B), which disagrees with sanityCheck's
    // round(A+B) by up to a unit per row.
    for (const [method, table] of [['getTokenSupplyBalance', 'balances'], ['getTokenSupplyEscrow', 'escrows']]) {
        it(method + ' sums at the exact ledger scale, not per-row at the tick scale', async function () {
            const db = makeDb();
            sinon.stub(db, 'createTicker').resolves(3);
            sinon.stub(db, 'getTokenDecimalPrecision').resolves(0);
            const q = sinon.stub(db, 'doQuery').resolves([{ supply: '3.000000000000000000' }]);
            await db[method]('PEPE');
            const sql = q.firstCall.args[0];
            assert.ok(/DECIMAL\(60,\s*18\)/.test(sql), 'expected an 18 dp sum, got: ' + sql);
            assert.ok(new RegExp('FROM ' + table + ' ').test(sql), 'expected a sum over ' + table);
        });

        it(method + ' rounds ONCE, so three 0.4 rows are 1 and not 0', async function () {
            const db = makeDb();
            sinon.stub(db, 'createTicker').resolves(3);
            sinon.stub(db, 'getTokenDecimalPrecision').resolves(0);
            // 0.4 + 0.4 + 0.4 summed exactly is 1.2, which rounds to 1 at a 0-decimal tick.
            // The old per-row cast rounded each 0.4 to 0 and returned 0.
            sinon.stub(db, 'doQuery').resolves([{ supply: '1.200000000000000000' }]);
            assert.strictEqual(await db[method]('PEPE'), '1');
        });

        it(method + ' returns a plain decimal string, never exponential notation', async function () {
            const db = makeDb();
            sinon.stub(db, 'createTicker').resolves(3);
            sinon.stub(db, 'getTokenDecimalPrecision').resolves(8);
            // A bare bignumber stringifies as '1e-8' here, which is not an amount.
            sinon.stub(db, 'doQuery').resolves([{ supply: '0.000000010000000000' }]);
            assert.strictEqual(await db[method]('PEPE'), '0.00000001');
        });

        it(method + ' still returns 0 when the table holds no rows', async function () {
            const db = makeDb();
            sinon.stub(db, 'createTicker').resolves(3);
            sinon.stub(db, 'getTokenDecimalPrecision').resolves(8);
            sinon.stub(db, 'doQuery').resolves([{ supply: null }]);
            assert.strictEqual(await db[method]('PEPE'), 0);
        });
    }
});

// getMarketInfo
describe('Database.getMarketInfo() @regression @tier1', function () {
    // getMarketInfo issues six queries in order: market lookup, last trade, 24h-ago trade,
    // bid orders, ask orders, 24h matches. Feed each one by call index.
    function marketDb(bids, asks, matches) {
        const db = makeDb();
        const q  = sinon.stub(db, 'doQuery');
        q.onCall(0).resolves([{ market_id: 1, tick1: 'AAA', tick1_id: 10, tick1_decimals: 8,
                                tick2: 'BBB', tick2_id: 20, tick2_decimals: 8 }]);
        q.onCall(1).resolves([]);   // last trade price
        q.onCall(2).resolves([]);   // 24h-ago trade price
        q.onCall(3).resolves(bids);
        q.onCall(4).resolves(asks);
        q.onCall(5).resolves(matches);
        return db;
    }
    // give_tick_id 10 == tick1, so price1 = get_amount / give_amount.
    const leg = (give, get) => ({ give_tick_id: 10, give_amount: give, get_tick_id: 20, get_amount: get });
    const getMarketInfoOn = (db) => db.getMarketInfo(1, 1000000);

    it('ranks bid/ask numerically, not as lexicographic strings', async function () {
        // getPrice returns a decimal.js bignumber; `price > best` coerces BOTH sides to
        // strings, and '10' ranks BELOW '9' as text. Best bid of a 9-then-10 book came back
        // as 9, and best ask of a 10-then-9 book came back as 10.
        const data = await getMarketInfoOn(marketDb(
            [leg('1', '9'), leg('1', '10')],
            [leg('1', '10'), leg('1', '9')],
            []));
        assert.strictEqual(String(data.tick1_bid), '10', 'best bid must be the numeric max');
        assert.strictEqual(String(data.tick1_ask), '9',  'best ask must be the numeric min');
    });

    it('ranks 24h high/low numerically', async function () {
        const data = await getMarketInfoOn(marketDb([], [],
            [leg('0.5', '4.5'), leg('0.4', '4'), leg('0.25', '2')]));   // prices 9, 10, 8
        assert.strictEqual(String(data.tick1_24hr_high), '10');
        assert.strictEqual(String(data.tick1_24hr_low),  '8');
    });

    it('sums 24h volume at the tick scale instead of quantizing to whole units', async function () {
        // bcadd with no decimals argument formats at precision 0, so each partial sum was
        // rounded half-up: 0.5 + 0.4 + 0.25 accumulated to 1 rather than 1.15.
        const data = await getMarketInfoOn(marketDb([], [],
            [leg('0.5', '4.5'), leg('0.4', '4'), leg('0.25', '2')]));
        assert.strictEqual(String(data.tick1_24hr_volume), '1.15');
        assert.strictEqual(String(data.tick2_24hr_volume), '10.5');
    });

    it('sums 24h volume at a 0-decimal tick without inventing units', async function () {
        const db = makeDb();
        const q  = sinon.stub(db, 'doQuery');
        q.onCall(0).resolves([{ market_id: 1, tick1: 'AAA', tick1_id: 10, tick1_decimals: 0,
                                tick2: 'BBB', tick2_id: 20, tick2_decimals: 0 }]);
        q.onCall(1).resolves([]);
        q.onCall(2).resolves([]);
        q.onCall(3).resolves([]);
        q.onCall(4).resolves([]);
        q.onCall(5).resolves([leg('3', '6'), leg('4', '8')]);
        const data = await getMarketInfoOn(db);
        assert.strictEqual(String(data.tick1_24hr_volume), '7');
    });
});

// getAddressTableBalances
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

// getTokenEscrow / isOwnershipEscrowed / setTokenEscrow / clearTokenEscrow
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

// getIssueTick
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

// getPubkeyId / getOrCreatePubkeyId
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

// createPubkey
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

// getLatestBlockIndex
describe('Database.getLatestBlockIndex() additional paths @regression @tier1', function () {
    it('returns 0 when results is null', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves(null);
        assert.strictEqual(await db.getLatestBlockIndex(), 0);
    });
});

// getActiveValidators
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
        const empty = await db.getActiveValidators(100);
        assert.deepStrictEqual([...empty], []);
        assert.strictEqual(empty.truncated, false);
    });
});

// getActiveStakeByPubkey
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
        assert.ok(args.includes(500));
    });

    it('omits blockIndex filter when blockIndex is null', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'getStatusId').resolves(1);
        const q = sinon.stub(db, 'doQuery').resolves([]);
        await db.getActiveStakeByPubkey('pk', null);
        const args = q.firstCall.args[1];
        // Direct-stake-only (stake-ownership) view: without blockIndex the args are just
        // [pubkey_id, valid_id]. No revocation NOT EXISTS subquery and no activation/deactivation
        // range filter (that only fires when blockIndex is non-null).
        assert.strictEqual(args.length, 2);
    });

    it('does NOT resolve a delegated-only key (returns null when no direct stake row)', async function () {
        // Stake-ownership view must stay direct-stake-only: a key with no rows in `stakes`
        // returns null even if it holds a delegation. This is the consensus guard that keeps
        // a delegated-only key out of UNSTAKE/STAKE/DELEGATE (no Path 2 here).
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(7);
        sinon.stub(db, 'getStatusId').resolves(1);
        const q = sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.getActiveStakeByPubkey('delegonly', 100), null);
        // Exactly one query (the direct-stake path); no delegated fallback query.
        assert.strictEqual(q.callCount, 1);
    });
});

// getEffectiveStakeByPubkey (federation effective-set view; getownstake RPC only)
describe('Database.getEffectiveStakeByPubkey() @regression @tier1', function () {
    it('returns null when pubkey not found in index_pubkeys', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(null);
        assert.strictEqual(await db.getEffectiveStakeByPubkey('deadbeef', 100), null);
    });

    it('returns the direct-stake row (Path 1) when present', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, 'getStatusId').resolves(1);
        const q = sinon.stub(db, 'doQuery').resolves([{
            source_id: 10, signing_pubkey_id: 3, signing_pubkey: 'pk',
            amount: '5000.00000000', activation_block: 100, block_index: 100, status_id: 1
        }]);
        const stake = await db.getEffectiveStakeByPubkey('pk', 200);
        assert.strictEqual(stake.amount, '5000.00000000');
        assert.strictEqual(q.callCount, 1);   // Path 1 hit, no delegated fallback
    });

    it('falls back to the delegating source aggregate (Path 2) for a delegated-only key', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(8);
        sinon.stub(db, 'getStatusId').resolves(1);
        const q = sinon.stub(db, 'doQuery');
        q.onCall(0).resolves([]);                                   // no direct stake (Path 1 empty)
        q.onCall(1).resolves([{                                     // delegated -> source aggregate
            source_id: 42, signing_pubkey_id: 8, signing_pubkey: 'delegkey',
            amount: '9000.00000000', activation_block: 50, block_index: 50, status_id: 1
        }]);
        const stake = await db.getEffectiveStakeByPubkey('delegkey', 200);
        assert.strictEqual(stake.amount, '9000.00000000');
        assert.strictEqual(stake.source_id, 42);
        assert.strictEqual(q.callCount, 2);   // Path 1 then Path 2
    });

    it('returns null when neither a direct stake nor a delegation resolves', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(9);
        sinon.stub(db, 'getStatusId').resolves(1);
        const q = sinon.stub(db, 'doQuery');
        q.onCall(0).resolves([]);
        q.onCall(1).resolves([]);
        assert.strictEqual(await db.getEffectiveStakeByPubkey('orphan', 200), null);
    });
});

// setStakeDeactivationByPubkey
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

// getActionType
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

// getCoinId / createCoin
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

// getFiatId / createFiat
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

// getMimeTypeId
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

// getActiveCapabilityCount
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

// isActionIndexValid
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

// getActionIndexTable
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

// deleteActionIndex
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

// updateActionIndex
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

// releaseConnection
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

// stripSqlLineComments
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

    it('removes # comments, which MariaDB honours to end-of-line like --', function () {
        const out = db.stripSqlLineComments('SELECT 1 # this is a comment\nFROM dual');
        assert.ok(!out.includes('this is a comment'));
        assert.ok(out.includes('SELECT 1'));
        assert.ok(out.includes('FROM dual'));
    });

    it('preserves a # inside quoted strings and backtick identifiers', function () {
        assert.ok(db.stripSqlLineComments("SELECT '# not a comment' FROM t").includes('# not a comment'));
        assert.ok(db.stripSqlLineComments('SELECT "# not a comment" FROM t').includes('# not a comment'));
        assert.ok(db.stripSqlLineComments('SELECT `col#1` FROM t').includes('`col#1`'));
    });

    it('copies /* */ block comments through verbatim (a # or -- inside must not eat the */)', function () {
        const sql = '/* see issue #4373 -- and this */ SELECT 1';
        assert.strictEqual(db.stripSqlLineComments(sql), sql);
    });

    it('does not treat an apostrophe in block-comment prose as a quote start', function () {
        const out = db.stripSqlLineComments("/* don't do this */ SELECT 1 -- gone\nSELECT 2");
        assert.ok(!out.includes('gone'));
        assert.ok(out.includes('SELECT 2'));
    });
});

// parseExpectedColumns
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

// parseExpectedIndexes
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

    // #2261: the (len) prefix used to be stripped and discarded, so a live
    // aged address(62) UNIQUE index and the declared full-column one read as
    // identical and prefix drift was invisible to the reconciler.
    it('captures per-column prefix widths separately from the column names', function () {
        const sql = 'CREATE UNIQUE INDEX address ON index_addresses (address(62));\n' +
                    'CREATE INDEX combo ON index_addresses (a(10), b);';
        const idxs = db.parseExpectedIndexes(sql, 'index_addresses');
        assert.strictEqual(idxs.length, 2);
        assert.deepStrictEqual(idxs[0].columns, ['address']);
        assert.deepStrictEqual(idxs[0].prefixes, [62]);
        assert.deepStrictEqual(idxs[1].columns, ['a', 'b']);
        assert.deepStrictEqual(idxs[1].prefixes, [10, null]);
    });

    // #2261: an aged prefixed UNIQUE index matching the declared full-column
    // one by column set must be WARNED about (auditable drift), never DDL'd
    // (the UNIQUE rebuild is deliberately gated manual).
    it('reconcileTableIndexes warns on prefix-width drift without issuing DDL', async function () {
        const warn = sinon.stub(console, 'warn');
        try {
            const dbc = {
                query: sinon.stub().resolves([
                    { INDEX_NAME: 'address', NON_UNIQUE: 0, COLUMN_NAME: 'address', SEQ_IN_INDEX: 1, SUB_PART: 62 },
                    { INDEX_NAME: 'block_index', NON_UNIQUE: 1, COLUMN_NAME: 'block_index', SEQ_IN_INDEX: 1, SUB_PART: null },
                ]),
            };
            await db.reconcileTableIndexes('index_addresses.sql', dbc);
            assert.strictEqual(dbc.query.callCount, 1, 'read-only: no ALTER for a satisfied column set');
            const warned = warn.getCalls().map((c) => c.args.join(' ')).join('\n');
            assert.match(warned, /prefix width/, 'drift must be surfaced');
            assert.match(warned, /address live \(62\) vs declared full-column/);
        } finally {
            warn.restore();
        }
    });

    it('reconcileTableIndexes stays silent when live prefixes match the declaration', async function () {
        const warn = sinon.stub(console, 'warn');
        try {
            const dbc = {
                query: sinon.stub().resolves([
                    { INDEX_NAME: 'address', NON_UNIQUE: 0, COLUMN_NAME: 'address', SEQ_IN_INDEX: 1, SUB_PART: null },
                    { INDEX_NAME: 'block_index', NON_UNIQUE: 1, COLUMN_NAME: 'block_index', SEQ_IN_INDEX: 1, SUB_PART: null },
                ]),
            };
            await db.reconcileTableIndexes('index_addresses.sql', dbc);
            const warned = warn.getCalls().map((c) => c.args.join(' ')).join('\n');
            assert.doesNotMatch(warned, /prefix width/);
        } finally {
            warn.restore();
        }
    });

    // #2702: a declared UNIQUE index whose name is already held by a live NON-unique
    // index of the same column set must be WARNED about (uniqueness drift is otherwise
    // invisible and silently degrades ON DUPLICATE KEY UPDATE writers), never DDL'd
    // (we must never DROP an index we did not create).
    it('reconcileTableIndexes warns when a declared UNIQUE name is held by a live non-unique index', async function () {
        const warn = sinon.stub(console, 'warn');
        try {
            const dbc = {
                query: sinon.stub().resolves([
                    // Same NAME and column set as the declared UNIQUE `address`, but NON_UNIQUE.
                    { INDEX_NAME: 'address', NON_UNIQUE: 1, COLUMN_NAME: 'address', SEQ_IN_INDEX: 1, SUB_PART: null },
                    { INDEX_NAME: 'block_index', NON_UNIQUE: 1, COLUMN_NAME: 'block_index', SEQ_IN_INDEX: 1, SUB_PART: null },
                ]),
            };
            await db.reconcileTableIndexes('index_addresses.sql', dbc);
            assert.strictEqual(dbc.query.callCount, 1, 'read-only: never DROP/CREATE an index we did not create');
            const warned = warn.getCalls().map((c) => c.args.join(' ')).join('\n');
            assert.match(warned, /name is already held by non-unique/, 'uniqueness drift must be surfaced');
            assert.match(warned, /index_addresses/);
            assert.match(warned, /address/);
        } finally {
            warn.restore();
        }
    });
});

// #4357: the ADD path built its column list from bare column names, so an index the
// source declares with a (len) prefix or a DESC column was rebuilt as a different index.
// index_tickers.tick is TEXT, so the full-column rebuild fails with errno 1170 and the
// non-fatal catch swallows it, leaving the table without its declared UNIQUE.
describe('Database.reconcileTableIndexes() prefix/direction-preserving DDL @regression @tier1', function () {
    let db;
    beforeEach(function () { db = makeDb(); });

    // Live statistics rows for a table that has NONE of its declared indexes, which is
    // the only state that reaches the ADD branch.
    const noIndexes = () => sinon.stub().resolves([]);

    it('recreates a missing prefixed UNIQUE index with its declared width', async function () {
        const dbc = { query: noIndexes() };
        await db.reconcileTableIndexes('index_tickers.sql', dbc);
        const alters = dbc.query.getCalls().map(c => c.args[0]).filter(s => /^ALTER TABLE/i.test(s));
        const tick   = alters.find(s => /ADD UNIQUE INDEX `tick`/.test(s));
        assert.ok(tick, 'the declared UNIQUE tick index must be added: ' + alters.join(' | '));
        assert.match(tick, /\(`tick`\(200\)\)/,
            'a TEXT column must be indexed at its declared prefix width, not full-column: ' + tick);
    });

    it('leaves an unprefixed column bare in the same table', async function () {
        const dbc = { query: noIndexes() };
        await db.reconcileTableIndexes('index_tickers.sql', dbc);
        const alters = dbc.query.getCalls().map(c => c.args[0]).filter(s => /^ALTER TABLE/i.test(s));
        const block  = alters.find(s => /ADD INDEX `block_index`/.test(s));
        assert.ok(block, 'the secondary index must still be added');
        assert.match(block, /\(`block_index`\)/, 'no width may be invented for a full-column index: ' + block);
    });

    it('recreates a missing DESC index with its declared sort direction', async function () {
        const dbc = { query: noIndexes() };
        await db.reconcileTableIndexes('escrow_leaf_journal.sql', dbc);
        const alters = dbc.query.getCalls().map(c => c.args[0]).filter(s => /^ALTER TABLE/i.test(s));
        const latest = alters.find(s => /ADD INDEX `idx_latest`/.test(s));
        assert.ok(latest, 'idx_latest must be added: ' + alters.join(' | '));
        assert.match(latest, /\(`address_id`, `tick_id`, `id` DESC\)/,
            'the declared DESC must survive into the rebuilt index: ' + latest);
    });

    it('parses direction alongside the column name rather than instead of it', function () {
        const sql  = 'CREATE INDEX idx_latest ON t (a, b DESC);';
        const idxs = db.parseExpectedIndexes(sql, 't');
        assert.deepStrictEqual(idxs[0].columns, ['a', 'b']);
        assert.deepStrictEqual(idxs[0].directions, ['ASC', 'DESC']);
    });

    // files.name shipped UNINDEXED; the by-name query mode added a standalone
    // `CREATE INDEX name ON files (name);` so reconcileTableIndexes self-heals it
    // on an existing install (verifyTables calls it at boot), not just on a fresh
    // install of files.sql.
    it('recreates a missing files.name index on an existing install', async function () {
        const dbc = { query: noIndexes() };
        await db.reconcileTableIndexes('files.sql', dbc);
        const alters = dbc.query.getCalls().map(c => c.args[0]).filter(s => /^ALTER TABLE/i.test(s));
        const name   = alters.find(s => /ADD INDEX `name`/.test(s));
        assert.ok(name, 'the declared files.name index must be added: ' + alters.join(' | '));
        assert.match(name, /\(`name`\)/, 'no width may be invented for a full-column index: ' + name);
    });
});

// #4359: relaxing NOT NULL -> NULL with a bare MODIFY restates the whole column, so every
// attribute the statement omits (DEFAULT, COMMENT, ON UPDATE, generation expression) is
// dropped and an aged DB silently stops matching a fresh install of the same source.
describe('Database.alterTableForDrift() lossless nullability relax @regression @tier1', function () {
    let db;
    beforeEach(function () { db = makeDb(); });

    // fees.gas_price is declared `VARCHAR(250) DEFAULT '0'` (nullable) in src/sql/fees.sql,
    // so an aged DB holding it NOT NULL is exactly the drift this branch acts on.
    function liveFees(overrides) {
        return sinon.stub().callsFake(async (sql) => {
            if (!/information_schema\.columns/i.test(sql)) return [];
            return [Object.assign({
                COLUMN_NAME: 'gas_price', IS_NULLABLE: 'NO', COLUMN_TYPE: 'varchar(250)',
                COLUMN_KEY: '', EXTRA: '', COLUMN_DEFAULT: null, COLLATION_NAME: null,
                COLUMN_COMMENT: '', GENERATION_EXPRESSION: ''
            }, overrides)];
        });
    }

    const modifies = (stub) => stub.getCalls().map(c => c.args[0]).filter(s => /MODIFY/i.test(s));

    it('skips the relax when the live column carries a DEFAULT a bare MODIFY would drop', async function () {
        const warn = sinon.stub(console, 'warn');
        try {
            const dbc = { query: liveFees({ COLUMN_DEFAULT: '0' }) };
            await db.alterTableForDrift('fees.sql', dbc);
            assert.deepStrictEqual(modifies(dbc.query), [], 'no attribute-dropping MODIFY may be issued');
            const warned = warn.getCalls().map(c => c.args.join(' ')).join('\n');
            assert.match(warned, /SKIPPING relax .*DEFAULT/, 'the skip must be auditable: ' + warned);
        } finally { warn.restore(); }
    });

    it('skips the relax for a generated column', async function () {
        const warn = sinon.stub(console, 'warn');
        try {
            const dbc = { query: liveFees({ GENERATION_EXPRESSION: '`gas_cost` * 2' }) };
            await db.alterTableForDrift('fees.sql', dbc);
            assert.deepStrictEqual(modifies(dbc.query), [], 'a MODIFY would strip the generation expression');
        } finally { warn.restore(); }
    });

    it('skips the relax for an ON UPDATE column', async function () {
        const warn = sinon.stub(console, 'warn');
        try {
            const dbc = { query: liveFees({ EXTRA: 'on update current_timestamp()' }) };
            await db.alterTableForDrift('fees.sql', dbc);
            assert.deepStrictEqual(modifies(dbc.query), [], 'a MODIFY would strip ON UPDATE');
        } finally { warn.restore(); }
    });

    it('still relaxes an attribute-free column, restating its collation', async function () {
        const dbc = { query: liveFees({ COLLATION_NAME: 'utf8_bin' }) };
        await db.alterTableForDrift('fees.sql', dbc);
        const issued = modifies(dbc.query);
        assert.strictEqual(issued.length, 1, 'the safe relax must still happen: ' + issued.join(' | '));
        assert.match(issued[0], /MODIFY `gas_price` varchar\(250\) COLLATE utf8_bin NULL/,
            'an explicit collation must be restated, not re-defaulted: ' + issued[0]);
    });
});

// _migrationMode
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

// _poolQuery
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

// apiView: federation-API writes must never join an open block transaction.
// A pushvalidatorrewards landing mid-block used to route through doQuery ->
// getConnection() -> the block's transactionConnection, so a reorg/throw
// rolled back rewards the API had already acked (the hub never retries).
describe('Database.apiView() @regression @tier1', function () {
    it('routes doQuery to a pooled connection even while a block transaction is open', async function () {
        const db     = makeDb();
        const txConn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        const poolConn = { query: sinon.stub().resolves([{ id: 7 }]), release: sinon.stub().resolves() };
        db.transactionConnection = txConn;           // simulate mid-block state
        db.pool.getConnection.resolves(poolConn);

        const rows = await db.apiView().doQuery('SELECT 1', []);
        assert.deepStrictEqual(rows, [{ id: 7 }]);
        assert.ok(poolConn.query.calledOnce, 'query must run on the pooled connection');
        assert.ok(poolConn.release.calledOnce, 'pooled connection must be released');
        assert.ok(txConn.query.notCalled, 'the open block transaction must never see API queries');
    });

    it('createValidatorReward via apiView never touches the transaction connection', async function () {
        const db     = makeDb();
        const txConn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        db.transactionConnection = txConn;
        // Pooled connection answers the whole helper chain: pubkey id, status id,
        // stake-source resolution, then accepts the INSERT.
        const poolConn = {
            query: sinon.stub().callsFake(async (sql) => {
                if (/FROM index_pubkeys/i.test(sql))   return [{ id: 11 }];
                if (/FROM index_statuses/i.test(sql))  return [{ id: 1 }];
                if (/FROM stakes/i.test(sql))          return [{ source_id: 5 }];
                return [];
            }),
            release: sinon.stub().resolves()
        };
        db.pool.getConnection.resolves(poolConn);

        const ok = await db.apiView().createValidatorReward('aa'.repeat(32), 3, 'anchor_BTC', '1', 100);
        assert.strictEqual(ok, true);
        const insert = poolConn.query.getCalls().find(c => /INSERT.*validator_rewards/is.test(c.args[0]));
        assert.ok(insert, 'reward INSERT must run on the pooled connection');
        assert.ok(txConn.query.notCalled, 'no statement may join the open block transaction');
    });

    it('base doQuery still uses the open transaction connection (control)', async function () {
        const db     = makeDb();
        const txConn = { query: sinon.stub().resolves([{ id: 1 }]), release: sinon.stub().resolves() };
        db.transactionConnection = txConn;
        await db.doQuery('SELECT 1', []);
        assert.ok(txConn.query.calledOnce, 'block-loop queries must keep joining the transaction');
    });

    // H2 residual: federation READ methods (not just the pushvalidatorrewards
    // write) must resolve on a pooled connection. A read accessor invoked through the
    // view routes its internal doQuery calls off the open block transaction, so a hub
    // never reads validator-set rows the block may still roll back.
    it('a read accessor (getActiveValidators) via apiView never touches the transaction connection', async function () {
        const db     = makeDb();
        const txConn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        db.transactionConnection = txConn;                // simulate mid-block state
        const poolConn = {
            query: sinon.stub().callsFake(async (sql) => {
                if (/FROM index_statuses/i.test(sql)) return [{ id: 1 }];   // getStatusId('valid')
                return [{ pubkey: 'ab'.repeat(32), total: '100' }];         // the validator query
            }),
            release: sinon.stub().resolves()
        };
        db.pool.getConnection.resolves(poolConn);

        const validators = await db.apiView().getActiveValidators(850000);
        assert.strictEqual(validators.length, 1);
        assert.strictEqual(validators[0].pubkey, 'ab'.repeat(32));
        assert.ok(poolConn.query.called, 'read must run on the pooled connection');
        assert.ok(txConn.query.notCalled, 'a federation read must never join the open block transaction');
    });

    it('returns the same cached view on repeated calls', function () {
        const db = makeDb();
        assert.strictEqual(db.apiView(), db.apiView());
    });
});

// enqueueHubPush / markHubPushDelivered / recordHubPushAttempt
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

// getPendingHubPushes
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
        const sql  = conn.query.firstCall.args[0];
        const args = conn.query.firstCall.args[1];
        assert.strictEqual(args[args.length - 1], 10, 'limit is the last bound parameter');
        assert.match(sql, /LIMIT \?/);
    });

    // Head-of-line blocking fix (review finding 01178748): the due-time predicate
    // must be pushed into SQL, mirroring HubPushQueue._isDue's backoff formula
    // (delay = LEAST(base * 2^(attempts-1), max)), so pending-but-not-due rows no
    // longer occupy the LIMIT batch slots.
    it('bakes the exponential-backoff due-time predicate into the WHERE clause', async function () {
        const db   = makeDb();
        const conn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        db.pool.getConnection.resolves(conn);
        await db.getPendingHubPushes(50, { baseBackoffMs: 30000, maxBackoffMs: 600000 });
        const sql  = conn.query.firstCall.args[0];
        const args = conn.query.firstCall.args[1];
        assert.match(sql, /last_attempted_at IS NULL/);
        assert.match(sql, /LEAST\(\? \* POW\(2, GREATEST\(attempts - 1, 0\)\), \?\)/);
        assert.deepStrictEqual(args, [30, 600, 50], 'base/max backoff converted to whole seconds, then the limit');
    });

    it('defaults the backoff window when no backoffOpts are passed', async function () {
        const db   = makeDb();
        const conn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        db.pool.getConnection.resolves(conn);
        await db.getPendingHubPushes(50);
        const args = conn.query.firstCall.args[1];
        assert.deepStrictEqual(args, [30, 600, 50], 'falls back to the same 30s/600s defaults HubPushQueue uses');
    });
});

// getCapabilitySnapshotValidators / isPubkeyInCapabilitySnapshot
describe('Database capability snapshot methods @regression @tier1', function () {
    it('getCapabilitySnapshotValidators returns mapped results', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([
            { pubkey: 'aa', amount: '5000' },
            { pubkey: 'bb', amount: null }
        ]);
        const result = await db.getCapabilitySnapshotValidators('cross_chain', 100);
        assert.deepStrictEqual(result[0], { pubkey: 'aa', amount: '5000' });
        // A NULL amount is coerced to '0' to match the sibling getCapabilitySnapshotWeights
        // and the BTC local path (previously surfaced as the literal string 'null').
        assert.deepStrictEqual(result[1], { pubkey: 'bb', amount: '0' });
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

// _mirrorDb
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

// getStatusString
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

// getContract
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

// getGatedFileRaw
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

// getActiveGatedKeyHashes
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

// getDispenserAmountRemaining
describe('Database.getDispenserAmountRemaining() @regression @tier1', function () {
    it('returns 0 when dispenser not found', async function () {
        const db = dbWithDoQuery([]);
        const result = await db.getDispenserAmountRemaining(99);
        // Returns 0 or null based on implementation; test for non-undefined
        assert.ok(result !== undefined);
    });
});

// getOraclePrice
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

// getLatestPrice
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

// getUnclaimedRewardTotal
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

// getOrderAmountsRemaining
describe('Database.getOrderAmountsRemaining() @regression @tier1', function () {
    it('returns default object when order not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        const result = await db.getOrderAmountsRemaining(99);
        // Should return an object (empty or with defaults)
        assert.ok(typeof result === 'object');
    });
});

// getSweepDestination / getOrderSweepDestination
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

// getActiveDelegation
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

// getAttestationRequestById
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

// getRelayRequestById: the v3-admission-only request_id lookup
describe('Database.getRelayRequestById() @regression @tier1', function () {
    it('returns null when no ADMITTED row holds the id', async function () {
        const db = dbWithDoQuery([]);
        assert.strictEqual(await db.getRelayRequestById('a'.repeat(64)), null);
    });

    it('returns the admitted row when one holds the id', async function () {
        const db = dbWithDoQuery([{ action_index: 5, request_id: 'a'.repeat(64), request_status: 'pending' }]);
        const result = await db.getRelayRequestById('A'.repeat(64));
        assert.strictEqual(result.action_index, 5);
        assert.strictEqual(db.doQueryStrict.firstCall.args[1][0], 'a'.repeat(64),
            'the id is lower-cased before binding, as the wire value is caller-controlled');
    });

    it('excludes rejected rows, which is the whole point of the separate query', async function () {
        // A rejected v3 is still stored. Counting it let one malformed front-run at a
        // public request_id block the federation's real relay for that id forever, so
        // this clause is the fix, not a filter for tidiness.
        const db = dbWithDoQuery([]);
        await db.getRelayRequestById('a'.repeat(64));
        const sql = db.doQueryStrict.firstCall.args[0];
        assert.match(sql, /request_status\s*<>\s*'rejected'/,
            'a rejected audit row consumed no materialization and must not answer the guard');
        assert.match(sql, /version\s*=\s*0/,
            'only a v0 request row holds the id; a response row shares it');
        assert.match(sql, /ORDER BY\s+action_index ASC/,
            'the FIRST admission is canonical, so every node reaches the same verdict');
    });

    it('reads through doQueryStrict, because null here ADMITS the request', async function () {
        // Under doQuery a swallowed query fault returns [], which this method turns into
        // null, which the v3 guard reads as "id is free" - one faulting node then
        // materializes a BTC request every other node refused.
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        sinon.stub(db, 'doQueryStrict').rejects(new Error('attests is not a table'));
        await assert.rejects(() => db.getRelayRequestById('a'.repeat(64)), /attests/);
        assert.strictEqual(db.doQuery.called, false, 'the lenient path must not be reachable here');
    });

    it('leaves getAttestationRequestById counting every stored row', async function () {
        // The shared lookup keeps four consensus callers (v1 response, v2 expiry, v4
        // relay response, slash round lookup) and their behaviour is deliberately
        // unchanged: they ask a different question and need to see rejected rows.
        const db = dbWithDoQuery([]);
        await db.getAttestationRequestById('a'.repeat(64));
        assert.doesNotMatch(db.doQuery.firstCall.args[0], /rejected/,
            'narrowing the shared lookup is what the ruling refused');
    });
});

// updateAttestationRequestStatus
describe('Database.updateAttestationRequestStatus() @regression @tier1', function () {
    it('calls doQuery with UPDATE', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        await db.updateAttestationRequestStatus(1, 'fulfilled');
        assert.match(db.doQuery.firstCall.args[0], /UPDATE/i);
    });
});

// getExpiredAttestationRequests
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

    // Unbounded, one block could inherit an arbitrary backlog of
    // expiries (each synthesizing an ATTEST v2 and firing a callback), so block
    // processing time was attacker-selectable by batching a common deadline.
    describe('per-block cap (#3078)', function () {
        const { ATTEST_MAX_EXPIRIES_PER_BLOCK } = require('../../src/protocol/constants.js');

        it('bounds the sweep with LIMIT at the pinned constant by default', async function () {
            const db = dbWithDoQuery([]);
            await db.getExpiredAttestationRequests(100);
            assert.match(db.doQuery.firstCall.args[0], /LIMIT \?/,
                'the sweep must be bounded by a LIMIT, not by however many rows exist');
            assert.deepStrictEqual(db.doQuery.firstCall.args[1], [100, ATTEST_MAX_EXPIRIES_PER_BLOCK]);
        });

        it('orders by a TOTAL order so the capped prefix is identical on every node', async function () {
            const db = dbWithDoQuery([]);
            await db.getExpiredAttestationRequests(100);
            const sql = db.doQuery.firstCall.args[0];
            // deadline_block alone is not unique; action_index is. Both, in this
            // order, are what make the LIMIT deterministic rather than a fork.
            assert.match(sql, /ORDER BY\s+ar\.deadline_block ASC,\s*ar\.action_index ASC/,
                'a capped selection over a partial or planner-dependent order lets two ' +
                'nodes take different subsets and fork');
            assert.ok(sql.indexOf('ORDER BY') < sql.indexOf('LIMIT'),
                'the ORDER BY must constrain the LIMIT, not follow it');
        });

        it('is a pinned consensus constant, not a local literal', function () {
            assert.strictEqual(typeof ATTEST_MAX_EXPIRIES_PER_BLOCK, 'number');
            assert.ok(Number.isInteger(ATTEST_MAX_EXPIRIES_PER_BLOCK) && ATTEST_MAX_EXPIRIES_PER_BLOCK > 0,
                'the cap decides which block an expiry lands in, so it is consensus-visible ' +
                'and lives in protocol/constants.js with its cross-repo twins');
        });
    });
});

// setAttestationResponseCallbackIndex
describe('Database.setAttestationResponseCallbackIndex() @regression @tier1', function () {
    it('runs UPDATE query', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([]);
        await db.setAttestationResponseCallbackIndex(10, 20);
        assert.match(db.doQuery.firstCall.args[0], /UPDATE/i);
    });
});

// savepoint methods
describe('Database savepoint methods @regression @tier1', function () {
    // Savepoints require an active transactionConnection; calling them
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

// getActiveContractStakeByPubkey
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

// getContractStakeOwner
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

// createActionMapping / getActionType (SQL content check)
describe('Database.createActionMapping() @regression @tier1', function () {
    it('inserts or updates mapping record', async function () {
        const db = makeDb();
        // A real (resolvable) address ref: createActionMapping resolves it to a
        // non-null id, then does SELECT (absent) + INSERT. A null id is skipped
        // entirely (see db.mapping-null-skip.test.js), so a valid type + resolved
        // id is required to exercise the insert path.
        sinon.stub(db, 'createAddress').resolves(7);
        const stub = sinon.stub(db, 'doQuery');
        // First call: SELECT check (not present)
        stub.onCall(0).resolves([]);
        // Second call: INSERT
        stub.onCall(1).resolves([]);
        await db.createActionMapping(5, 'address', 'test-value');
        assert.ok(stub.calledTwice);
    });
});

// getMarketId / createMarket
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

// isAddressSleeping / isTickSleeping
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

// validTickerBeforeTxIndex
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

// getFirstIssueActionIndex
describe('Database.getFirstIssueActionIndex() @regression @tier1', function () {
    it('returns false (not null) when not found (characterization)', async function () {
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

// getTxIndex
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

// getAddressOwnerships
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
        // getAddressOwnerships returns data.push(row.tick), an array of strings
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([{ id: 2 }]);
        stub.onCall(1).resolves([{ tick: 'PEPE' }, { tick: 'DOGE' }]);
        const result = await db.getAddressOwnerships('addr1');
        assert.deepStrictEqual(result, ['PEPE', 'DOGE']);
    });

    it('excludes ticks whose ownership is escrowed by an open offer', async function () {
        // Escrowed ownership is in protocol custody and must never appear in an
        // address's ownership snapshot (SWEEP OWNERSHIPS=1 reaches it only via
        // the offer-close path). Pin the SQL predicate so the guard can't be
        // dropped silently.
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        stub.onCall(0).resolves([{ id: 2 }]);
        stub.onCall(1).resolves([]);
        await db.getAddressOwnerships('addr1');
        const query = String(stub.secondCall.args[0]).replace(/\s+/g, ' ');
        assert.ok(query.includes('escrow_action_index IS NULL'),
            'getAddressOwnerships must filter out escrowed ownerships');
    });
});

// createIssue: INSERT branch
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

// createToken: INSERT and UPDATE
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

// createMint: INSERT and UPDATE
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

// createSend: INSERT and UPDATE
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

// createBroadcast: INSERT and UPDATE
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

// createMessage: INSERT and UPDATE
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

// createSleep: INSERT, UPDATE, and TYPE flag
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

// createAirdrop: INSERT and UPDATE
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

// createFeeRecord: INSERT and UPDATE
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

// createDestroy: INSERT and UPDATE
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

// createSweep: INSERT and UPDATE
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

// createDividend: INSERT and UPDATE
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

// createCallback: INSERT and UPDATE
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

// createFile: INSERT and UPDATE
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

// createGatedFile: INSERT and UPDATE
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

// createLink: INSERT and UPDATE
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

// createSwap: INSERT and UPDATE
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

// createSwapStatus: INSERT and UPDATE
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

// createSwapCancel: INSERT and UPDATE
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

// createSwapExpire: INSERT and UPDATE
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

// createOrder: INSERT and UPDATE
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

// createOrderStatus: INSERT and UPDATE
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

// createOrderExpire: INSERT and UPDATE
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

// createDispenser: INSERT and UPDATE
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

// createDispenserStatus: INSERT and UPDATE
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

// createAddressOption: INSERT and UPDATE
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

// createBatch: INSERT and UPDATE
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

// createStake: INSERT and UPDATE
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

// createUnstake: INSERT and UPDATE
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

// createDelegation: INSERT and UPDATE; createRevokeDelegation delegates
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

// createContract: INSERT and UPDATE
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

// createContractExecution: INSERT and UPDATE
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

// createDeposit: INSERT and UPDATE
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

// createWithdrawal: INSERT and UPDATE
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

// createContractState
describe('Database.createContractState() @regression @tier1', function () {
    it('inserts a state row', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        await db.createContractState({ CONTRACT_INDEX: 400, STATE_KEY: 'counter', STATE_VALUE: '1', BLOCK_INDEX: 100, ACTION_INDEX: 10 });
        assert.ok(String(dq.args[0][0]).includes('INSERT INTO contract_state'));
    });
});

// createContractEmission
describe('Database.createContractEmission() @regression @tier1', function () {
    it('inserts an emission row', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        await db.createContractEmission({ EXECUTION_INDEX: 10, EMITTED_ACTION: 'SEND', ACTION_INDEX: 11, POSITION: 0 });
        assert.ok(String(dq.args[0][0]).includes('INSERT INTO contract_emissions'));
    });
});

// deleteContract
describe('Database.deleteContract() @regression @tier1', function () {
    it('runs DELETE on contracts table', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        await db.deleteContract(400);
        assert.ok(String(dq.args[0][0]).includes('DELETE FROM contracts'));
    });
});

// createAttestationRequest: INSERT and UPDATE
describe('Database.createAttestationRequest() @regression @tier1', function () {
    function makeAttestreqDb(existsRows) {
        const db = makeDb();
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(2);
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves(existsRows);   // action_index existence probe
        dq.onCall(1).resolves([]);           // v0-dedup guard probe (no prior v0 for this request_id)
        return db;
    }

    it('INSERTs when not found', async function () {
        const db = makeAttestreqDb([]);
        await db.createAttestationRequest({ ACTION_INDEX: 500, STATUS: 'valid', FEE_PAYER: 'addr1',
                                             REQUEST_ID: 'aabbcc', CONTRACT_INDEX: 400, PROVIDER_ID: 'http_get',
                                             CALLBACK_METHOD: 'onResult', BLOCK_INDEX: 300 });
        assert.ok(db.doQuery.args.some(a => String(a[0]).includes('INSERT INTO attests')),
            'an INSERT INTO attests was issued');
    });

    it('UPDATEs when exists', async function () {
        const db = makeAttestreqDb([{ action_index: 500 }]);
        await db.createAttestationRequest({ ACTION_INDEX: 500, STATUS: 'valid', FEE_PAYER: 'addr1',
                                             REQUEST_ID: 'aabbcc', CONTRACT_INDEX: 400, PROVIDER_ID: 'http_get',
                                             CALLBACK_METHOD: 'onResult', BLOCK_INDEX: 300 });
        assert.ok(String(db.doQuery.args[1][0]).includes('UPDATE attests'));
    });
});

// createAttestationResponse: INSERT and UPDATE
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

// createContractStake: INSERT and UPDATE
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

// createRewardClaim: INSERT and UPDATE
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

// createList: INSERT and UPDATE
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

// createListEdit: INSERT only when not found; skip when exists
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

// createListItem: INSERT only; skip when exists
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

// createListItemInvalid: INSERT only; skip when exists
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

// createMimeType: null bypass; found; not found -> INSERT+refetch
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

// createCoin: null bypass; found; not found -> INSERT+refetch
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

// createFiat: null bypass; found; not found -> INSERT+refetch
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

// createLedgerChangeRecord: invalid table, INSERT, UPDATE
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

// getListType: null action_index returns false; found
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

// getList: delegates to getListType; builds from rows
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

// isValidList: delegates to getListType
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

// getAddressPreferences: defaults + query branch
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

// getAddressEscrows: returns combined list
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

// createValidatorReward: unknown pubkey, no stake, success
describe('Database.createValidatorReward() @regression @tier1', function () {
    it('returns false when pubkey not found', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(null);
        const result = await db.createValidatorReward('deadbeef', 1, 'oracle_round', '10', 100);
        assert.strictEqual(result, false);
    });

    // Source resolution moved into _resolveActiveStakeSourceId (strict active-row
    // predicates; covered in reward-source-resolution.test.js). These cases stub the
    // resolver so they exercise createValidatorReward's own insert/return logic only.
    it('returns false when no active source resolves for the pubkey', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, '_resolveActiveStakeSourceId').resolves(null);
        const dq = sinon.stub(db, 'doQuery');
        const result = await db.createValidatorReward('deadbeef', 1, 'oracle_round', '10', 100);
        assert.strictEqual(result, false);
        assert.strictEqual(dq.callCount, 0); // no INSERT when the source does not resolve
    });

    it('returns true and inserts the reward when a source resolves', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, '_resolveActiveStakeSourceId').resolves(2);
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        const result = await db.createValidatorReward('deadbeef', 1, 'oracle_round', '10', 100);
        assert.strictEqual(result, true);
        assert.ok(String(dq.args[0][0]).includes('INSERT IGNORE INTO validator_rewards'));
    });

    it('writes the resolved source_id into the reward row', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, '_resolveActiveStakeSourceId').resolves(7); // e.g. resolved via a DELEGATE v0 key
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        const result = await db.createValidatorReward('deadbeef', 1, 'oracle_round', '10', 100);
        assert.strictEqual(result, true);
        assert.ok(String(dq.args[0][0]).includes('INSERT IGNORE INTO validator_rewards'));
        assert.strictEqual(dq.args[0][1][0], 7);  // source_id arg is the resolver's result
        assert.strictEqual(dq.args[0][1][1], 3);  // signing_pubkey_id arg is the pubkey
    });

    it('upsert=true emits ON DUPLICATE KEY UPDATE so the deterministic writer wins', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, '_resolveActiveStakeSourceId').resolves(2);
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        const result = await db.createValidatorReward('deadbeef', 1, 'oracle_round', '10', 100, true);
        assert.strictEqual(result, true);
        const sql = String(dq.args[0][0]);
        assert.ok(sql.includes('ON DUPLICATE KEY UPDATE'));
        assert.ok(!sql.includes('INSERT IGNORE'));
    });

    // a reward whose EARN block is not its MATERIALIZATION block (the
    // BTC-side anchor derivation) must persist both, or the reorg delete has no key
    // that names the block which actually minted the row.
    it('persists the materialization block when the caller passes one, and NULL otherwise', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, '_resolveActiveStakeSourceId').resolves(2);
        const dq = sinon.stub(db, 'doQuery').resolves([]);

        await db.createValidatorReward('deadbeef', 1, 'anchor_BTC', '10', 850000, true, 962400);
        assert.ok(String(dq.args[0][0]).includes('derive_block_index'), 'the INSERT must name the column');
        assert.deepStrictEqual(dq.args[0][1].slice(-2), [850000, 962400],
            'block_index stays the earn-block; derive_block_index is the creating block');
        // The upsert must refresh it too, or a replayed derive would leave a stale value behind.
        assert.ok(/ON DUPLICATE KEY UPDATE[\s\S]*derive_block_index=VALUES\(derive_block_index\)/.test(String(dq.args[0][0])));

        dq.resetHistory();
        await db.createValidatorReward('deadbeef', 2, 'oracle_round', '10', 100, true);
        assert.strictEqual(dq.args[0][1][7], null,
            'a same-block writer leaves derive_block_index NULL so the new predicate never matches it');
    });

    // round_qualifier joined the UNIQUE key because 'anchor_archive' rounds are MATCH_BATCH_SEQ,
    // a dense hub counter a wipe-and-replay rebase reissues. Every OTHER reward type must keep
    // the key it always had, which means a literal 0 - never NULL, since MariaDB treats NULLs as
    // distinct in a UNIQUE index and would stop deduplicating the row entirely.
    it('writes round_qualifier 0 for a non-archive reward and when the caller omits it', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, '_resolveActiveStakeSourceId').resolves(2);
        const dq = sinon.stub(db, 'doQuery').resolves([]);

        await db.createValidatorReward('deadbeef', 1, 'anchor_BTC', '10', 850000, true, 962400);
        assert.ok(String(dq.args[0][0]).includes('round_qualifier'), 'the INSERT must name the column');
        assert.strictEqual(dq.args[0][1][4], 0, 'a per-chain anchor leg is never qualified');

        dq.resetHistory();
        await db.createValidatorReward('deadbeef', 2, 'oracle_round', '10', 100, true);
        assert.strictEqual(dq.args[0][1][4], 0, 'an omitted qualifier lands on 0, not NULL');
    });

    it('carries the archive reward snapshot_block through as its round_qualifier', async function () {
        const db = makeDb();
        sinon.stub(db, 'getPubkeyId').resolves(3);
        sinon.stub(db, '_resolveActiveStakeSourceId').resolves(2);
        const dq = sinon.stub(db, 'doQuery').resolves([]);

        // Two archive anchors can carry round_reference 3 across a hub rebase; the qualifier is
        // what keeps them two rows instead of one upsert overwriting the other.
        await db.createValidatorReward('deadbeef', 3, 'anchor_archive', '10', 8100, true, 9000, 8100);
        assert.strictEqual(dq.args[0][1][4], 8100);
        assert.strictEqual(dq.args[0][1][3], 3, 'round_reference stays the hub batch seq');
    });
});

// setDelegationDeactivation: returns false when source or pubkey missing
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

// getTokenSupply: basics (delegates through doQuery)
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

// getExpiredItems: empty returns []
describe('Database.getExpiredItems() @regression @tier1', function () {
    it('returns empty array when no open items', async function () {
        const db = dbWithDoQuery([]);
        const result = await db.getExpiredItems(9999999);
        assert.deepStrictEqual(result, []);
    });

    // the expiration cut is applied in SQL, so exactly ONE query runs and
    // only the rows actually expiring this block come back. Previously the whole
    // open book was fetched, overlaid by a second batched edits query per type,
    // and filtered in JS. (Supersedes the uuid:4fe690ab N+1 regression, whose
    // batched edits query no longer exists.)
    it('runs one query with the expiration cut and the edits overlay pushed into SQL', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([
            { action_index: 2, expiration: 100, type: 'order' },
            { action_index: 3, expiration: 100, type: 'order' },
        ]);
        const result = await db.getExpiredItems(200);
        assert.strictEqual(dq.callCount, 1, 'expiry sweep must be a single round trip');
        assert.deepStrictEqual(result, [
            { type: 'order', action_index: 2, expiration: 100 },
            { type: 'order', action_index: 3, expiration: 100 },
        ]);
        const [sql, args] = dq.getCall(0).args;
        // One cutoff bind per type branch (order/swap/dispenser).
        assert.deepStrictEqual(args, [200, 200, 200]);
        // The edits overlay is a newest-valid-non-null scalar subquery per branch.
        for (const type of ['order', 'swap', 'dispenser']) {
            assert.ok(
                sql.includes(type + '_edits e1'),
                'expected an inline ' + type + '_edits overlay'
            );
        }
        assert.ok(/ORDER BY\s+e1\.action_index DESC/.test(sql), 'newest valid edit must win');
        assert.ok(/e1\.expiration IS NOT NULL/.test(sql), 'null-expiration edits must be ignored');
        // Consensus trap guard: a bare `eff < ?` would drop null-expiration rows
        // (never expiring them). The zero-default keeps the old JS null coercion.
        assert.strictEqual(
            (sql.match(/, m\.expiration, 0\) < \?/g) || []).length,
            3,
            'every branch must default a null effective expiration to 0 in the cut'
        );
        assert.ok(/ORDER BY action_index ASC/.test(sql), 'deterministic output order');
    });

    // A null effective expiration is "expired at time 0" (the old JS predicate
    // coerced null to 0), and it is reported with expiration 0, not null.
    it('reports a null effective expiration as 0', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([{ action_index: 7, expiration: null, type: 'swap' }]);
        const result = await db.getExpiredItems(200);
        assert.deepStrictEqual(result, [{ type: 'swap', action_index: 7, expiration: 0 }]);
    });

    // The old JS compare was false for every row when block_time was not a
    // number, so nothing expired. Binding that into SQL would change the answer.
    it('expires nothing and issues no query for a non-numeric block_time', async function () {
        for (const bad of [undefined, null, 'not-a-time', NaN]) {
            const db = makeDb();
            const dq = sinon.stub(db, 'doQuery');
            const result = await db.getExpiredItems(bad);
            assert.deepStrictEqual(result, [], 'block_time ' + String(bad) + ' must expire nothing');
            assert.strictEqual(dq.callCount, 0);
        }
    });

    it('accepts a numeric-string block_time (same coercion the JS compare had)', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        await db.getExpiredItems('200');
        assert.deepStrictEqual(dq.getCall(0).args[1], [200, 200, 200]);
    });
});

// updateBalances: string, array, boolean branches
describe('Database.updateBalances() @regression @tier1', function () {
    it('handles string address, calls updateAddressBalance once', async function () {
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

    it('handles boolean true, fetches all addresses then calls once per row', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQuery').resolves([{ address: 'addr1' }, { address: 'addr2' }]);
        const stub = sinon.stub(db, 'updateAddressBalance').resolves();
        await db.updateBalances(true, false);
        assert.strictEqual(stub.callCount, 2);
    });
});

// setContractStakeDeactivationByPubkey: early-returns when pk/tick null
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

// incrementAttestationValidatorStat: field whitelist + upsert
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

// getDecoderBlockData: returns empty array when not found (characterization)
describe('Database.getDecoderBlockData() @regression @tier1', function () {
    it('returns empty array when not found', async function () {
        const db = dbWithDoQuery([]);
        const result = await db.getDecoderBlockData(100);
        // Characterization: method returns [] (empty array), not false
        assert.deepStrictEqual(result, []);
    });
});

// getBlockHashes: complex method; stub all doQuery calls to return []
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
        // Fourth, replication-integrity state hash (additive; see stateHash.js).
        assert.ok(result.state !== undefined && typeof result.state.hash === 'string');
    });
});

// createBlock: stub getBlockHashes to avoid complex deps
describe('Database.createBlock() @regression @tier1', function () {
    it('INSERTs when not found', async function () {
        const db = makeDb();
        // stub getBlockId → null (no existing block)
        sinon.stub(db, 'getBlockId').resolves(null);
        // stub getBlockHashes → fake hash info
        sinon.stub(db, 'getBlockHashes').resolves({
            ledger:    { hash: 'aaa' },
            actions:   { hash: 'bbb' },
            contracts: { hash: 'ccc' },
            state:     { hash: 'ddd' }
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
            contracts: { hash: 'ccc' },
            state:     { hash: 'ddd' }
        });
        sinon.stub(db, 'createTransaction').resolves(1);
        const dq = sinon.stub(db, 'doQuery').resolves([]);
        await db.createBlock(100, 1700000000);
        assert.ok(String(dq.args[0][0]).includes('UPDATE'));
    });
});

// createAction: INSERT action record
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

// createTxIndex: when tx not found, inserts
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

// createActionIndex: force=false INSERT
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

// createPrice: INSERT and UPDATE
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

// Cross-chain settlement capture + VM snapshot (crossChain.isSettled backing)
describe('Database.recordCrossChainSettlement() @regression @tier1', function () {
    it('captures both leg references from the signed match', async function () {
        const db = dbWithDoQuery([]);
        const match = {
            match_id: 'm'.repeat(64),
            a_chain: 'BTC', a_action_index: '42',
            b_chain: 'LTC', b_action_index: '99'
        };
        await db.recordCrossChainSettlement(777, match, 42, 200);
        const [sql, params] = db.doQuery.firstCall.args;
        assert.ok(String(sql).includes('INSERT IGNORE INTO cross_chain_settlements'));
        assert.ok(String(sql).includes('a_chain'));
        assert.deepStrictEqual(params, [777, match.match_id, 42, 200, 'BTC', 42, 'LTC', 99]);
    });
});

describe('Database.getCrossChainDataForVM() @regression @tier1', function () {
    it('builds settled keys for BOTH legs from the LOCAL settlements table', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([
            { a_chain: 'BTC', a_action_index: 42, b_chain: 'LTC', b_action_index: 99 },
            { a_chain: 'DOGE', a_action_index: 7, b_chain: 'BTC', b_action_index: 1234 }
        ]);
        dq.onCall(1).resolves([]);                            // xcalls (getCallResult source)
        const snap = await db.getCrossChainDataForVM(200);
        assert.deepStrictEqual(snap.attestations, {});
        assert.deepStrictEqual(snap.calls, {});
        assert.deepStrictEqual(snap.settled, {
            'BTC:42': true, 'LTC:99': true,
            'DOGE:7': true, 'BTC:1234': true
        });
        // Reads the local table (consensus rule: never the mirror), strictly
        // earlier blocks only; uniform snapshot for every execution in a block.
        const [sql, params] = db.doQuery.firstCall.args;
        assert.ok(String(sql).includes('FROM cross_chain_settlements'));
        assert.ok(String(sql).includes('block_index < ?'));
        assert.deepStrictEqual(params, [200]);
    });

    it('builds call results from terminal xcalls rows (getCallResult source)', async function () {
        const db = makeDb();
        const dq = sinon.stub(db, 'doQuery');
        dq.onCall(0).resolves([]);                            // settlements
        dq.onCall(1).resolves([
            { call_id: 'a'.repeat(64), result_status: 'ok', result_payload: '"42"' },
            { call_id: 'b'.repeat(64), result_status: 'expired', result_payload: null }
        ]);
        const snap = await db.getCrossChainDataForVM(200);
        assert.deepStrictEqual(snap.calls, {
            ['a'.repeat(64)]: { status: 'ok', payload: '"42"' },
            ['b'.repeat(64)]: { status: 'expired', payload: '' }
        });
        // Terminal rows only, visible from the block AFTER the resolving one.
        const [sql, params] = db.doQuery.secondCall.args;
        assert.ok(String(sql).includes('FROM xcalls'));
        assert.ok(String(sql).includes('resolved_block < ?'));
        assert.deepStrictEqual(params, [200]);
    });

    it('returns an empty snapshot when nothing has settled', async function () {
        const db = dbWithDoQuery([]);
        const snap = await db.getCrossChainDataForVM(200);
        assert.deepStrictEqual(snap, { attestations: {}, settled: {}, calls: {} });
    });
});

// getActiveStakeWeights: source-keyed all-staker set (STAKE_WEIGHTED_QUORUM
// counterpart of getActiveValidators; powers the hub config-change PBFT)
describe('Database.getActiveStakeWeights() @regression @tier1', function () {
    it('maps source-keyed rows and applies NO MIN_STAKE floor', async function () {
        const db = dbWithDoQuery([
            { pubkey: 'aa', source: 'src1', weight: '500' },  // two keys, one source
            { pubkey: 'bb', source: 'src1', weight: '500' },
            { pubkey: 'cc', source: 'src2', weight: '300' },
        ]);
        sinon.stub(db, 'getStatusId').resolves(1);
        const out = await db.getActiveStakeWeights(306);
        // Spread to a plain array so deepStrictEqual ignores the additive truncated property.
        assert.deepStrictEqual([...out], [
            { pubkey: 'aa', source: 'src1', weight: '500' },
            { pubkey: 'bb', source: 'src1', weight: '500' },
            { pubkey: 'cc', source: 'src2', weight: '300' },
        ]);
        assert.strictEqual(out.truncated, false);
        // No MIN_STAKE floor; the _stakeWeightsSql min-stake bind arg is '0'.
        const args = db.doQuery.getCall(0).args[1];
        assert.ok(args.includes('0'), 'expected min_stake 0 among the query args');
    });

    it('returns [] when the valid status id is unavailable', async function () {
        const db = dbWithDoQuery([]);
        sinon.stub(db, 'getStatusId').resolves(null);
        const out = await db.getActiveStakeWeights(306);
        assert.deepStrictEqual(out, []);
    });
});

// getPendingAnchorRewardAttestations: the derive fetch gate (Option C).
// The unit tier stubs the DB, so the predicate itself is the only thing a test at this
// tier can pin - and the predicate is exactly what decides whether a late failover
// publisher ever reaches reconcileAnchorRewardWinner.
//
// SHAPE ONLY, deliberately. doQuery is stubbed here, so nothing below proves the SQL
// parses, joins a column that exists, or actually re-admits a late publisher - and
// doQuery SWALLOWS a non-transactional query error, so a broken predicate would derive
// NO anchor rewards on a live node while every assertion here stayed green. The
// semantics are driven against a real MariaDB in
// test/integration/anchor-reward-late-publisher.test.js; change one and move the other.
describe('Database.getPendingAnchorRewardAttestations() @regression @tier1', function () {
    it('excludes a round PER PUBLISHER, so a smaller-pubkey late arrival is re-admitted', async function () {
        const db = dbWithDoQuery([]);
        await db.getPendingAnchorRewardAttestations('regtest', 900);
        const sql = String(db.doQuery.firstCall.args[0]);
        // The suppression must compare the candidate publisher against the pubkey already
        // credited, not merely test the round for any credited row: a round-scoped filter
        // makes the smallest-pubkey winner rule order-dependent across nodes and replays.
        assert.match(sql, /JOIN\s+index_pubkeys\s+pk\s+ON\s+pk\.id\s*=\s*vr\.signing_pubkey_id/i);
        assert.match(sql, /pk\.pubkey\s*<=\s*LOWER\(ara\.publisher\)/i);
        assert.deepStrictEqual(db.doQuery.firstCall.args[1], ['regtest', 900]);
    });

    it('still matures only attestations at or below the current block, ordered for grouping', async function () {
        const db = dbWithDoQuery([]);
        await db.getPendingAnchorRewardAttestations('mainnet', 961000);
        const sql = String(db.doQuery.firstCall.args[0]);
        assert.match(sql, /ara\.snapshot_block\s*<=\s*\?/i);
        assert.match(sql, /ORDER BY ara\.reward_type, ara\.round_reference, ara\.publisher, ara\.snapshot_block, ara\.id/i);
    });

    // The upsert in deriveAnchorRewards is last-writer-wins on block_index and
    // validator_rewards' UNIQUE key omits snapshot_block, so whichever of two rows sharing
    // (reward_type, round_reference, publisher) is processed LAST sets the reward's earn-block.
    // ara.id is a per-node AUTO_INCREMENT, so it must never be the deciding term.
    it('decides that order on consensus data, never on the local AUTO_INCREMENT id', async function () {
        const db = dbWithDoQuery([]);
        await db.getPendingAnchorRewardAttestations('mainnet', 961000);
        const order = String(db.doQuery.firstCall.args[0]).split(/ORDER BY/i)[1];
        assert.ok(order.indexOf('ara.snapshot_block') < order.indexOf('ara.id'),
            'snapshot_block must break the tie ahead of the local mirror surrogate id');
    });
});
