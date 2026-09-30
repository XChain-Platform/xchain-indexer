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

const assert = require('assert');
const sinon = require('sinon');

const {
    isListShared,
    getSharedLists,
    getListOwner,
    createListTransfer
} = require('../../../../src/db/lists/sharing');

function normalized(sql){
    return sql.replace(/\s+/g, ' ').trim();
}

afterEach(function(){ sinon.restore(); });

describe('shared list storage reads', function(){
    it('recognizes a valid format-2 share for a root', async function(){
        const doQuery = sinon.stub().callsFake(async (sql, args) => {
            const query = normalized(sql);
            assert.match(query, /INNER JOIN actions a ON \(a\.action_index=l\.action_index\)/);
            assert.match(query, /INNER JOIN index_statuses s ON \(s\.id=l\.status_id\)/);
            assert.match(query, /l\.list_action_index=\?/);
            assert.match(query, /a\.action_format=2/);
            assert.match(query, /s\.status='valid'/);
            assert.deepStrictEqual(args, [100]);
            return [{ 1: 1 }];
        });

        assert.strictEqual(await isListShared({ doQuery }, 100), true);
    });

    it('reports an unshared root when no valid format-2 row exists', async function(){
        const doQuery = sinon.stub().resolves([]);

        assert.strictEqual(await isListShared({ doQuery }, 101), false);
        assert.deepStrictEqual(doQuery.firstCall.args[1], [101]);
    });

    it('returns valid shares in action order and ignores an invalid share', async function(){
        const rows = [
            { root_index: 10, share_action_index: 20, share_block: 200 },
            { root_index: 11, share_action_index: 30, share_block: 300 }
        ];
        const doQuery = sinon.stub().callsFake(async (sql, args) => {
            const query = normalized(sql);
            assert.match(query, /l\.list_action_index AS root_index/);
            assert.match(query, /l\.action_index AS share_action_index/);
            assert.match(query, /a\.block_index AS share_block/);
            assert.match(query, /a\.action_format=2/);
            assert.match(query, /s\.status='valid'/);
            assert.match(query, /ORDER BY share_action_index ASC$/);
            assert.deepStrictEqual(args, []);
            return rows;
        });

        assert.deepStrictEqual(await getSharedLists({ doQuery }), rows);
    });

    it('returns the destination of the newest transfer after two transfers', async function(){
        const addresses = new Map();
        const transfers = [];
        const db = {
            createAddress: sinon.stub().callsFake(async address => {
                if(!addresses.has(address)) addresses.set(address, addresses.size + 1);
                return addresses.get(address);
            }),
            getListSource: sinon.stub().rejects(new Error('source fallback must not run')),
            doQuery: sinon.stub().callsFake(async (sql, args) => {
                const query = normalized(sql);
                if(/^INSERT INTO list_transfers /.test(query)){
                    transfers.push({ action_index: args[0], list_action_index: args[1], destination_id: args[2] });
                    return { affectedRows: 1 };
                }
                assert.match(query, /INNER JOIN index_addresses a ON \(a\.id=lt\.destination_id\)/);
                assert.match(query, /ORDER BY lt\.action_index DESC LIMIT 1$/);
                const newest = transfers
                    .filter(row => row.list_action_index === args[0])
                    .sort((left, right) => right.action_index - left.action_index)[0];
                if(!newest) return [];
                const address = [...addresses].find(([, id]) => id === newest.destination_id)[0];
                return [{ address }];
            })
        };

        await createListTransfer(db, { ACTION_INDEX: 201, LIST_ACTION_INDEX: 100 }, 'first-owner');
        await createListTransfer(db, { ACTION_INDEX: 202, LIST_ACTION_INDEX: 100 }, 'second-owner');

        assert.strictEqual(await getListOwner(db, 100), 'second-owner');
        assert.strictEqual(db.createAddress.callCount, 2);
        assert.deepStrictEqual(transfers, [
            { action_index: 201, list_action_index: 100, destination_id: 1 },
            { action_index: 202, list_action_index: 100, destination_id: 2 }
        ]);
    });

    it('falls back to the list source when no transfer exists', async function(){
        const db = {
            doQuery: sinon.stub().resolves([]),
            getListSource: sinon.stub().resolves('original-owner')
        };

        assert.strictEqual(await getListOwner(db, 100), 'original-owner');
        assert.ok(db.getListSource.calledOnceWithExactly(100));
    });
});
