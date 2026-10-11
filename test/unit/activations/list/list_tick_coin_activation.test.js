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
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const { stubGate } = require('../../../helpers/gate_modules.js');
const {
    SOURCE, makeListContext,
} = require('../../actions/contract/list.test/helpers/list_context.js');

const GATE_KEY = 'list_tick_coin_activation.LIST_TICK_COIN_ACTIVATION';

function setup(armed){
    const { indexer, handler } = makeListContext();
    const gate = stubGate(sinon, GATE_KEY, armed);
    indexer.indexerDb.isActionAllowed.resolves(true);
    return { indexer, handler, gate };
}

function listData(format, extra = {}){
    return createBaseData(Object.assign({
        ACTION: 'LIST', ACTION_INDEX: 80, BLOCK_INDEX: 200, FORMAT: format, SOURCE,
    }, extra));
}

function storedItems(indexer){
    return indexer.indexerDb.createListItem.getCalls().map((call) => call.args[1]);
}

function invalidItems(indexer){
    return indexer.indexerDb.createListItemInvalid.getCalls().map((call) => [
        call.args[1], call.args[2],
    ]);
}

function editItems(indexer){
    return indexer.indexerDb.createListEdit.getCalls().map((call) => [
        call.args[1], call.args[2],
    ]);
}

async function createTickList(handler, data, items){
    await handler.parse(['0', '1', '', ...items], data, null);
}

function registerLegacyAndForeignItemTests(){
    it('keeps qualified items on the literal legacy lookup path below the gate', async function () {
        const { indexer, handler, gate } = setup(false);
        for(const method of ['createListEdit', 'createListItemInvalid'])
            indexer.indexerDb[method].callsFake(async (data, item) => indexer.indexerDb.createTicker(item));
        const data = listData(0);

        await createTickList(handler, data, ['DOGE:PEPE', 'BTC:FOO']);

        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(gate.calledWith('regtest', 'BTC', 200, null), true);
        assert.deepStrictEqual(indexer.indexerDb.getTokenInfo.getCalls().map((call) => call.args[0]), [
            'DOGE:PEPE', 'BTC:FOO',
        ]);
        assert.deepStrictEqual(invalidItems(indexer), [
            ['DOGE:PEPE', 'invalid: TICK (unknown)'],
            ['BTC:FOO', 'invalid: TICK (unknown)'],
        ]);
        assert.strictEqual(indexer.indexerDb.createTicker.calledWith('DOGE:PEPE'), true);
        assert.strictEqual(indexer.indexerDb.createTicker.calledWith('BTC:FOO'), true);
    });

    it('stores foreign qualified items canonically without token lookup when armed', async function () {
        const { indexer, handler } = setup(true);
        const data = listData(0);

        await createTickList(handler, data, ['DOGE:PEPE', 'doge:^12']);

        assert.strictEqual(data.STATUS, 'valid');
        assert.deepStrictEqual(storedItems(indexer), ['DOGE:PEPE', 'DOGE:^12']);
        assert.deepStrictEqual(editItems(indexer), [
            ['DOGE:PEPE', 'valid'],
            ['DOGE:^12', 'valid'],
        ]);
        sinon.assert.notCalled(indexer.indexerDb.getTokenInfo);
    });
}

