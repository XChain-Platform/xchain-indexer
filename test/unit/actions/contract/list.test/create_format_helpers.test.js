'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../../../fixtures/mocks');
const gateRegistry = require('../../../../../src/consensus/gate_registry.js');
const {
    SOURCE,
    ADDR1,
    ADDR2,
    makeListContext,
} = require('./helpers/list_context.js');

function storedRows(indexer){
    const db = indexer.indexerDb;
    return {
        list: db.createList.getCalls().map((call) => call.args),
        edits: db.createListEdit.getCalls().map((call) => call.args),
        items: db.createListItem.getCalls().map((call) => call.args),
        invalid: db.createListItemInvalid.getCalls().map((call) => call.args),
    };
}

function assertByteIdenticalRows(indexer, expected){
    assert.strictEqual(JSON.stringify(storedRows(indexer)), JSON.stringify(expected));
}

describe('LIST create format helpers @regression @tier3', function () {
    beforeEach(function () {
        sinon.stub(gateRegistry, 'activeAt').callsFake((key) =>
            key === 'list_union_activation.LIST_UNION_ACTIVATION'
        );
    });

    afterEach(function () {
        sinon.restore();
    });

    it('classifies create and membership-edit formats without registering format 4', function () {
        const { handler } = makeListContext();

        for(const format of [0, '0', 4, '4', null, ''])
            assert.strictEqual(handler.isCreateFormat(format), true);
        for(const format of [1, 2, 3, 5, 'nope'])
            assert.strictEqual(handler.isCreateFormat(format), false);

        for(const format of [1, '1'])
            assert.strictEqual(handler.isEditFormat(format), true);
        for(const format of [null, 0, 2, 3, 4, 5, 'nope'])
            assert.strictEqual(handler.isEditFormat(format), false);

        assert.strictEqual(handler.formats[4], undefined);
    });

    it('stores the legacy format 0 create rows byte-identically', async function () {
        const { indexer, handler } = makeListContext();
        indexer.indexerDb.isActionAllowed.resolves(true);
        const data = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE });

        await handler.parse(['0', '2', 'memo', ADDR1], data, null);

        const expectedData = Object.assign(
            createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE }),
            {
                VERSION: '0',
                TYPE: '2',
                MEMO: 'memo',
                ITEM: ADDR1,
                EDIT: null,
                LIST_ACTION_INDEX: null,
                DESTINATION: null,
                STATUS: 'valid',
            }
        );
        assertByteIdenticalRows(indexer, {
            list: [[expectedData]],
            edits: [[expectedData, ADDR1, 'valid']],
            items: [[expectedData, ADDR1]],
            invalid: [],
        });
    });

    it('stores the legacy format 1 edit rows byte-identically', async function () {
        const { indexer, handler } = makeListContext();
        indexer.indexerDb.isActionAllowed.resolves(true);
        indexer.indexerDb.getListType.resolves(2);
        indexer.indexerDb.getList.resolves([ADDR1]);
        const data = createBaseData({ ACTION: 'LIST', FORMAT: 1, SOURCE, ACTION_INDEX: 2 });

        await handler.parse(['1', '1', '5', 'memo', ADDR2], data, null);

        const expectedData = Object.assign(
            createBaseData({ ACTION: 'LIST', FORMAT: 1, SOURCE, ACTION_INDEX: 2 }),
            {
                VERSION: '1',
                EDIT: '1',
                LIST_ACTION_INDEX: '5',
                MEMO: 'memo',
                ITEM: ADDR2,
                TYPE: 2,
                DESTINATION: null,
                STATUS: 'valid',
            }
        );
        assertByteIdenticalRows(indexer, {
            list: [[expectedData]],
            edits: [[expectedData, ADDR2, 'valid']],
            items: [[expectedData, ADDR1], [expectedData, ADDR2]],
            invalid: [],
        });
    });

    it('stores the legacy union create rows byte-identically', async function () {
        const { indexer, handler } = makeListContext();
        const db = indexer.indexerDb;
        db.isActionAllowed.resolves(true);
        db.getListStoredType = sinon.stub().withArgs('10').resolves(2);
        db.getListRootIndex.withArgs('10').resolves('10');
        db.doQuery.callsFake(async (query) =>
            query.includes('FROM lists l') ? [{ valid: 1 }] : []
        );
        db.getList.resolves([ADDR1]);
        const data = createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE, ACTION_INDEX: 3 });

        await handler.parse(['0', '3', 'memo', '10'], data, null);

        const expectedData = Object.assign(
            createBaseData({ ACTION: 'LIST', FORMAT: 0, SOURCE, ACTION_INDEX: 3 }),
            {
                VERSION: '0',
                TYPE: '3',
                MEMO: 'memo',
                ITEM: '10',
                EDIT: null,
                LIST_ACTION_INDEX: null,
                DESTINATION: null,
                UNION_MEMBER_TYPE: 2,
                STATUS: 'valid',
            }
        );
        assertByteIdenticalRows(indexer, {
            list: [[expectedData]],
            edits: [[expectedData, '10', 'valid']],
            items: [[expectedData, '10']],
            invalid: [],
        });
    });
});
