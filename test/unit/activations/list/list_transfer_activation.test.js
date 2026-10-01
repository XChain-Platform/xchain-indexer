'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');
const gateRegistry = require('../../../../src/consensus/gate_registry');
const transferPart = require('../../../../src/actions/list/transfer.js');
const { createBaseData } = require('../../../fixtures/mocks');
const {
    SOURCE,
    ADDR1,
    ADDR2,
    makeListContext,
} = require('../../actions/contract/list.test/helpers/list_context.js');

const GATE = 'list_transfer_activation.LIST_TRANSFER_ACTIVATION';
const ROOT = 5;
const MEMBERS = [
    'mjABpAzADYkYFqTmXk8Vg6vQjSQjFJf5Ds',
    'moiBTJyJviFt1HCDnfPFpxB6b3VQyW9HVB',
];
const STRANGER = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

function listData(format, source, actionIndex){
    return createBaseData({
        ACTION: 'LIST',
        FORMAT: format,
        SOURCE: source,
        ACTION_INDEX: actionIndex,
    });
}

function configureList(indexer){
    const db = indexer.indexerDb;
    const owners = [];
    const addresses = new Map();

    db.getListStoredType = sinon.stub().resolves(2);
    db.getList.callsFake(async () => MEMBERS.slice());
    db.getListRootIndex.resolves(ROOT);
    db.getListSource.withArgs(ROOT).resolves(SOURCE);
    db.createAddress.callsFake(async address => {
        if(!addresses.has(address)) addresses.set(address, addresses.size + 1);
        return addresses.get(address);
    });
    db.doQuery.callsFake(async (sql, args) => {
        if(sql.includes('SELECT a.address') && sql.includes('FROM list_transfers'))
            return owners.length ? [{ address: owners[owners.length - 1] }] : [];
        if(sql.includes('INSERT INTO list_transfers')){
            for(const [address, id] of addresses)
                if(id === args[2]) owners.push(address);
            return { affectedRows: 1 };
        }
        return [];
    });

    return owners;
}

function transferInserts(db){
    return db.doQuery.getCalls().filter(call => call.args[0].includes('INSERT INTO list_transfers'));
}

