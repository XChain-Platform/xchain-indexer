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
 * test/unit/db/db_queries.test/action_index.test.js
 *
 * The action index and tx index tables, action mappings, sleeping checks,
 * ticker and first-issue ordering, and the block rows (decoder data, hashes,
 * createBlock, createAction).
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
// createActionMapping / getActionType (SQL content check)
// ---------------------------------------------------------------------------
describe('Database.createActionMapping() @regression @tier1', function () {
    it('inserts or updates mapping record', async function () {
        const db = makeDb();
        // A real (resolvable) address ref: createActionMapping resolves it to a
        // non-null id, then does SELECT (absent) + INSERT. A null id is skipped
        // entirely (see db_mapping_null_skip.test.js), so a valid type + resolved
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
// getDecoderBlockData: returns empty array when not found (characterization)
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
// getBlockHashes: complex method; stub all doQuery calls to return []
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
        // Fourth, replication-integrity state hash (additive; see stateHash.js).
        assert.ok(result.state !== undefined && typeof result.state.hash === 'string');
    });
});

// ---------------------------------------------------------------------------
// createBlock: stub getBlockHashes to avoid complex deps
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

// ---------------------------------------------------------------------------
// createAction: INSERT action record
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
// createTxIndex: when tx not found, inserts
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
// createActionIndex: force=false INSERT
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
