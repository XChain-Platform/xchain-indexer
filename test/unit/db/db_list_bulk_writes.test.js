'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../fixtures/config');
const Utility           = require('../../../src/utility');
const Database          = require('../../../src/db');
const listStore         = require('../../../src/actions/list/store');

function makeDb(existing = []) {
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    const calls = [];
    sinon.stub(db, 'doQuery').callsFake((query, args) => {
        calls.push({ query, args });
        if (/^\s*SELECT/i.test(query)) return Promise.resolve(existing);
        return Promise.resolve([]);
    });
    sinon.stub(db, 'createAddress').callsFake(async (a) => Number(a.replace(/\D/g, '')));
    sinon.stub(db, 'createTicker').callsFake(async (t) => Number(t.replace(/\D/g, '')));
    sinon.stub(db, 'createStatus').callsFake(async (s) => (s === 'valid' ? 1 : 2));
    db._calls = calls;
    return db;
}

const inserts = (db) => db._calls.filter((c) => /^\s*INSERT/i.test(c.query));

describe('LIST bulk item writes', function () {
    afterEach(() => sinon.restore());

    it('writes N items with one existence read and one insert', async function () {
        const db = makeDb();
        const items = Array.from({ length: 200 }, (_, i) => `addr${i + 1}`);
        await db.createListItems({ ACTION_INDEX: 7, TYPE: 2 }, items);
        assert.strictEqual(db._calls.filter((c) => /^\s*SELECT/i.test(c.query)).length, 1);
        assert.strictEqual(inserts(db).length, 1);
        assert.strictEqual(inserts(db)[0].args.length, 400);
        assert.deepStrictEqual(inserts(db)[0].args.slice(0, 4), [7, 1, 7, 2]);
    });

    it('chunks a large membership into bounded statements', async function () {
        const db = makeDb();
        const items = Array.from({ length: 1200 }, (_, i) => `addr${i + 1}`);
        await db.createListItems({ ACTION_INDEX: 7, TYPE: 2 }, items);
        const ins = inserts(db);
        assert.strictEqual(ins.length, 3);
        assert.deepStrictEqual(ins.map((c) => c.args.length / 2), [500, 500, 200]);
    });

    it('skips rows already stored and in-batch duplicates', async function () {
        const db = makeDb([{ item_id: 2 }]);
        await db.createListItems({ ACTION_INDEX: 7, TYPE: 2 }, ['addr1', 'addr2', 'addr1', 'addr3']);
        assert.deepStrictEqual(inserts(db)[0].args, [7, 1, 7, 3]);
    });

    it('issues no insert when every row exists', async function () {
        const db = makeDb([{ item_id: 1 }]);
        await db.createListItems({ ACTION_INDEX: 7, TYPE: 2 }, ['addr1']);
        assert.strictEqual(inserts(db).length, 0);
    });

    it('does nothing for an empty list', async function () {
        const db = makeDb();
        await db.createListItems({ ACTION_INDEX: 7, TYPE: 2 }, []);
        assert.strictEqual(db._calls.length, 0);
    });

    it('dedupes edits on item and status together', async function () {
        const db = makeDb([{ item_id: 1, status_id: 1 }]);
        await db.createListEdits({ ACTION_INDEX: 7, TYPE: 2 }, { addr1: 'valid', addr2: 'valid' });
        assert.deepStrictEqual(inserts(db)[0].args, [7, 2, 1]);
        assert.match(inserts(db)[0].query, /INTO list_edits/);
    });

    it('writes invalid items with their status', async function () {
        const db = makeDb();
        await db.createListItemsInvalid({ ACTION_INDEX: 7, TYPE: 2 }, { addr9: 'invalid' });
        assert.deepStrictEqual(inserts(db)[0].args, [7, 9, 2]);
        assert.match(inserts(db)[0].query, /INTO list_items_invalid/);
    });

    it('storeList uses the bulk writers instead of per-item calls', async function () {
        const db = {
            createList: sinon.stub().resolves(),
            createListEdits: sinon.stub().resolves(),
            createListItems: sinon.stub().resolves(),
            createListItemsInvalid: sinon.stub().resolves(),
            createListItem: sinon.stub().resolves(),
        };
        const ctx = {
            indexerDb: db,
            util: { addAddressTicker() {} },
            isFormatActive: () => false,
            storeShare: async () => {},
            storeTransfer: async () => {},
            settleFee: async () => {},
            mapper: { createMappings: async () => {} },
            writeListRows: listStore.writeListRows,
        };
        await listStore.storeList.call(ctx, { FORMAT: 1, SOURCE: 's' }, 'valid', { a: 'valid' }, ['a', 'b'], { c: 'x' }, 0);
        assert.strictEqual(db.createListItems.callCount, 1);
        assert.deepStrictEqual(db.createListItems.firstCall.args[1], ['a', 'b']);
        assert.strictEqual(db.createListItem.callCount, 0);
    });
});