describe('LIST transfer activation @regression @tier1', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('declares format 3 behind the transfer height gate', function () {
        assert.deepStrictEqual(transferPart.transferFormat(), {
            format: 3,
            fields: 'VERSION|LIST_ACTION_INDEX|DESTINATION|MEMO',
            gate: GATE,
        });
    });

    it('keeps format 3 unknown below the gate and never reads list_transfers', async function () {
        const { indexer, handler } = makeListContext();
        handler.config['NETWORK'] = 'mainnet';
        handler.config['COIN'] = 'LTC';
        indexer.indexerDb.getListSource.withArgs(ROOT).resolves(SOURCE);
        const activeAt = sinon.spy(gateRegistry, 'activeAt');
        const data = listData(3, SOURCE, 10);

        await handler.parse(['3', String(ROOT), ADDR1, ''], data, null);

        assert.strictEqual(data['STATUS'], 'invalid: VERSION (unknown)');
        sinon.assert.notCalled(indexer.indexerDb.resolveAddressRefChecked);
        assert.strictEqual(transferInserts(indexer.indexerDb).length, 0);

        assert.strictEqual(await handler.listOwner(ROOT, data), SOURCE);
        sinon.assert.calledWithExactly(activeAt, GATE, 'mainnet', 'LTC', data['BLOCK_INDEX'], null);
        sinon.assert.calledOnceWithExactly(indexer.indexerDb.getListSource, ROOT);
        assert.strictEqual(indexer.indexerDb.doQuery.callCount, 0,
            'below-gate owner resolution must not read list_transfers');
    });

    it('transfers a shared list, follows caret destinations, and changes edit authority', async function () {
        const { indexer, handler } = makeListContext();
        const owners = configureList(indexer);
        indexer.indexerDb.resolveAddressRefChecked.callsFake(async value => ({
            value: value === '^77' ? ADDR2 : value,
            rejected: false,
        }));

        const first = listData(3, SOURCE, 10);
        await handler.parse(['3', String(ROOT), ADDR1, 'first'], first, null);

        assert.strictEqual(first['STATUS'], 'valid');
        assert.deepStrictEqual(owners, [ADDR1]);
        sinon.assert.calledWithExactly(indexer.indexerDb.resolveAddressRefChecked, ADDR1, first['BLOCK_INDEX']);
        sinon.assert.calledWithExactly(indexer.indexerDb.createListItem, first, MEMBERS[0]);
        sinon.assert.calledWithExactly(indexer.indexerDb.createListItem, first, MEMBERS[1]);
        assert.strictEqual(indexer.indexerDb.createListItem.callCount, MEMBERS.length,
            'the transfer writes every current shared-list member under its own action');
        assert.strictEqual(transferInserts(indexer.indexerDb).length, 1);

        const newOwnerEdit = listData(1, ADDR1, 11);
        await handler.parse(['1', '1', String(ROOT), '', ADDR1], newOwnerEdit, null);
        assert.strictEqual(newOwnerEdit['STATUS'], 'valid');

        const oldOwnerEdit = listData(1, SOURCE, 12);
        await handler.parse(['1', '1', String(ROOT), '', ADDR1], oldOwnerEdit, null);
        assert.strictEqual(oldOwnerEdit['STATUS'], 'invalid: LIST_ACTION_INDEX (not owner)');

        indexer.indexerDb.createListItem.resetHistory();
        const second = listData(3, ADDR1, 13);
        await handler.parse(['3', String(ROOT), '^77', 'second'], second, null);

        assert.strictEqual(second['STATUS'], 'valid');
        assert.strictEqual(second['DESTINATION'], ADDR2);
        assert.deepStrictEqual(owners, [ADDR1, ADDR2]);
        sinon.assert.calledWithExactly(indexer.indexerDb.resolveAddressRefChecked, '^77', second['BLOCK_INDEX']);
        sinon.assert.calledWithExactly(indexer.indexerDb.createListItem, second, MEMBERS[0]);
        sinon.assert.calledWithExactly(indexer.indexerDb.createListItem, second, MEMBERS[1]);
        assert.strictEqual(indexer.indexerDb.createListItem.callCount, MEMBERS.length);
        assert.strictEqual(transferInserts(indexer.indexerDb).length, 2);
        assert.strictEqual(indexer.indexerDb.doQuery.getCalls().some(call => /delete/i.test(call.args[0])), false,
            'ownership transfer must not delete the share row');

        const refused = listData(3, STRANGER, 14);
        await handler.parse(['3', String(ROOT), SOURCE, 'refused'], refused, null);
        assert.strictEqual(refused['STATUS'], 'invalid: LIST_ACTION_INDEX (not owner)');
        assert.strictEqual(transferInserts(indexer.indexerDb).length, 2,
            'a refused transfer must not be stored');

        const malformed = listData(3, ADDR2, 15);
        await handler.parse(['3', String(ROOT), 'not-an-address', 'bad'], malformed, null);
        assert.strictEqual(malformed['STATUS'], 'invalid: DESTINATION (format)');
        assert.strictEqual(transferInserts(indexer.indexerDb).length, 2,
            'a malformed transfer must not be stored');

        const missing = listData(3, ADDR2, 16);
        await handler.parse(['3', String(ROOT), '', 'missing'], missing, null);
        assert.strictEqual(missing['STATUS'], 'invalid: DESTINATION (format)');
        assert.strictEqual(transferInserts(indexer.indexerDb).length, 2,
            'a null destination must not be stored');
    });

    it('rejects an unresolvable caret destination before address validation', async function () {
        const { indexer, handler } = makeListContext();
        configureList(indexer);
        indexer.indexerDb.resolveAddressRefChecked.resolves({ value: '^999', rejected: true });
        const data = listData(3, SOURCE, 20);

        await handler.parse(['3', String(ROOT), '^999', ''], data, null);

        assert.strictEqual(data['STATUS'], 'invalid: DESTINATION (unresolvable ^id)');
        assert.strictEqual(transferInserts(indexer.indexerDb).length, 0);
    });
});
