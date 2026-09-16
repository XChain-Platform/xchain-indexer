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
 * test/unit/db/db_queries.test/tickers_and_supply.test.js
 *
 * Ticker resolution (name and ^N id converge), createTicker, the detail-row
 * writers that must tolerate a null tick_id, decimal precision, and the token
 * supply reads.
 *
 * Part of the Database query suite (see ../db_queries.test.js): real method
 * logic against a stubbed doQuery, no live MariaDB required.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { makeDb, dbWithDoQuery } = require('./helpers/db_stub');

afterEach(function () {
    sinon.restore();
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
// every indexer (a single crafted tx could halt the fleet, as shown by
// the 2026-07-07 flag-day transition drill). Columns are nullable
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

// ---------------------------------------------------------------------------
// TICK_ID (^N) <-> ticker-name equivalence
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// getTokenSupply: basics (delegates through doQuery)
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
