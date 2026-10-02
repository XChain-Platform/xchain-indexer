'use strict';

// GENERATED

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../fixtures/mocks');
const { stubGate } = require('../../helpers/gate_modules.js');
const { readUnionMembers } = require('../../../src/db/lists/union.js');
const {
    makeFormat0Params,
    makeData: makeIssueData,
    buildIssue,
} = require('../actions/token/issue.test/helpers/fixture.js');
const {
    SOURCE,
    ADDR1,
    ADDR2,
    makeListContext,
} = require('../actions/contract/list.test/helpers/list_context.js');

const META_GATE = 'list_meta_activation.LIST_META_ACTIVATION';
const REMATCH_GATE = 'list_change_rematch_activation.LIST_CHANGE_REMATCH_ACTIVATION';

function listData(format, overrides={}){
    return createBaseData({
        ACTION: 'LIST',
        FORMAT: format,
        ACTION_INDEX: 50,
        BLOCK_INDEX: 500,
        SOURCE,
        TX_OUTPUTS: [],
        ...overrides,
    });
}

function setup(armed=true){
    const context = makeListContext();
    const db = context.indexer.indexerDb;
    stubGate(sinon, META_GATE, armed);
    db.createListMeta = sinon.stub().resolves();
    db.getListMeta = sinon.stub().resolves(null);
    db.isActionAllowed.resolves(true);
    db.getListType.resolves(2);
    db.getListSource.resolves(SOURCE);
    return context;
}

async function rename(context, fields=['5', '10', 'New name', 'New description', 'memo'], overrides={}){
    const data = listData(5, overrides);
    await context.handler.parse(fields, data, null);
    return data;
}

function assertNoListRows(db){
    sinon.assert.notCalled(db.createList);
    sinon.assert.notCalled(db.createListEdit);
    sinon.assert.notCalled(db.createListItem);
    sinon.assert.notCalled(db.createListItemInvalid);
}

