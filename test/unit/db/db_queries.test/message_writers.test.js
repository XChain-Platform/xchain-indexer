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
 * test/unit/db/db_queries.test/message_writers.test.js
 *
 * The message-style row writers: broadcast, message, sleep, callback, file,
 * gated file, link, address option, and the list rows.
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
// createBroadcast: INSERT and UPDATE
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
// createMessage: INSERT and UPDATE
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
// createSleep: INSERT, UPDATE, and TYPE flag
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
// createCallback: INSERT and UPDATE
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
// createFile: INSERT and UPDATE
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
// createGatedFile: INSERT and UPDATE
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
// createLink: INSERT and UPDATE
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
// createAddressOption: INSERT and UPDATE
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
// createList: INSERT and UPDATE
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
// createListEdit: INSERT only when not found; skip when exists
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
// createListItem: INSERT only; skip when exists
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
// createListItemInvalid: INSERT only; skip when exists
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
