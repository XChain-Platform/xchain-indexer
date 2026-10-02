'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const { createBaseData } = require('../../fixtures/mocks');
const { stubGate } = require('../../helpers/gate_modules.js');
const {
    SOURCE,
    ADDR1,
    ADDR2,
    makeListContext,
} = require('../actions/contract/list.test/helpers/list_context.js');

const META_GATE = 'list_meta_activation.LIST_META_ACTIVATION';

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

    it('stores valid and invalid renames only in list_metas and does not load members', async function () {
        const context = setup();
        const db = context.indexer.indexerDb;

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
        assertNoListRows(db);
    });

    it('treats a rename index as unknown to a later LIST edit and union item', async function () {
        const context = setup();
        const db = context.indexer.indexerDb;
        db.getListType.callsFake(async (index) => String(index)==='10' ? 2 : false);

        const renamed = await rename(context, ['5', '10', 'New name', '', '']);
        const edit = listData(1, { ACTION_INDEX: 51 });
        await context.handler.parse(['1', '1', '50', '', ADDR1], edit, null);

        const item = await context.handler.checkUnionItem('50', listData(0));

        assert.strictEqual(renamed.STATUS, 'valid');
        assert.strictEqual(edit.STATUS, 'invalid: LIST_ACTION_INDEX (unknown)');
        assert.deepStrictEqual(item, { item: '50', status: 'invalid: LIST (unknown)' });
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
