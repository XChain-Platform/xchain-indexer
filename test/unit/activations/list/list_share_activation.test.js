'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { createBaseData } = require('../../../fixtures/mocks');
const { stubGate } = require('../../../helpers/gate_modules.js');
const {
    SOURCE,
    ADDR1,
    ADDR2,
    makeListContext,
} = require('../../actions/contract/list.test/helpers/list_context.js');

const SHARE_GATE = 'list_share_activation.LIST_SHARE_ACTIVATION';
const OWNER_GATE = 'list_owner_activation.LIST_OWNER_ACTIVATION';
const REMATCH_GATE = 'list_change_rematch_activation.LIST_CHANGE_REMATCH_ACTIVATION';
const LIST_ROOT = 50;
const SHARE_INDEX = 90;
const MEMBER_LIMIT = 10000;

// No shared-list read (isListShared, getSharedLists: the format 2 query) may run. The
// transfer-aware owner lookup reads list_transfers through the same doQuery, so the
// guard names the shared read rather than refusing every query.
// The list already carries a valid SHARE: the format 2 read answers one row, and the
// transfer-aware owner lookup finds no transfer, so ownership falls back to the source.
function sharedListRow(db){
    db.doQuery.callsFake(async sql => (/list_transfers/.test(String(sql)) ? [] : [{}]));
}

function assertNoSharedRead(db){
    const shared = db.doQuery.getCalls().filter(call => /action_format=2/.test(String(call.args[0])));
    assert.strictEqual(shared.length, 0, 'a shared-list read ran: ' + shared.map(call => call.args[0]).join('; '));
}

function members(count){
    return Array.from({ length: count }, (_, index) => 'member-' + index);
}

function setup(armed, list = [ADDR1], type = 2){
    const { indexer, handler } = makeListContext();
    const shareGate = stubGate(sinon, SHARE_GATE, armed);
    stubGate(sinon, REMATCH_GATE, false);
    indexer.indexerDb.getListType.resolves(type);
    indexer.indexerDb.getList.resolves(list);
    indexer.indexerDb.getListRootIndex.resolves(LIST_ROOT);
    indexer.indexerDb.getListSource.withArgs(LIST_ROOT).resolves(SOURCE);
    indexer.indexerDb.getAddressBalances.resolves({ 1: '1' });
    return { indexer, handler, shareGate };
}

function actionData(format, overrides = {}){
    return createBaseData({
        ACTION: 'LIST',
        ACTION_INDEX: format == 2 ? SHARE_INDEX : SHARE_INDEX + 1,
        BLOCK_INDEX: 200,
        FORMAT: format,
        SOURCE,
        ...overrides,
    });
}

async function share(handler, overrides = {}){
    const data = actionData(2, overrides);
    await handler.parse(['2', String(LIST_ROOT), 'shared'], data, null);
    return data;
}

async function add(handler, overrides = {}){
    const data = actionData(1, overrides);
    await handler.parse(['1', '1', String(LIST_ROOT), '', ADDR2], data, null);
    return data;
}

