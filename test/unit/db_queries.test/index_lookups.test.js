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
 * test/unit/db_queries.test/index_lookups.test.js
 *
 * The index-table lookups and their create paths (transactions, addresses,
 * statuses, memos, action types, coins, fiats, mime types), the next tx and
 * action index, block time and latest block index, and getIssueTick.
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
