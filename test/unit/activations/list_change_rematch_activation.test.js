/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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

const { createBaseData } = require('../../fixtures/mocks');
const { stubGate } = require('../../helpers/gate_modules.js');
const gateRegistry = require('../../../src/consensus/gate_registry');
const { SOURCE, ADDR1, ADDR2, makeListContext } = require('../actions/contract/list.test/helpers/list_context.js');

const GATE_KEY = 'list_change_rematch_activation.LIST_CHANGE_REMATCH_ACTIVATION';
const LIST_ROOT = 50;
const LIST_EDIT = 80;

function setup(armed){
    const { indexer, actionsCtx, handler } = makeListContext();
    stubGate(sinon, GATE_KEY, armed);

    const members = new Set([ADDR1]);
    const orderBook = {
        10: { status: 'open', allow_list: LIST_ROOT, counterparty: ADDR2 },
        20: { status: 'open', allow_list: null, counterparty: ADDR1 },
    };
    const swapBook = {
        5: { status: 'open', allow_list: LIST_ROOT, counterparty: ADDR2 },
        25: { status: 'open', allow_list: null, counterparty: ADDR1 },
    };
    const matchOrder = () => {
        if(!members.has(orderBook[10].counterparty)) return false;
        orderBook[10].status = 'filled';
        orderBook[20].status = 'filled';
        return true;
    };
    const matchSwap = () => {
        if(!members.has(swapBook[5].counterparty)) return false;
        swapBook[5].status = 'filled';
        swapBook[25].status = 'filled';
        return true;
    };

    indexer.indexerDb.getListType.resolves(2);
    indexer.indexerDb.getList.resolves([...members]);
    indexer.indexerDb.getListRootIndex.resolves(LIST_ROOT);
    indexer.indexerDb.createListItem.callsFake(async (data, item) => members.add(item));
    indexer.indexerDb.getOrderEdits.resolves({ allow_list: false, block_list: false });
    indexer.indexerDb.getSwapEdits.resolves({ allow_list: false, block_list: false });
    indexer.indexerDb.doQuery.callsFake(async (sql) => {
        if(sql.includes('FROM lists')) return [];
        // The transfer-aware owner lookup (LS-14): no transfer, so ownership falls back to the source.
        if(sql.includes('FROM list_transfers')) return [];
        if(sql.includes('INNER JOIN tokens tk')) return [];
        if(sql.includes('FROM\n                    orders o'))
            return [{ action_index: 10, allow_list: LIST_ROOT, block_list: null }];
        if(sql.includes('FROM\n                    swaps s'))
            return [{ action_index: 5, allow_list: LIST_ROOT, block_list: null }];
        throw new Error('unexpected rematch query');
    });
    actionsCtx.processAction.callsFake(async (action, params, data) => {
        assert.strictEqual(params, null);
        assert.strictEqual(data.ACTION_INDEX, LIST_EDIT);
        if(action === 'ORDER_MATCH') matchOrder();
        if(action === 'SWAP_MATCH') matchSwap();
    });

    return { indexer, actionsCtx, handler, members, orderBook, swapBook, matchOrder, matchSwap };
}

async function addCounterparty(handler){
    const data = createBaseData({
        ACTION: 'LIST',
        ACTION_INDEX: LIST_EDIT,
        BLOCK_INDEX: 200,
        FORMAT: 1,
        SOURCE,
    });
    await handler.parse(['1', '1', String(LIST_ROOT), '', ADDR2], data, null);
    return data;
}

function assertCrossed(book, first, second){
    assert.strictEqual(book[first].status, 'open');
    assert.strictEqual(book[second].status, 'open');
}

// Before the rematch gate no ORDER or SWAP rematch read may run. The list handler's own
// reads (the transfer-aware owner, the shared-list check) are not rematch queries.
function assertNoRematchQuery(db){
    const rematch = db.doQuery.getCalls().filter(call => /FROM\s+(orders|swaps)\s/.test(String(call.args[0])));
    assert.strictEqual(rematch.length, 0, 'a rematch query ran before activation');
}

