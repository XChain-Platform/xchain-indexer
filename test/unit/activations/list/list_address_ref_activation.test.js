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

const { createBaseData } = require('../../../fixtures/mocks');
const { stubGate } = require('../../../helpers/gate_modules.js');
const {
    SOURCE, ADDR1, ADDR2, makeListContext,
} = require('../../actions/contract/list.test/helpers/list_context.js');

const GATE_KEY = 'list_address_ref_activation.LIST_ADDRESS_REF_ACTIVATION';

function setup(armed){
    const { indexer, handler } = makeListContext();
    const gate = stubGate(sinon, GATE_KEY, armed);
    indexer.indexerDb.isActionAllowed.resolves(true);
    const rows = {
        '^7': { address: ADDR1, block_index: 100 },
        '^8': { address: ADDR2, block_index: 100 },
        '^9': { address: ADDR2, block_index: null },
    };
    indexer.indexerDb.resolveAddressRef.callsFake(async (item) => {
        const row = rows[item];
        if(row && row.block_index !== null) return row.address;
        return item;
    });
    return { indexer, handler, gate };
}

function listData(format, extra = {}){
    return createBaseData(Object.assign({
        ACTION: 'LIST', ACTION_INDEX: 80, BLOCK_INDEX: 200, FORMAT: format, SOURCE,
    }, extra));
}

function invalidRows(indexer){
    return indexer.indexerDb.createListItemInvalid.getCalls().map((call) => [
        call.args[1], call.args[2],
    ]);
}

describe('LIST address reference activation @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('leaves a canonical reference invalid below the activation', async function () {
        const { indexer, handler } = setup(false);
        const data = listData(0);

        await handler.parse(['0', '2', '', '^7'], data, null);

        assert.strictEqual(data.STATUS, 'valid');
        sinon.assert.notCalled(indexer.indexerDb.resolveAddressRef);
        assert.deepStrictEqual(invalidRows(indexer), [['^7', 'invalid: ADDRESS (format)']]);
    });

    it('stores an interned address reference in full form when armed', async function () {
        const { indexer, handler, gate } = setup(true);
        handler.config['COIN'] = 'LTC';
        const data = listData(0);

        await handler.parse(['0', '2', '', '^7'], data, null);

        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(gate.calledWith('regtest', 'LTC', 200, null), true);
        sinon.assert.calledOnceWithExactly(indexer.indexerDb.resolveAddressRef, '^7');
        sinon.assert.calledWith(indexer.indexerDb.createListItem, data, ADDR1);
        sinon.assert.notCalled(indexer.indexerDb.createListItemInvalid);
    });

    it('removes a member named by its address reference', async function () {
        const { indexer, handler } = setup(true);
        indexer.indexerDb.getListType.resolves(2);
        indexer.indexerDb.getList.resolves([ADDR1, ADDR2]);
        const data = listData(1);

        await handler.parse(['1', '2', '5', '', '^7'], data, null);

        assert.strictEqual(data.STATUS, 'valid');
        assert.deepStrictEqual(indexer.indexerDb.createListItem.getCalls().map((call) => call.args[1]), [ADDR2]);
        sinon.assert.calledWith(indexer.indexerDb.createListEdit, data, ADDR1, 'valid');
    });

    it('collapses a reference and its full address to one edit row', async function () {
        const { indexer, handler } = setup(true);
        indexer.indexerDb.getListType.resolves(2);
        indexer.indexerDb.getList.resolves([]);
        const data = listData(1);

        await handler.parse(['1', '1', '5', '', '^7', ADDR1], data, null);

        assert.strictEqual(data.STATUS, 'valid');
        sinon.assert.calledOnce(indexer.indexerDb.createListEdit);
        sinon.assert.calledWithExactly(indexer.indexerDb.createListEdit, data, ADDR1, 'valid');
        sinon.assert.calledOnce(indexer.indexerDb.createListItem);
    });

    it('keeps malformed, dangling, and non-deterministic references invalid', async function () {
        const { indexer, handler } = setup(true);
        const data = listData(0);

        await handler.parse(['0', '2', '', '^007', '^404', '^9'], data, null);

        assert.strictEqual(data.STATUS, 'valid');
        assert.deepStrictEqual(indexer.indexerDb.resolveAddressRef.getCalls().map((call) => call.args[0]), ['^404', '^9']);
        assert.deepStrictEqual(invalidRows(indexer), [
            ['^007', 'invalid: ADDRESS (format)'],
            ['^404', 'invalid: ADDRESS (format)'],
            ['^9', 'invalid: ADDRESS (format)'],
        ]);
    });

    it('does not resolve canonical references for token and union lists', async function () {
        const { indexer, handler } = setup(true);

        assert.strictEqual(await handler.resolveAddressItem('^7', { TYPE: 1, BLOCK_INDEX: 200 }), '^7');
        assert.strictEqual(await handler.resolveAddressItem('^7', { TYPE: 3, BLOCK_INDEX: 200 }), '^7');
        sinon.assert.notCalled(indexer.indexerDb.resolveAddressRef);
    });
});
