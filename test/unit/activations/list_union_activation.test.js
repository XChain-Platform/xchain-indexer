'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { createBaseData } = require('../../fixtures/mocks');
const { stubGate } = require('../../helpers/gate_modules.js');
const {
    listItemId,
    isValidListRoot,
    getUnionMemberRoots,
    getUnionMemberType,
} = require('../../../src/db/lists/membership.js');
const {
    SOURCE,
    ADDR1,
    ADDR2,
    makeListContext,
} = require('../actions/contract/list.test/helpers/list_context.js');

const GATE_KEY = 'list_union_activation.LIST_UNION_ACTIVATION';
const UNION_ROOT = 100;

function actionData(overrides={}){
    return createBaseData(Object.assign({
        ACTION: 'LIST',
        ACTION_INDEX: 200,
        BLOCK_INDEX: 500,
        FORMAT: 0,
        SOURCE,
    }, overrides));
}

function setup(armed=true){
    const { indexer, handler } = makeListContext();
    stubGate(sinon, GATE_KEY, armed);

    const storedTypes = new Map();
    const roots = new Map();
    const validRoots = new Set();
    const unionMembers = new Map();
    const memberships = new Map();

    indexer.indexerDb.getListStoredType = sinon.stub().callsFake(async (index) =>
        storedTypes.has(String(index)) ? storedTypes.get(String(index)) : false
    );
    indexer.indexerDb.getListRootIndex.callsFake(async (index) =>
        roots.get(String(index)) || String(index)
    );
    indexer.indexerDb.getListHeadIndex.callsFake(async (index) => String(index));
    indexer.indexerDb.getList.callsFake(async (index) => memberships.get(String(index)) || []);
    indexer.indexerDb.doQuery.callsFake(async (query, args) => {
        if(query.includes('FROM lists l'))
            return validRoots.has(String(args[0])) ? [{ valid: 1 }] : [];
        if(query.includes('FROM list_items'))
            return (unionMembers.get(String(args[0])) || []).map((action_index) => ({ action_index }));
        if(query.includes('FROM list_transfers'))
            return [];
        throw new Error('unexpected query');
    });

    function addList(index, type, members=[], root=index){
        storedTypes.set(String(index), type);
        roots.set(String(index), String(root));
        validRoots.add(String(root));
        memberships.set(String(root), members);
    }

    return {
        indexer,
        handler,
        storedTypes,
        roots,
        validRoots,
        unionMembers,
        memberships,
        addList,
    };
}

