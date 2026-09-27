/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../../fixtures/config');
const Utility           = require('../../../../src/utility');
const Database          = require('../../../../src/db');
const gateRegistry      = require('../../../../src/consensus/gate_registry');

const LIST_HEAD_FOLLOWS_EDIT_CHAIN_KEY = 'list_head_follows_edit_chain.LIST_HEAD_FOLLOWS_EDIT_CHAIN';

function dbWithChain(editCount, createIndex){
    const rows = [];
    const items = {};
    for(let offset = 0; offset <= editCount; offset++){
        const actionIndex = createIndex + offset;
        rows.push({
            action_index: actionIndex,
            list_action_index: offset === 0 ? null : actionIndex - 1,
            block_index: actionIndex,
            type: 2,
            status: 'valid'
        });
        items[String(actionIndex)] = ['member-' + actionIndex];
    }

    const config = getTestConfig();
    const util = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database(null, null, null, null, null, { config, util });
    const rowFor = actionIndex => rows.find(row => String(row.action_index) === String(actionIndex));

    sinon.stub(db, 'doQuery').callsFake(async (query, args) => {
        const normalized = query.replace(/\s+/g, ' ');
        if(/SELECT type FROM lists WHERE action_index=\?/i.test(normalized)){
            const row = rowFor(args[0]);
            return row ? [{ type: row.type }] : [];
        }
        if(/SELECT l\.type FROM lists l INNER JOIN index_statuses/i.test(normalized)){
            const row = rowFor(args[0]);
            return row && row.status === 'valid' ? [{ type: row.type }] : [];
        }
        if(/SELECT list_action_index FROM lists WHERE action_index=\?/i.test(normalized)){
            const row = rowFor(args[0]);
            return row ? [{ list_action_index: row.list_action_index }] : [];
        }
        if(/SELECT l\.list_action_index FROM lists l INNER JOIN actions a/i.test(normalized)){
            const row = rowFor(args[0]);
            return row && row.block_index > args[1]
                ? [{ list_action_index: row.list_action_index }]
                : [];
        }
        if(/SELECT l\.action_index FROM lists l INNER JOIN index_statuses/i.test(normalized)){
            const children = rows
                .filter(row => row.status === 'valid' && String(row.list_action_index) === String(args[0]))
                .filter(row => args.length < 2 || row.block_index <= args[1])
                .sort((left, right) => right.action_index - left.action_index);
            return children.length ? [{ action_index: children[0].action_index }] : [];
        }
        if(/FROM list_items l/i.test(normalized)){
            return (items[String(args[0])] || []).map(item => ({ item }));
        }
        return [];
    });
    sinon.stub(db, 'isListEditResolutionActive').returns(true);
    sinon.stub(gateRegistry, 'activeAt').callThrough()
        .withArgs(LIST_HEAD_FOLLOWS_EDIT_CHAIN_KEY, 'regtest', 'BTC').returns(false);
    return db;
}

afterEach(function(){ sinon.restore(); });

describe('db.getListAtBlock legacy edit-chain bound @regression @tier1', function(){
    it('walks past the 16-hop cap when its fallback is newer than the queried block', async function(){
        const db = dbWithChain(18, 100);

        assert.deepStrictEqual(await db.getListAtBlock(118, 101), ['member-101']);
    });

    it('preserves direct-child resolution for a three-edit legacy chain', async function(){
        const db = dbWithChain(3, 200);

        assert.deepStrictEqual(await db.getListAtBlock(203, 202), ['member-201']);
    });
});