function registerOwnCoinLookupTests(){
    it('looks up and stores the rest of an own-coin name', async function () {
        const { indexer, handler } = setup(true);
        indexer.indexerDb.getTokenInfo.withArgs('FOO').resolves(createTokenInfo({ TICK: 'FOO' }));
        const data = listData(0);

        await createTickList(handler, data, ['BTC:FOO']);

        assert.strictEqual(data.STATUS, 'valid');
        sinon.assert.calledOnceWithExactly(indexer.indexerDb.getTokenInfo, 'FOO');
        assert.deepStrictEqual(storedItems(indexer), ['FOO']);
        assert.deepStrictEqual(editItems(indexer), [['FOO', 'valid']]);
    });

    it('reports an unknown own-coin name under its local rest', async function () {
        const { indexer, handler } = setup(true);
        const data = listData(0);

        await createTickList(handler, data, ['BTC:FOO']);

        assert.strictEqual(data.STATUS, 'valid');
        sinon.assert.calledOnceWithExactly(indexer.indexerDb.getTokenInfo, 'FOO');
        assert.deepStrictEqual(invalidItems(indexer), [['FOO', 'invalid: TICK (unknown)']]);
    });

    it('resolves an own-coin id through the legacy ticker lookup', async function () {
        const { indexer, handler } = setup(true);
        indexer.indexerDb.getTokenInfo.withArgs('^5').resolves(createTokenInfo({ TICK_ID: 5 }));
        const data = listData(0);

        await createTickList(handler, data, ['BTC:^5']);

        assert.strictEqual(data.STATUS, 'valid');
        sinon.assert.calledOnceWithExactly(indexer.indexerDb.getTokenInfo, '^5');
        assert.deepStrictEqual(storedItems(indexer), ['^5']);
    });
}

function registerQualifiedItemValidationTests(){
    it('rejects malformed qualified items under their written keys', async function () {
        const { indexer, handler } = setup(true);
        const data = listData(0);

        await createTickList(handler, data, ['DOGE:^012']);

        assert.strictEqual(data.STATUS, 'valid');
        assert.deepStrictEqual(invalidItems(indexer), [['DOGE:^012', 'invalid: TICK (format)']]);
        sinon.assert.notCalled(indexer.indexerDb.getTokenInfo);
    });

    it('leaves non-qualified colon forms on the legacy lookup path', async function () {
        const { indexer, handler } = setup(true);
        indexer.indexerDb.getTokenInfo.resolves(createTokenInfo());
        const data = listData(0);

        await createTickList(handler, data, ['FOO:BAR', ':PEPE']);

        assert.strictEqual(data.STATUS, 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getTokenInfo.getCalls().map((call) => call.args[0]), [
            'FOO:BAR', ':PEPE',
        ]);
        assert.deepStrictEqual(storedItems(indexer), ['FOO:BAR', ':PEPE']);
    });
}

function registerMembershipTests(){
    it('removes an own-coin qualified name from its local membership key', async function () {
        const { indexer, handler } = setup(true);
        indexer.indexerDb.getListType.resolves(1);
        indexer.indexerDb.getList.resolves(['FOO', 'BAR']);
        indexer.indexerDb.getTokenInfo.withArgs('FOO').resolves(createTokenInfo({ TICK: 'FOO' }));
        const data = listData(1);

        await handler.parse(['1', '2', '5', '', 'BTC:FOO'], data, null);

        assert.strictEqual(data.STATUS, 'valid');
        assert.deepStrictEqual(editItems(indexer), [['FOO', 'valid']]);
        assert.deepStrictEqual(storedItems(indexer), ['BAR']);
    });

    it('stores every qualified mirror member as written without validation lookup', async function () {
        const { indexer, handler } = setup(true);
        const bridge = handler.config['ADDRESS']['BRIDGE_DOGE'];
        const data = listData(0, { IS_GENESIS: true, SOURCE: bridge });

        await createTickList(handler, data, ['BTC:NOPE', 'DOGE:PEPE']);

        assert.strictEqual(data.STATUS, 'valid');
        assert.deepStrictEqual(storedItems(indexer), ['BTC:NOPE', 'DOGE:PEPE']);
        assert.deepStrictEqual(editItems(indexer), [
            ['BTC:NOPE', 'valid'],
            ['DOGE:PEPE', 'valid'],
        ]);
        sinon.assert.notCalled(indexer.indexerDb.getTokenInfo);
    });
}

describe('LIST tick coin activation @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    registerLegacyAndForeignItemTests();
    registerOwnCoinLookupTests();
    registerQualifiedItemValidationTests();
    registerMembershipTests();
});