describe('LIST change rematch activation @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('is armed from genesis on regtest and unarmed on mainnet and every testnet', function () {
        assert.strictEqual(gateRegistry.activeAt(GATE_KEY, 'regtest', 'BTC', 0, null), true);
        assert.strictEqual(gateRegistry.activeAt(GATE_KEY, 'mainnet', 'BTC', 1_000_000_000, null), false);
        assert.strictEqual(gateRegistry.activeAt(GATE_KEY, 'testnet', null, 1_000_000_000, null), false);
        for (const [coin, armedAt] of Object.entries({ BTC: 154777, LTC: 4905004, DOGE: 67956922 })) {
            assert.strictEqual(gateRegistry.activeAt(GATE_KEY, 'testnet', coin, armedAt - 1, null), false);
            assert.strictEqual(gateRegistry.activeAt(GATE_KEY, 'testnet', coin, armedAt, null), true);
        }
    });

    it('matches crossed ORDERs and SWAPs at the LIST edit when the owner admits the counterparty', async function () {
        const { actionsCtx, handler, members, orderBook, swapBook, matchOrder, matchSwap } = setup(true);
        assert.strictEqual(matchOrder(), false);
        assert.strictEqual(matchSwap(), false);
        assertCrossed(orderBook, 10, 20);
        assertCrossed(swapBook, 5, 25);

        const data = await addCounterparty(handler);

        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(members.has(ADDR2), true);
        assert.deepStrictEqual(actionsCtx.processAction.getCalls().map((call) => [
            call.args[0],
            call.args[2].ORDER_ACTION_INDEX ?? call.args[2].SWAP_ACTION_INDEX,
        ]), [
            ['SWAP_MATCH', 5],
            ['ORDER_MATCH', 10],
        ]);
        assert.deepStrictEqual([orderBook[10].status, orderBook[20].status], ['filled', 'filled']);
        assert.deepStrictEqual([swapBook[5].status, swapBook[25].status], ['filled', 'filled']);
    });

    // Arm only the configured coin's slot, the shape a per-chain arming train writes.
    it('follows an arm of the configured coin slot alone', async function () {
        const { handler, orderBook, swapBook } = setup(false);
        stubGate(sinon, GATE_KEY, false).callsFake((key, network, coin) => coin === 'BTC');

        await addCounterparty(handler);

        assert.deepStrictEqual([orderBook[10].status, swapBook[5].status], ['filled', 'filled']);
    });

    it('leaves the same compatible ORDERs and SWAPs crossed before activation', async function () {
        const { indexer, actionsCtx, handler, members, orderBook, swapBook } = setup(false);

        const data = await addCounterparty(handler);

        assert.strictEqual(data.STATUS, 'valid');
        assert.strictEqual(members.has(ADDR2), true);
        assertCrossed(orderBook, 10, 20);
        assertCrossed(swapBook, 5, 25);
        sinon.assert.notCalled(actionsCtx.processAction);
        assertNoRematchQuery(indexer.indexerDb);
        sinon.assert.notCalled(indexer.indexerDb.getOrderEdits);
        sinon.assert.notCalled(indexer.indexerDb.getSwapEdits);
    });

    it('checks a valid address-list create and excludes token lists and invalid changes', async function () {
        const { indexer, actionsCtx, handler } = setup(true);
        indexer.indexerDb.doQuery.resetHistory();
        indexer.indexerDb.doQuery.resolves([]);

        const create = createBaseData({ ACTION: 'LIST', ACTION_INDEX: LIST_ROOT, BLOCK_INDEX: 200, FORMAT: 0, SOURCE });
        await handler.parse(['0', '2', '', ADDR1], create, null);
        assert.strictEqual(indexer.indexerDb.doQuery.callCount, 6);

        indexer.indexerDb.doQuery.resetHistory();
        const tokenList = createBaseData({ ACTION: 'LIST', ACTION_INDEX: LIST_ROOT + 1, BLOCK_INDEX: 200, FORMAT: 0, SOURCE });
        await handler.parse(['0', '1', '', 'UNKNOWN'], tokenList, null);
        assertNoRematchQuery(indexer.indexerDb);

        const invalid = createBaseData({ ACTION: 'LIST', ACTION_INDEX: LIST_EDIT + 1, BLOCK_INDEX: 200, FORMAT: 1, SOURCE });
        indexer.indexerDb.getListType.resolves(false);
        await handler.parse(['1', '1', '9999', '', ADDR2], invalid, null);
        assertNoRematchQuery(indexer.indexerDb);
        sinon.assert.notCalled(actionsCtx.processAction);
    });
});
