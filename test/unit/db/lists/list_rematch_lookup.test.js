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

const { getTestConfig } = require('../../../fixtures/config');
const Utility = require('../../../../src/utility');
const Database = require('../../../../src/db');
const { getOpenOrdersByList, getOpenSwapsByList } = require('../../../../src/db/lists/rematch');

const LIST_ROOT = 500;
const LIST_EDIT = 501;
const LIST_EDIT_OF_EDIT = 502;

function marketRows(){
    return [
        { action_index: 80, allow_list: null, block_list: 600 },
        { action_index: 20, allow_list: null, block_list: LIST_ROOT },
        { action_index: 70, allow_list: LIST_EDIT, block_list: null },
        { action_index: 90, allow_list: LIST_EDIT_OF_EDIT, block_list: null },
        { action_index: 10, allow_list: LIST_ROOT, block_list: null },
        { action_index: 60, allow_list: LIST_ROOT, block_list: null },
        { action_index: 50, allow_list: 600, block_list: null },
        { action_index: 40, allow_list: LIST_ROOT, block_list: null },
        { action_index: 30, allow_list: null, block_list: null }
    ];
}

function statusRows(){
    let rows = [10, 20, 30, 40, 50, 70, 80, 90].map(action_index => ({
        action_index: action_index * 10,
        market_action_index: action_index,
        status: 'open'
    }));
    rows.push(
        { action_index: 600, market_action_index: 60, status: 'open' },
        { action_index: 601, market_action_index: 60, status: 'complete' }
    );
    return rows;
}

function editRows(){
    return [
        { action_index: 300, market_action_index: 30, allow_list: 600, block_list: null, status: 'valid' },
        { action_index: 301, market_action_index: 30, allow_list: LIST_ROOT, block_list: null, status: 'valid' },
        { action_index: 400, market_action_index: 40, allow_list: LIST_ROOT, block_list: null, status: 'valid' },
        { action_index: 401, market_action_index: 40, allow_list: 0, block_list: null, status: 'valid' },
        { action_index: 500, market_action_index: 50, allow_list: LIST_ROOT, block_list: null, status: 'invalid' },
        { action_index: 800, market_action_index: 80, allow_list: null, block_list: LIST_EDIT, status: 'valid' }
    ];
}

function latestStatus(statuses, action_index){
    return statuses
        .filter(row => row.market_action_index === action_index)
        .sort((a, b) => b.action_index - a.action_index)[0];
}

function referencesAny(row, targets){
    return targets.has(String(row.allow_list)) || targets.has(String(row.block_list));
}

function dbWithMarkets(kind){
    const config = getTestConfig();
    const util = new Utility();
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    const markets = marketRows();
    const statuses = statusRows();
    const edits = editRows();
    const candidateIndexes = [];
    const listParentsRead = [];

    sinon.stub(db, 'doQuery').callsFake((query, args) => {
        const sql = query.replace(/\s+/g, ' ');
        if(new RegExp(`FROM ${kind}s [os] INNER JOIN ${kind}_statuses`, 'i').test(sql)){
            assert.match(sql, /SELECT MAX\(latest\.action_index\)/i);
            assert.match(sql, /st\.status='open'/i);
            assert.deepStrictEqual(args, [
                LIST_ROOT, LIST_EDIT, LIST_EDIT_OF_EDIT,
                LIST_ROOT, LIST_EDIT, LIST_EDIT_OF_EDIT,
                LIST_ROOT, LIST_EDIT, LIST_EDIT_OF_EDIT,
                LIST_ROOT, LIST_EDIT, LIST_EDIT_OF_EDIT
            ]);
            const targets = new Set([String(LIST_ROOT), String(LIST_EDIT), String(LIST_EDIT_OF_EDIT)]);
            const rows = markets.filter(market => {
                const latest = latestStatus(statuses, market.action_index);
                const namedByEdit = edits.some(edit =>
                    edit.market_action_index === market.action_index && referencesAny(edit, targets));
                return latest && latest.status === 'open' &&
                    (referencesAny(market, targets) || namedByEdit);
            }).sort((a, b) => a.action_index - b.action_index);
            candidateIndexes.push(...rows.map(row => row.action_index));
            return Promise.resolve(rows);
        }

        if(/^SELECT action_index FROM lists WHERE list_action_index=\?/i.test(sql)){
            listParentsRead.push(args[0]);
            const children = {
                [LIST_ROOT]: [{ action_index: LIST_EDIT }],
                [LIST_EDIT]: [{ action_index: LIST_EDIT_OF_EDIT }],
                [LIST_EDIT_OF_EDIT]: [{ action_index: LIST_ROOT }]
            };
            return Promise.resolve(children[args[0]] || []);
        }

        const editAlias = kind === 'order' ? 'o' : 's1';
        if(new RegExp(`FROM ${kind}_edits ${editAlias} INNER JOIN index_statuses`, 'i').test(sql)){
            const rows = edits
                .filter(row => row.market_action_index === args[0] && row.status === args[1])
                .sort((a, b) => a.action_index - b.action_index)
                .map(row => ({
                    expiration: null,
                    allow_list: row.allow_list,
                    block_list: row.block_list
                }));
            return Promise.resolve(rows);
        }

        return Promise.resolve([]);
    });
    db._candidateIndexes = candidateIndexes;
    db._listParentsRead = listParentsRead;
    return db;
}

afterEach(function () { sinon.restore(); });

for(const testCase of [
    { kind: 'order', lookup: getOpenOrdersByList, editMethod: 'getOrderEdits' },
    { kind: 'swap', lookup: getOpenSwapsByList, editMethod: 'getSwapEdits' }
]){
    it(`finds open ${testCase.kind}s whose effective lists resolve to the changed root`, async function () {
        const db = dbWithMarkets(testCase.kind);
        const editSpy = sinon.spy(db, testCase.editMethod);

        const indexes = await testCase.lookup(db, LIST_ROOT);

        assert.deepStrictEqual(indexes, [10, 20, 30, 70, 80, 90]);
        assert.deepStrictEqual(db._candidateIndexes, [10, 20, 30, 40, 50, 70, 80, 90]);
        assert.deepStrictEqual(db._listParentsRead, [LIST_ROOT, LIST_EDIT, LIST_EDIT_OF_EDIT]);
        assert.ok(editSpy.calledWith(40), 'the 0 edit candidate must be resolved and removed');
        assert.ok(editSpy.calledWith(50), 'the invalid edit candidate must be resolved and ignored');
        assert.ok(!editSpy.calledWith(60), 'a market whose latest status is not open must be excluded');
    });
}