describe('LIST share activation @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('declares format 2 behind the LIST share gate', function () {
        const { handler } = setup(false);
        assert.deepStrictEqual(handler.shareFormat(), {
            format: 2,
            fields: 'VERSION|LIST_ACTION_INDEX|MEMO',
            gate: SHARE_GATE,
        });
    });

    it('keeps format 2 byte-identically unknown below the gate without parsing it', async function () {
        const { indexer, handler, shareGate } = setup(false);
        const parseParams = sinon.spy(indexer.util, 'setActionParams');

        const data = await share(handler);

        assert.strictEqual(data.STATUS, 'invalid: VERSION (unknown)');
        sinon.assert.notCalled(parseParams);
        sinon.assert.notCalled(indexer.indexerDb.getListType);
        sinon.assert.notCalled(indexer.indexerDb.getList);
        assertNoSharedRead(indexer.indexerDb);
        assert.strictEqual(shareGate.calledWith('regtest', 'BTC', 200, null), true);
    });

    it('does not read or enforce the shared-edit cap below the gate', async function () {
        const list = members(MEMBER_LIMIT);
        const { indexer, handler } = setup(false, list);
        sharedListRow(indexer.indexerDb);
        sinon.stub(handler, 'storeList').resolves();

        const data = await add(handler);

        assert.strictEqual(list.length, MEMBER_LIMIT + 1);
        assert.strictEqual(data.STATUS, 'valid');
        assertNoSharedRead(indexer.indexerDb);
    });

    it('accepts the owner SHARE and snapshots every current member at the SHARE index', async function () {
        const list = [ADDR1, ADDR2];
        const { indexer, handler, shareGate } = setup(true, list);
        indexer.indexerDb.doQuery.resolves([]);

        const data = await share(handler);

        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(data.ACTION_INDEX, SHARE_INDEX);
        sinon.assert.calledWithExactly(indexer.indexerDb.getListSource, LIST_ROOT);
        sinon.assert.callCount(indexer.indexerDb.createListItem, list.length);
        for(const member of list)
            sinon.assert.calledOnceWithExactly(indexer.indexerDb.createListItem.withArgs(data, member), data, member);
        assert.strictEqual(shareGate.calledWith('regtest', 'BTC', 200, null), true);
        sinon.assert.neverCalledWith(shareGate.stub, OWNER_GATE);
    });

    it('refuses a stranger before reading whether the list is already shared', async function () {
        const { indexer, handler } = setup(true);

        const data = await share(handler, { SOURCE: ADDR2 });

        assert.strictEqual(data.STATUS, 'invalid: LIST_ACTION_INDEX (not owner)');
        assertNoSharedRead(indexer.indexerDb);
        sinon.assert.notCalled(indexer.indexerDb.createListItem);
    });

    it('refuses a union before reading whether the list is already shared', async function () {
        const { indexer, handler } = setup(true, [], 3);

        const data = await share(handler);

        assert.strictEqual(data.STATUS, 'invalid: LIST_ACTION_INDEX (type)');
        assertNoSharedRead(indexer.indexerDb);
    });

    it('refuses a second SHARE', async function () {
        const { indexer, handler } = setup(true);
        sharedListRow(indexer.indexerDb);

        const data = await share(handler);

        assert.strictEqual(data.STATUS, 'invalid: LIST_ACTION_INDEX (already shared)');
        sinon.assert.notCalled(indexer.indexerDb.createListItem);
    });

    it('refuses 10001 members and accepts exactly 10000', async function () {
        const over = setup(true, members(MEMBER_LIMIT + 1));
        over.indexer.indexerDb.doQuery.resolves([]);
        sinon.stub(over.handler, 'storeList').resolves();
        const rejected = await share(over.handler);
        assert.strictEqual(rejected.STATUS,
            'invalid: LIST_ACTION_INDEX (list exceeds LIST_SHARE_MAX_MEMBERS)');

        sinon.restore();
        const exact = setup(true, members(MEMBER_LIMIT));
        exact.indexer.indexerDb.doQuery.resolves([]);
        sinon.stub(exact.handler, 'storeList').resolves();
        const accepted = await share(exact.handler);
        assert.strictEqual(accepted.STATUS, 'valid');
    });

    it('refuses an ADD past the cap only after the list has been shared', async function () {
        const sharedList = members(MEMBER_LIMIT);
        const shared = setup(true, sharedList);
        sharedListRow(shared.indexer.indexerDb);
        sinon.stub(shared.handler, 'storeList').resolves();
        const rejected = await add(shared.handler);
        assert.strictEqual(sharedList.length, MEMBER_LIMIT + 1);
        assert.strictEqual(rejected.STATUS,
            'invalid: ITEM (shared list exceeds LIST_SHARE_MAX_MEMBERS)');

        sinon.restore();
        const localList = members(MEMBER_LIMIT);
        const local = setup(true, localList);
        local.indexer.indexerDb.doQuery.resolves([]);
        sinon.stub(local.handler, 'storeList').resolves();
        const accepted = await add(local.handler);
        assert.strictEqual(localList.length, MEMBER_LIMIT + 1);
        assert.strictEqual(accepted.STATUS, 'valid');
    });

    it('does not apply SHARE validation or the edit cap to genesis-injected mirror legs', async function () {
        const mirror = setup(true, members(MEMBER_LIMIT + 1), 3);
        mirror.indexer.indexerDb.getListSource.resolves(ADDR2);
        sharedListRow(mirror.indexer.indexerDb);
        sinon.stub(mirror.handler, 'storeList').resolves();
        const shared = await share(mirror.handler, { IS_GENESIS: true });
        assert.strictEqual(shared.STATUS, 'valid');
        sinon.assert.notCalled(mirror.indexer.indexerDb.getListSource);
        assertNoSharedRead(mirror.indexer.indexerDb);

        sinon.restore();
        const edit = setup(true, members(MEMBER_LIMIT));
        sharedListRow(edit.indexer.indexerDb);
        sinon.stub(edit.handler, 'storeList').resolves();
        const added = await add(edit.handler, { IS_GENESIS: true });
        assert.strictEqual(added.STATUS, 'valid');
        assertNoSharedRead(edit.indexer.indexerDb);
    });
});
