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

const assert = require('assert');

const editApply = require('../../../../src/actions/bet/edit_lists_apply.js');
const records   = require('../../../../src/db/bets/records.js');
const lifecycle = require('../../../../src/hub/table_lifecycle.js');

function editData(overrides = {}){
    return {
        ACTION_INDEX: 91,
        FEED_ACTION_INDEX: 50,
        ALLOW_LIST: null,
        BLOCK_LIST: 72,
        MEMO: 'replace block list',
        STATUS: 'valid',
        ...overrides
    };
}

function editDb(existing = []){
    const calls = [];
    return {
        calls,
        normalizeDataValues: data => data,
        createMemo: async () => 14,
        createStatus: async () => 15,
        doQuery: async (...args) => {
            calls.push(args);
            return calls.length === 1 ? existing : [];
        }
    };
}

describe('BET format 4 edit application @regression @tier1', function(){
    it('retags a valid format 4 action before writing its append-only row', async function(){
        const calls = [];
        const data = editData();
        const indexerDb = {
            updateActionIndex: async (...args) => calls.push(['type', ...args]),
            createBetEdit: async row => calls.push(['row', row])
        };

        await editApply.applyEditLists.call({ indexerDb }, data, 4);

        assert.deepStrictEqual(calls, [
            ['type', 91, 'BET_EDIT'],
            ['row', data]
        ]);
    });

    it('does not write an edit row for another BET format', async function(){
        const calls = [];
        const indexerDb = {
            updateActionIndex: async (...args) => calls.push(args),
            createBetEdit: async (...args) => calls.push(args)
        };

        await editApply.applyEditLists.call({ indexerDb }, editData(), 2);

        assert.deepStrictEqual(calls, []);
    });

    it('inserts independent list values without updating the feed row', async function(){
        const db = editDb();

        await records.createBetEdit.call(db, editData());

        assert.match(db.calls[1][0], /INSERT INTO bet_edits/);
        assert.doesNotMatch(db.calls[1][0], /UPDATE\s+bet_feeds/);
        assert.deepStrictEqual(db.calls[1][1], [50, null, 72, 14, 15, 91]);
    });

    it('replays the same action as an idempotent row update', async function(){
        const db = editDb([{ action_index: 91 }]);

        await records.createBetEdit.call(db, editData({ ALLOW_LIST: 0, BLOCK_LIST: null }));

        assert.match(db.calls[1][0], /UPDATE\s+bet_edits/);
        assert.deepStrictEqual(db.calls[1][1], [50, 0, null, 14, 15, 91]);
    });

    it('classifies bet_edits for generic action-scoped rollback', function(){
        const tables = lifecycle.rollbackTables();

        assert.ok(tables.dataTables.includes('bet_edits'));
        assert.strictEqual(tables.blockTables.includes('bet_edits'), false);
    });
});
