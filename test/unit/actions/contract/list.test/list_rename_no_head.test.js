'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const { SOURCE, ADDR1, ADDR2, makeListContext } = require('./helpers/list_context.js');

function data(format, actionIndex){
    return createBaseData({
        ACTION: 'LIST',
        FORMAT: format,
        ACTION_INDEX: actionIndex,
        BLOCK_INDEX: actionIndex,
        SOURCE,
        TX_OUTPUTS: [],
    });
}

describe('LIST rename does not become a membership head @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('builds the edit after a rename on the preceding membership head', async function () {
        const { indexer, handler } = makeListContext();
        const db = indexer.indexerDb;
        const listRows = new Map();
        const metaRows = new Map();
        const itemRows = [];

        db.createListMeta = sinon.stub().callsFake(async (row, name, description) => {
            metaRows.set(Number(row.ACTION_INDEX), {
                root: Number(row.LIST_ACTION_INDEX),
                name,
                description,
                status: row.STATUS,
            });
        });
        db.getListMeta = sinon.stub().callsFake(async (root) => {
            const rows = [...metaRows.entries()]
                .filter(([, row]) => row.root===Number(root) && row.status==='valid')
                .sort((a, b) => b[0] - a[0]);
            return rows.length ? rows[0][1] : null;
        });
        db.createList.callsFake(async (row) => {
            listRows.set(Number(row.ACTION_INDEX), {
                root: row.LIST_ACTION_INDEX===null
                    ? Number(row.ACTION_INDEX)
                    : Number(row.LIST_ACTION_INDEX),
                type: Number(row.TYPE),
                source: row.SOURCE,
                status: row.STATUS,
                members: [],
            });
        });
        db.createListItem.callsFake(async (row, item) => {
            listRows.get(Number(row.ACTION_INDEX)).members.push(item);
            itemRows.push({ actionIndex: Number(row.ACTION_INDEX), item });
        });
        db.getListType.callsFake(async (index) => {
            const row = listRows.get(Number(index));
            return row && row.status==='valid' ? row.type : false;
        });
        db.getListRootIndex.callsFake(async (index) => {
            const row = listRows.get(Number(index));
            return row ? row.root : Number(index);
        });
        db.getListHeadIndex.callsFake(async (index) => {
            const row = listRows.get(Number(index));
            const root = row ? row.root : Number(index);
            const heads = [...listRows.entries()]
                .filter(([, candidate]) => candidate.root===root && candidate.status==='valid')
                .sort((a, b) => b[0] - a[0]);
            return heads.length ? heads[0][0] : root;
        });
        db.getList.callsFake(async (index) => {
            const head = await db.getListHeadIndex(index);
            const row = listRows.get(Number(head));
            return row ? row.members.slice() : [];
        });
        db.getListSource.callsFake(async (root) => {
            const row = listRows.get(Number(root));
            return row ? row.source : null;
        });
        db.isActionAllowed.resolves(true);
        db.doQuery.resolves([]);

        const create = data(4, 100);
        await handler.parse(['4', '2', 'Team wallets', 'Initial set', '', ADDR1], create, null);

        const firstEdit = data(1, 101);
        await handler.parse(['1', '1', '100', '', ADDR2], firstEdit, null);

        const itemCountBeforeRename = itemRows.length;
        const headBeforeRename = await db.getListHeadIndex(100);
        const rename = data(5, 102);
        await handler.parse(['5', '100', 'Operations wallets', '', 'rename'], rename, null);

        assert.strictEqual(rename.STATUS, 'valid');
        assert.strictEqual(listRows.has(102), false);
        assert.strictEqual(metaRows.has(102), true);
        assert.strictEqual(itemRows.length, itemCountBeforeRename);
        assert.strictEqual(await db.getListHeadIndex(100), headBeforeRename);
        assert.deepStrictEqual(await db.getList(100), [ADDR1, ADDR2]);

        const secondEdit = data(1, 103);
        await handler.parse(['1', '2', '100', '', ADDR1], secondEdit, null);

        assert.strictEqual(secondEdit.STATUS, 'valid');
        assert.strictEqual(await db.getListHeadIndex(100), 103);
        assert.deepStrictEqual(await db.getList(100), [ADDR2]);
        assert.deepStrictEqual(
            itemRows.filter((row) => row.actionIndex===103).map((row) => row.item),
            [ADDR2]
        );
        assert.deepStrictEqual([...listRows.keys()], [100, 101, 103]);
        assert.deepStrictEqual([...metaRows.keys()], [100, 102]);
    });
});