describe('LIST metadata activation @regression @tier2', function () {
    this.timeout(60000);

    afterEach(function () { sinon.restore(); });

    it('registers formats 4 and 5 with the one coin-keyed gate', function () {
        const { handler } = setup();

        assert.strictEqual(handler.formats[4], 'VERSION|TYPE|NAME|DESCRIPTION|MEMO|ITEM');
        assert.strictEqual(handler.formats[5], 'VERSION|LIST_ACTION_INDEX|NAME|DESCRIPTION|MEMO');
        assert.strictEqual(handler.formatGates[4], META_GATE);
        assert.strictEqual(handler.formatGates[5], META_GATE);
        assert.strictEqual(handler.itemStartIndex[4], 5);
    });

    const verdicts = [
        ['NAME pipe', 'NAME', 'bad|name', '', 4, 'invalid: NAME (pipe)'],
        ['NAME semicolon', 'NAME', 'bad;name', '', 4, 'invalid: NAME (semicolon)'],
        ['NAME length', 'NAME', 'x'.repeat(65), '', 4, 'invalid: NAME (length)'],
        ['NAME format', 'NAME', '\u200bhidden', '', 4, 'invalid: NAME (format)'],
        ['DESCRIPTION pipe', 'DESCRIPTION', '', 'bad|description', 4, 'invalid: DESCRIPTION (pipe)'],
        ['DESCRIPTION semicolon', 'DESCRIPTION', '', 'bad;description', 4, 'invalid: DESCRIPTION (semicolon)'],
        ['DESCRIPTION length', 'DESCRIPTION', '', 'x'.repeat(513), 4, 'invalid: DESCRIPTION (length)'],
        ['DESCRIPTION format', 'DESCRIPTION', '', '\u202ehidden', 4, 'invalid: DESCRIPTION (format)'],
        ['NAME no change', 'NAME', '', '', 5, 'invalid: NAME (no change)'],
    ];
    for(const [label, field, name, description, format, verdict] of verdicts){
        it('returns ' + label + ' verdict', function () {
            const { handler } = setup();
            const data = { NAME: name, DESCRIPTION: description };
            assert.strictEqual(handler.validateMeta(data, format, null), verdict, field);
        });
    }

    it('keeps an empty field unchanged and resolves a clear sentinel to null', async function () {
        const context = setup();
        const db = context.indexer.indexerDb;
        db.getListMeta.resolves({ name: 'Old name', description: 'Old description' });

        const data = await rename(context, ['5', '10', '', '-', 'memo']);

        assert.strictEqual(data.STATUS, 'valid');
        sinon.assert.calledOnceWithExactly(db.getListMeta, '10', 500);
        sinon.assert.calledOnceWithExactly(db.createListMeta, data, 'Old name', null);
        assertNoListRows(db);
    });

    it('uses the transferred owner for a rename', async function () {
        const context = setup();
        const db = context.indexer.indexerDb;
        db.getListRootIndex.withArgs('12').resolves(10);
        db.doQuery.callsFake(async (query) =>
            query.includes('FROM list_transfers') ? [{ address: ADDR1 }] : []
        );

        const accepted = await rename(
            context, ['5', '12', 'Transferred', '', ''], { SOURCE: ADDR1 }
        );
        const refused = await rename(
            context, ['5', '12', 'Old owner', '', ''], { SOURCE, ACTION_INDEX: 51 }
        );

        assert.strictEqual(accepted.STATUS, 'valid');
        assert.strictEqual(refused.STATUS, 'invalid: LIST_ACTION_INDEX (not owner)');
    });

    it('refuses a broadcast rename of a bridge-owned mirror before field checks', async function () {
        const context = setup();
        const db = context.indexer.indexerDb;
        const bridge = context.handler.config.ADDRESS.BRIDGE_BTC || ADDR2;
        context.handler.config.ADDRESS.BRIDGE_BTC = bridge;
        db.getListSource.resolves(bridge);

        const data = await rename(context, ['5', '10', '', '', '']);

        assert.strictEqual(data.STATUS, 'invalid: LIST_ACTION_INDEX (bridge-owned)');
        sinon.assert.calledOnceWithExactly(db.createListMeta, data, null, null);
        assertNoListRows(db);
    });

    it('exempts an injected metadata leg from owner and mirror checks', async function () {
        const context = setup();
        const db = context.indexer.indexerDb;
        context.handler.config.ADDRESS.BRIDGE_BTC = ADDR2;
        db.getListSource.resolves(ADDR2);

        const data = await rename(
            context, ['5', '10', 'Mirror name', '', ''], { IS_GENESIS: true }
        );

        assert.strictEqual(data.STATUS, 'valid');
        sinon.assert.notCalled(db.getListSource);
        sinon.assert.calledOnceWithExactly(db.createListMeta, data, 'Mirror name', null);
        assertNoListRows(db);
    });

    it('creates a named union through the existing create and result path', async function () {
        const context = setup();
        const db = context.indexer.indexerDb;
        db.getListStoredType = sinon.stub().withArgs('10').resolves(2);
        db.getListRootIndex.withArgs('10').resolves('10');
        db.getList.resolves([ADDR1]);
        db.doQuery.callsFake(async (query) => {
            if(query.includes('FROM lists l')) return [{ valid: 1 }];
            return [];
        });
        const data = listData(4);

        await context.handler.parse(['4', '3', 'Named union', 'Description', '', '10'], data, null);

        assert.strictEqual(data.STATUS, 'valid');
        sinon.assert.calledOnceWithExactly(db.createList, data);
        sinon.assert.calledOnceWithExactly(
            db.createListMeta,
            sinon.match({ ACTION_INDEX: 50, LIST_ACTION_INDEX: 50 }),
            'Named union',
            'Description'
        );
    });

    it('rematches a metadata address-list create by its root and excludes metadata edits', async function () {
        const context = setup();
        const db = context.indexer.indexerDb;
        const roots = [];
        stubGate(sinon, REMATCH_GATE, true);
        db.doQuery.callsFake(async (query, args) => {
            if(/FROM\s+lists\s+WHERE list_action_index/.test(query))
                roots.push(args[0]);
            return [];
        });

        const create = listData(4, { ACTION_INDEX: 57 });
        await context.handler.parse(
            ['4', '2', 'Named addresses', 'Description', '', ADDR1], create, null
        );

        assert.strictEqual(create.STATUS, 'valid');
        assert.deepStrictEqual(roots, [57, 57]);

        roots.length = 0;
        db.doQuery.resetHistory();
        const edit = await rename(context, ['5', '57', 'Renamed', '', '']);

        assert.strictEqual(edit.STATUS, 'valid');
        assert.deepStrictEqual(roots, []);
        assert.strictEqual(db.doQuery.getCalls().some((call) =>
            /FROM\s+(orders|swaps)\s/.test(String(call.args[0]))
        ), false);
    });

    it('prices a shared-list rename at the base with zero items', async function () {
        const context = setup();
        const db = context.indexer.indexerDb;
        db.doQuery.resolves([{ shared: 1 }]);
        db.getAddressBalances.resolves({ 1: '10' });

        const result = await context.handler.chargeFee(listData(5, {
            LIST_ACTION_INDEX: 10,
        }), 5, 999, null);

        assert.strictEqual(result.error, null);
        assert.strictEqual(result.fees.GAS_COST.toString(), '5000');
        assert.strictEqual(result.fees.AMOUNT.toFixed(8), '0.05000000');
    });

    it('keeps a local-list rename free', async function () {
        const context = setup();
        const db = context.indexer.indexerDb;
        db.doQuery.resolves([]);

        const result = await context.handler.chargeFee(
            listData(5, { LIST_ACTION_INDEX: 10 }), 5, 0, null
        );

        assert.deepStrictEqual(result, { error: null, fees: null });
        sinon.assert.notCalled(db.getAddressBalances);
    });

    it('stores renames only in list_metas and keeps them invisible to a containing union', async function () {
        const context = setup();
        const db = context.indexer.indexerDb;
        const listRows = new Map([
            ['10', { root: '10', status: 'valid' }],
            ['20', { root: '20', status: 'valid' }],
        ]);
        const listItems = new Map([
            ['10', [ADDR1]],
            ['20', ['10']],
        ]);
        db.createList.callsFake(async (row) => {
            const index = String(row.ACTION_INDEX);
            listRows.set(index, {
                root: row.LIST_ACTION_INDEX===null
                    ? index
                    : String(row.LIST_ACTION_INDEX),
                status: row.STATUS,
            });
            listItems.set(index, []);
        });
        db.createListItem.callsFake(async (row, item) => {
            listItems.get(String(row.ACTION_INDEX)).push(item);
        });
        db.getListHeadIndex.callsFake(async (index) => {
            const stored = listRows.get(String(index));
            const root = stored ? stored.root : String(index);
            const heads = [...listRows.entries()]
                .filter(([, row]) => row.root===root && row.status==='valid')
                .sort((left, right) => Number(right[0])-Number(left[0]));
            return heads.length ? heads[0][0] : root;
        });
        db.getList.callsFake(async (index) => {
            const head = await db.getListHeadIndex(index);
            return (listItems.get(String(head)) || []).slice();
        });
        db.doQuery.callsFake(async (query, args) => {
            if(query.includes('FROM list_items'))
                return (listItems.get(String(args[0])) || [])
                    .map((action_index) => ({ action_index }));
            return [];
        });

        const unionBefore = await readUnionMembers(db, 20, 500, false);
        const headBefore = await db.getListHeadIndex(10);
        const itemCountBefore = [...listItems.values()]
            .reduce((count, items) => count+items.length, 0);
        db.getList.resetHistory();

        const valid = await rename(context);
        const invalid = await rename(
            context, ['5', '10', '', '', ''], { ACTION_INDEX: 51 }
        );

        assert.strictEqual(valid.STATUS, 'valid');
        assert.strictEqual(invalid.STATUS, 'invalid: NAME (no change)');
        assert.strictEqual(db.createListMeta.callCount, 2);
        sinon.assert.calledWithExactly(db.createListMeta, valid, 'New name', 'New description');
        sinon.assert.calledWithExactly(db.createListMeta, invalid, null, null);
        sinon.assert.notCalled(db.getList);
        assert.strictEqual(
            [...listItems.values()].reduce((count, items) => count+items.length, 0),
            itemCountBefore
        );
        assert.deepStrictEqual(listItems.get('20'), ['10']);
        assert.deepStrictEqual(await readUnionMembers(db, 20, 500, false), unionBefore);
        assert.strictEqual(await db.getListHeadIndex(10), headBefore);
        assertNoListRows(db);
    });

    it('treats a rename index as unknown to LIST and token consumers', async function () {
        const context = setup();
        const db = context.indexer.indexerDb;
        const listRows = new Map([['10', 2]]);
        db.createList.callsFake(async (row) => {
            listRows.set(String(row.ACTION_INDEX), Number(row.TYPE));
        });
        db.getListType.callsFake(async (index) => listRows.get(String(index)) || false);

        const renamed = await rename(context, ['5', '10', 'New name', '', '']);
        const edit = listData(1, { ACTION_INDEX: 51 });
        await context.handler.parse(['1', '1', '50', '', ADDR1], edit, null);

        const item = await context.handler.checkUnionItem('50', listData(0));
        const issueContext = buildIssue();
        issueContext.indexer.indexerDb.isValidList.callsFake(async (index, type) =>
            listRows.get(String(index))===Number(type)
        );
        const issue = makeIssueData({ BLOCK_INDEX: 100 });
        await issueContext.handler.parse(
            makeFormat0Params({ TICK: 'RENAMED', ALLOW_LIST: '50' }), issue, null
        );

        assert.strictEqual(renamed.STATUS, 'valid');
        assert.strictEqual(listRows.has('50'), false);
        assert.strictEqual(edit.STATUS, 'invalid: LIST_ACTION_INDEX (unknown)');
        assert.deepStrictEqual(item, { item: '50', status: 'invalid: LIST (unknown)' });
        assert.strictEqual(issue.STATUS, 'invalid: ALLOW_LIST (bad list)');
        sinon.assert.calledWithExactly(
            issueContext.indexer.indexerDb.isValidList, '50', 2, 100
        );
    });

    for(const format of [4, 5]){
        it('keeps format ' + format + ' unknown below the gate with legacy LIST storage', async function () {
            const context = setup(false);
            const db = context.indexer.indexerDb;
            const data = listData(format);
            const params = format===4
                ? ['4', '2', 'Name', 'Description', '', ADDR1]
                : ['5', '10', 'Name', 'Description', ''];

            await context.handler.parse(params, data, null);

            assert.strictEqual(data.STATUS, 'invalid: VERSION (unknown)');
            sinon.assert.calledOnceWithExactly(db.createList, data);
            sinon.assert.notCalled(db.createListMeta);
        });
    }
});
