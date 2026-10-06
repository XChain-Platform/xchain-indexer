'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { createBaseData } = require('../../fixtures/mocks');
const { stubGate } = require('../../helpers/gate_modules.js');
const { SOURCE, ADDR1, ADDR2, makeListContext } = require('../actions/contract/list.test/helpers/list_context.js');

const GATE_KEY = 'list_change_rematch_activation.LIST_CHANGE_REMATCH_ACTIVATION';
const TOKEN_LIST = 60;
const LIST_EDIT = 90;

// Orders 10 and swaps 5 carry no list of their own; only their token's block list names TOKEN_LIST.
function setup(armed){
    const { indexer, actionsCtx, handler } = makeListContext();
    stubGate(sinon, GATE_KEY, armed);

    const members = new Set([ADDR1]);
    const book = { order: { status: 'open' }, swap: { status: 'open' } };
    indexer.indexerDb.getListType.resolves(2);
    indexer.indexerDb.getList.resolves([...members]);
    indexer.indexerDb.getListRootIndex.resolves(TOKEN_LIST);
    indexer.indexerDb.createListItem.callsFake(async (data, item) => members.add(item));
    indexer.indexerDb.doQuery.callsFake(async (sql) => {
        if(!sql.includes('INNER JOIN tokens tk')) return [];
        const kind = sql.includes('FROM orders m') ? 'order' : 'swap';
        return book[kind].status === 'open' ? [{ action_index: kind === 'order' ? 10 : 5 }] : [];
    });
    actionsCtx.processAction.callsFake(async (action) => {
        if(!members.has(ADDR2)) return;
        book[action === 'ORDER_MATCH' ? 'order' : 'swap'].status = 'filled';
    });
    return { indexer, actionsCtx, handler, book };
}

async function addMember(handler){
    const data = createBaseData({ ACTION: 'LIST', ACTION_INDEX: LIST_EDIT, BLOCK_INDEX: 200, FORMAT: 1, SOURCE });
    await handler.parse(['1', '1', String(TOKEN_LIST), '', ADDR2], data, null);
    return data;
}

describe('LIST change rematch for token-level lists @regression @tier2', function () {
    afterEach(function () { sinon.restore(); });

    it('re-matches an open ORDER and SWAP blocked by a token list once the gate is active', async function () {
        const { actionsCtx, handler, book } = setup(true);

        const data = await addMember(handler);

        assert.strictEqual(data.STATUS, 'valid');
        assert.deepStrictEqual(actionsCtx.processAction.getCalls().map((call) => [
            call.args[0], call.args[2].ORDER_ACTION_INDEX ?? call.args[2].SWAP_ACTION_INDEX,
        ]), [['SWAP_MATCH', 5], ['ORDER_MATCH', 10]]);
        assert.deepStrictEqual([book.order.status, book.swap.status], ['filled', 'filled']);
    });

    it('leaves them blocked before the gate is active', async function () {
        const { indexer, actionsCtx, handler, book } = setup(false);

        await addMember(handler);

        sinon.assert.notCalled(actionsCtx.processAction);
        assert.deepStrictEqual([book.order.status, book.swap.status], ['open', 'open']);
        assert.strictEqual(indexer.indexerDb.doQuery.getCalls().some(c => /INNER JOIN tokens tk/.test(c.args[0])), false);
    });
});
