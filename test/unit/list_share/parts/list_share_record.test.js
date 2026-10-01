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
const {
    recordListShareApplied,
} = require('../../../../src/consensus/list_share_settle/record.js');

const snapshotId = 'b'.repeat(64);

function fixture(createdIndex = 99){
    const minted = [];
    const settlements = [];
    const db = {
        async createActionIndex(action){
            minted.push(action);
            return createdIndex;
        },
        async recordBridgeSettlement(...args){
            settlements.push(args);
        },
    };
    return { db, minted, settlements };
}

function args(overrides = {}){
    return Object.assign({
        actionIndexes: [70, 71],
        snapshotId,
        homeChain: 'DOGE',
        homeListIndex: 5,
        coin: 'BTC',
        blockIndex: 50,
    }, overrides);
}

describe('list share settlement recording', function () {
    it('anchors to the last applied leg and leaves the input unchanged', async function () {
        const f = fixture();
        const actionIndexes = [70, 71];

        const anchor = await recordListShareApplied(f.db, args({ actionIndexes }));

        assert.strictEqual(anchor, 71);
        assert.deepStrictEqual(actionIndexes, [70, 71]);
        assert.deepStrictEqual(f.minted, []);
        assert.deepStrictEqual(f.settlements, [[
            71, snapshotId, 'list', 50, 'DOGE', 5, 'BTC', null, null,
        ]]);
    });

    it('converts a string leg index to a number', async function () {
        const f = fixture();

        const anchor = await recordListShareApplied(
            f.db,
            args({ actionIndexes: ['70', '71'] })
        );

        assert.strictEqual(anchor, 71);
        assert.strictEqual(f.settlements[0][0], 71);
    });

    it('mints one rollback-able action index when no leg was applied', async function () {
        const f = fixture(99);

        const anchor = await recordListShareApplied(f.db, args({ actionIndexes: [] }));

        assert.strictEqual(anchor, 99);
        assert.deepStrictEqual(f.minted, [{
            ACTION: 'LIST_SHARE',
            BLOCK_INDEX: 50,
            FORMAT: 0,
        }]);
        assert.deepStrictEqual(f.settlements, [[
            99, snapshotId, 'list', 50, 'DOGE', 5, 'BTC', null, null,
        ]]);
    });

    for(const [label, override] of [
        ['an upper-case snapshot id', { snapshotId: snapshotId.toUpperCase() }],
        ['non-array action indexes', { actionIndexes: null }],
        ['an empty coin', { coin: '' }],
    ]){
        it('rejects ' + label + ' before any database call', async function () {
            const f = fixture();

            await assert.rejects(recordListShareApplied(f.db, args(override)), TypeError);

            assert.deepStrictEqual(f.minted, []);
            assert.deepStrictEqual(f.settlements, []);
        });
    }
});
