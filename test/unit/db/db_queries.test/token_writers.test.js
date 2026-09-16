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
 * test/unit/db/db_queries.test/token_writers.test.js
 *
 * The token action row writers: issue, token, mint, send, airdrop, fee record,
 * destroy, sweep, dividend, and the mime type, coin and fiat rows.
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
// createIssue: INSERT branch
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
// createToken: INSERT and UPDATE
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
// createMint: INSERT and UPDATE
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
// createSend: INSERT and UPDATE
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
// createAirdrop: INSERT and UPDATE
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
// createFeeRecord: INSERT and UPDATE
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
// createDestroy: INSERT and UPDATE
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
// createSweep: INSERT and UPDATE
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
// createDividend: INSERT and UPDATE
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
// createMimeType: null bypass; found; not found -> INSERT+refetch
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
// createCoin: null bypass; found; not found -> INSERT+refetch
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
// createFiat: null bypass; found; not found -> INSERT+refetch
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
