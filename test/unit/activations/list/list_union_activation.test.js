'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { createBaseData } = require('../../../fixtures/mocks');
const { stubGate } = require('../../../helpers/gate_modules.js');
const {
    listItemId,
    isValidListRoot,
    getUnionMemberRoots,
    getUnionMemberType,
} = require('../../../../src/db/lists/membership.js');
const {
    SOURCE,
    ADDR1,
    ADDR2,
    makeListContext,
} = require('../../actions/contract/list.test/helpers/list_context.js');

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

function registerActivationGateTests(){
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
}

function registerCreateMemberTests(){
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
}

function registerMembershipLimitTests(){
    it('refuses a distinct merged membership of 10001 addresses', async function () {
        const ctx = setup();
        ctx.addList(10, 2, Array.from({ length: 10001 }, (_, index) => 'address-' + index));
        const data = actionData();

        await ctx.handler.parse(['0', '3', '', '10'], data, null);

        assert.strictEqual(data['STATUS'], 'invalid: ITEM (union exceeds LIST_SHARE_MAX_MEMBERS)');
        sinon.assert.notCalled(ctx.indexer.indexerDb.createListItem);
    });

    it('skips only the merged-membership cap for genesis-injected union actions', async function () {
        const ctx = setup();
        const data = actionData({ TYPE: 3, IS_GENESIS: true });

        const valid = await ctx.handler.validateUnionResult(data, 2, ['10'], 0, null);
        const noMembers = await ctx.handler.validateUnionResult(data, 0, [], 0, null);
        const tooManyMembers = await ctx.handler.validateUnionResult(
            data,
            2,
            Array.from({ length: 17 }, (_, index) => String(index+1)),
            0,
            null
        );

        assert.strictEqual(valid, null);
        assert.strictEqual(noMembers, 'invalid: ITEM (no member list)');
        assert.strictEqual(tooManyMembers, 'invalid: ITEM (union exceeds LIST_UNION_MAX_MEMBERS)');
        sinon.assert.notCalled(ctx.indexer.indexerDb.getList);
    });
}

function registerCreateValidationAndEditTests(){
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
}

function registerMembershipHelperTests(){
    it('stores type-3 ids directly and exposes root membership helpers', async function () {
        const db = {
            createTicker: sinon.stub(),
            createAddress: sinon.stub(),
            getListRootIndex: sinon.stub().callsFake(async (index) => String(index)),
            getListStoredType: sinon.stub().withArgs('10').resolves(2),
            doQuery: sinon.stub().callsFake(async (query) => {
                if(query.includes('FROM lists l')) return [{ valid: 1 }];
                return [
                    { action_index: 10, wire_data: 'LIST|0|3||10|20', list_position: 1 },
                    { action_index: 20, wire_data: 'LIST|0|3||10|20', list_position: 1 },
                ];
            }),
        };

        assert.strictEqual(await listItemId(db, 3, '10'), '10');
        assert.strictEqual(await listItemId(db, 3, 'nope'), null);
        assert.strictEqual(await isValidListRoot(db, 10), true);
        assert.deepStrictEqual(await getUnionMemberRoots(db, 100), ['10', '20']);
        assert.strictEqual(await getUnionMemberType(db, 100), 2);
        assert.match(db.doQuery.secondCall.args[0], /ORDER BY action_index ASC, item_id ASC/);
        assert.match(db.doQuery.thirdCall.args[0], /ORDER BY li\.action_index ASC, li\.item_id ASC/);
        sinon.assert.notCalled(db.createTicker);
        sinon.assert.notCalled(db.createAddress);
    });
}

function registerWireOrderTests(){
    it('derives edit member type from the root create wire order, not root index order', async function () {
        const wireRows = [
            { action_index: 10, wire_data: 'LIST|0|3||21|10', list_position: 1 },
            { action_index: 20, wire_data: 'LIST|0|3||21|10', list_position: 1 },
        ];
        const db = {
            getListRootIndex: sinon.stub().callsFake(async (index) =>
                String(index)==='21' ? '20' : String(index)
            ),
            getListStoredType: sinon.stub().callsFake(async (index) =>
                String(index)==='20' ? 1 : 2
            ),
            doQuery: sinon.stub().resolves(wireRows),
        };

        assert.strictEqual(await getUnionMemberType(db, 100), 1);
        assert.match(db.doQuery.firstCall.args[0], /ORDER BY li\.action_index ASC, li\.item_id ASC/);
        assert.deepStrictEqual(db.getListRootIndex.getCalls().map((call) => call.args[0]), ['21', '10']);
        sinon.assert.calledOnceWithExactly(db.getListStoredType, '20');
    });
}

function registerBatchSelectionTests(){
    it('selects the requested root create when a batch has matching union creates', async function () {
        const wireData = 'BATCH|0|LIST|0|3||21|10;LIST|0|3||10|21';
        const db = {
            getListRootIndex: sinon.stub().callsFake(async (index) =>
                String(index)==='21' ? '20' : String(index)
            ),
            getListStoredType: sinon.stub().callsFake(async (index) =>
                String(index)==='20' ? 1 : 2
            ),
            doQuery: sinon.stub().callsFake(async (query, args) => [
                { action_index: 10, wire_data: wireData, list_position: Number(args[0])-99 },
                { action_index: 20, wire_data: wireData, list_position: Number(args[0])-99 },
            ]),
        };

        assert.strictEqual(await getUnionMemberType(db, 100), 1);
        assert.strictEqual(await getUnionMemberType(db, 101), 2);
        assert.deepStrictEqual(db.getListStoredType.getCalls().map((call) => call.args[0]), ['20', '10']);
        assert.deepStrictEqual(db.getListRootIndex.getCalls().map((call) => call.args[0]), [
            '21', '10',
            '10', '21',
        ]);
        assert.deepStrictEqual(db.doQuery.getCalls().map((call) => call.args[1]), [[100], [101]]);
        assert.match(db.doQuery.firstCall.args[0], /prior\.source_id<=>t\.source_id/);
    });
}

describe('LIST union activation @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    registerActivationGateTests();
    registerCreateMemberTests();
    registerMembershipLimitTests();
    registerCreateValidationAndEditTests();
    registerMembershipHelperTests();
    registerWireOrderTests();
    registerBatchSelectionTests();
});