describe('LIST union activation @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('keeps TYPE 3 unknown below the activation and stores only the LIST row', async function () {
        const { indexer, handler } = setup(false);
        const data = actionData();

        await handler.parse(['0', '3', '', '10'], data, null);

        assert.strictEqual(data['STATUS'], 'invalid: TYPE (unknown)');
        sinon.assert.calledOnceWithExactly(indexer.indexerDb.createList, data);
        sinon.assert.notCalled(indexer.indexerDb.createListEdit);
        sinon.assert.notCalled(indexer.indexerDb.createListItem);
        sinon.assert.notCalled(indexer.indexerDb.createListItemInvalid);
    });

    it('keeps TYPE 3 unknown without stored-type reads', async function () {
        const { indexer, handler } = setup();
        delete indexer.indexerDb.getListStoredType;
        const data = actionData();

        await handler.parse(['0', '3', '', '10'], data, null);

        assert.strictEqual(data['STATUS'], 'invalid: TYPE (unknown)');
        sinon.assert.calledOnceWithExactly(indexer.indexerDb.createList, data);
        sinon.assert.notCalled(indexer.indexerDb.createListItem);
        sinon.assert.notCalled(indexer.indexerDb.createListItemInvalid);
    });

    it('accepts local and mirror members, normalizes roots, and records bad items', async function () {
        const ctx = setup();
        ctx.addList(11, 2, [ADDR1], 10);
        ctx.addList(20, 2, [ADDR2]);
        ctx.addList(30, 3);
        ctx.addList(40, 1, ['TICK']);
        const data = actionData();

        await ctx.handler.parse(['0', '3', '', '11', '20', '99', '30', '40', 'nope'], data, null);

        assert.strictEqual(data['STATUS'], 'valid');
        assert.deepStrictEqual(ctx.indexer.indexerDb.createListItem.getCalls().map((call) => call.args[1]), ['10', '20']);
        assert.deepStrictEqual(ctx.indexer.indexerDb.createListItemInvalid.getCalls().map((call) => call.args.slice(1)), [
            ['30', 'invalid: LIST (union)'],
            ['40', 'invalid: LIST (type)'],
            ['99', 'invalid: LIST (unknown)'],
            ['nope', 'invalid: LIST (unknown)'],
        ]);
    });

    it('refuses 17 valid member lists', async function () {
        const ctx = setup();
        const members = [];
        for(let index=1; index<=17; index++){
            ctx.addList(index, 2, [ADDR1]);
            members.push(String(index));
        }
        const data = actionData();

        await ctx.handler.parse(['0', '3', '', ...members], data, null);

        assert.strictEqual(data['STATUS'], 'invalid: ITEM (union exceeds LIST_UNION_MAX_MEMBERS)');
        sinon.assert.notCalled(ctx.indexer.indexerDb.createListItem);
    });

    it('refuses a distinct merged membership of 10001 addresses', async function () {
        const ctx = setup();
        ctx.addList(10, 2, Array.from({ length: 10001 }, (_, index) => 'address-' + index));
        const data = actionData();

        await ctx.handler.parse(['0', '3', '', '10'], data, null);

        assert.strictEqual(data['STATUS'], 'invalid: ITEM (union exceeds LIST_SHARE_MAX_MEMBERS)');
        sinon.assert.notCalled(ctx.indexer.indexerDb.createListItem);
    });

    it('rejects a create with no valid member list', async function () {
        const ctx = setup();
        const data = actionData();

        await ctx.handler.parse(['0', '3', '', '999'], data, null);

        assert.strictEqual(data['STATUS'], 'invalid: ITEM (no member list)');
        sinon.assert.notCalled(ctx.indexer.indexerDb.createListItemInvalid);
    });

    it('loads union heads so edits add and remove member roots', async function () {
        const ctx = setup();
        ctx.storedTypes.set(String(UNION_ROOT), 3);
        ctx.addList(10, 2, [ADDR1]);
        ctx.addList(20, 2, [ADDR2]);
        ctx.addList(50, 2, [ADDR1, ADDR2]);
        ctx.unionMembers.set(String(UNION_ROOT), [10, 20]);
        ctx.unionMembers.set('101', [10, 20]);
        ctx.unionMembers.set('102', [10, 20, 50]);
        ctx.indexer.indexerDb.getListHeadIndex.onFirstCall().resolves(101);
        ctx.indexer.indexerDb.getListHeadIndex.onSecondCall().resolves(102);

        const add = actionData({ ACTION_INDEX: 201, FORMAT: 1 });
        await ctx.handler.parse(['1', '1', String(UNION_ROOT), '', '50'], add, null);
        const remove = actionData({ ACTION_INDEX: 202, FORMAT: 1 });
        await ctx.handler.parse(['1', '2', String(UNION_ROOT), '', '20'], remove, null);

        assert.strictEqual(add['STATUS'], 'valid');
        assert.strictEqual(remove['STATUS'], 'valid');
        assert.deepStrictEqual(ctx.indexer.indexerDb.createListItem.getCalls().map((call) => [
            call.args[0]['ACTION_INDEX'],
            call.args[1],
        ]), [
            [201, '10'], [201, '20'], [201, '50'],
            [202, '10'], [202, '50'],
        ]);
    });

    it('stores type-3 ids directly and exposes root membership helpers', async function () {
        const db = {
            createTicker: sinon.stub(),
            createAddress: sinon.stub(),
            getListStoredType: sinon.stub().withArgs('10').resolves(2),
            doQuery: sinon.stub().callsFake(async (query) => {
                if(query.includes('FROM lists l')) return [{ valid: 1 }];
                return [{ action_index: 10 }, { action_index: 20 }];
            }),
        };

        assert.strictEqual(await listItemId(db, 3, '10'), '10');
        assert.strictEqual(await listItemId(db, 3, 'nope'), null);
        assert.strictEqual(await isValidListRoot(db, 10), true);
        assert.deepStrictEqual(await getUnionMemberRoots(db, 100), ['10', '20']);
        assert.strictEqual(await getUnionMemberType(db, 100), 2);
        sinon.assert.notCalled(db.createTicker);
        sinon.assert.notCalled(db.createAddress);
    });

    it('derives edit member type from the root create wire order, not root index order', async function () {
        const wireRows = [{ action_index: 20 }, { action_index: 10 }];
        const db = {
            getListStoredType: sinon.stub().callsFake(async (index) =>
                String(index)==='20' ? 1 : 2
            ),
            doQuery: sinon.stub().callsFake(async (query) =>
                query.includes('ORDER BY item_id ASC')
                    ? wireRows.slice().sort((a, b) => a.action_index-b.action_index)
                    : wireRows
            ),
        };

        assert.strictEqual(await getUnionMemberType(db, 100), 1);
        sinon.assert.calledOnceWithExactly(db.getListStoredType, '20');
    });
});
