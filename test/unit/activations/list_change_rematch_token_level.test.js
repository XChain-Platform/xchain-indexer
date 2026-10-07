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
const { SOURCE, ADDR1, ADDR2, makeListContext } = require('../actions/contract/list.test/helpers/list_context.js');

const GATE_KEY = 'list_change_rematch_activation.LIST_CHANGE_REMATCH_ACTIVATION';
const TOKEN_LIST = 60;
const FIRST_EDIT = 61;
const SECOND_EDIT = 62;
const LIST_EDIT = 90;

function assertTokenListQuery(sql, args){
    const normalized = sql.replace(/\s+/g, ' ');
    const kind = normalized.includes('FROM orders m') ? 'order' : 'swap';
    assert.match(normalized, /WITH RECURSIVE list_refs\(action_index\) AS \( SELECT \?/);
    assert.match(normalized, /UNION DISTINCT SELECT ed\.action_index FROM lists ed/);
    assert.match(normalized, /INNER JOIN list_refs parent ON \(ed\.list_action_index=parent\.action_index\)/);
    const latestStatus = `ms\\.action_index=\\(SELECT MAX\\(l\\.action_index\\) ` +
        `FROM ${kind}_statuses l WHERE l\\.${kind}_action_index=m\\.action_index\\)`;
    assert.match(normalized, new RegExp(latestStatus));
    assert.match(normalized, /st\.status='open'/);
    assert.match(normalized, /tk\.allow_list IN \(SELECT action_index FROM list_refs\)/);
    assert.match(normalized, /tk\.block_list IN \(SELECT action_index FROM list_refs\)/);
    assert.deepStrictEqual(args, [TOKEN_LIST]);
}

function referencesRoot(value){
    const parents = new Map([[FIRST_EDIT, TOKEN_LIST], [SECOND_EDIT, FIRST_EDIT]]);
    while(parents.has(value)) value = parents.get(value);
    return value === TOKEN_LIST;
}

// Neither market carries its own list. The order token's allow list names an edit of an
// edit, while the swap token's block list names the first edit.
function setup(armed){
    const { indexer, actionsCtx, handler } = makeListContext();
    stubGate(sinon, GATE_KEY, armed);

    const members = new Set([ADDR1]);
    const book = { order: { status: 'open' }, swap: { status: 'open' } };
    indexer.indexerDb.getListType.resolves(2);
    indexer.indexerDb.getList.resolves([...members]);
    indexer.indexerDb.getListRootIndex.resolves(TOKEN_LIST);
    indexer.indexerDb.createListItem.callsFake(async (data, item) => members.add(item));
    indexer.indexerDb.doQuery.callsFake(async (sql, args) => {
        if(!sql.includes('INNER JOIN tokens tk')) return [];
        assertTokenListQuery(sql, args);
        const kind = sql.includes('FROM orders m') ? 'order' : 'swap';
        const tokenList = kind === 'order' ? { allow_list: SECOND_EDIT, block_list: null }
            : { allow_list: null, block_list: FIRST_EDIT };
        const affected = referencesRoot(tokenList.allow_list) || referencesRoot(tokenList.block_list);
        if(book[kind].status !== 'open' || !affected) return [];
        return [{ action_index: kind === 'order' ? 10 : 5 }];
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

    it('re-matches open markets whose token allow or block list names any edit generation', async function () {
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
