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
 * test/unit/db_queries.test/market_writers.test.js
 *
 * The market row writers: swaps, orders and dispensers with their status,
 * cancel and expire rows, batches, and the ledger change record.
 *
 * Part of the Database query suite (see ../db_queries.test.js): real method
 * logic against a stubbed doQuery, no live MariaDB required.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { makeDb } = require('./helpers/db_stub');

afterEach(function () {
    sinon.restore();
});

// ---------------------------------------------------------------------------
// createSwap: INSERT and UPDATE
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
// createSwapStatus: INSERT and UPDATE
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
// createSwapCancel: INSERT and UPDATE
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
// createSwapExpire: INSERT and UPDATE
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
// createOrder: INSERT and UPDATE
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
// createOrderStatus: INSERT and UPDATE
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
// createOrderExpire: INSERT and UPDATE
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
// createDispenser: INSERT and UPDATE
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
// createDispenserStatus: INSERT and UPDATE
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
// createBatch: INSERT and UPDATE
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
// createLedgerChangeRecord: invalid table, INSERT, UPDATE
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
