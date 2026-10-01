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
const { listShareTarget } = require('../../../../src/consensus/list_share_settle/target.js');
const {
    ListShareHaltError,
    LIST_SHARE_HALT_REASON,
} = require('../../../../src/consensus/list_share_settle/halt.js');

const row = {
    snapshot_id: 'snapshot-1',
    home_chain: 'DOGE',
    home_list_index: 5,
};
const config = { ADDRESS: { BRIDGE_DOGE: 'bridge-doge' } };

function fakeDb(mirror, list){
    const reads = [];
    return {
        reads,
        db: {
            async getListShareMirror(chain, listIndex){
                reads.push(['mirror', chain, listIndex]);
                return mirror;
            },
            async getList(actionIndex, blockIndex){
                reads.push(['list', actionIndex, blockIndex]);
                return list;
            },
        },
    };
}

describe('list share target', function () {
    it('returns the owner without a list read when there is no mirror', async function () {
        const { db, reads } = fakeDb(null, ['unused']);

        assert.deepStrictEqual(await listShareTarget(db, { row, config, blockIndex: 50 }), {
            owner: 'bridge-doge',
            mirror: null,
            current: null,
        });
        assert.deepStrictEqual(reads, [['mirror', 'DOGE', 5]]);
    });

    it('reads and canonically sorts a mirrored list', async function () {
        const mirror = { action_index: '40' };
        const members = ['b', 'BTC:^5', 'a'];
        const { db, reads } = fakeDb(mirror, members);

        const target = await listShareTarget(db, { row, config, blockIndex: 50 });

        assert.strictEqual(target.mirror, mirror);
        assert.deepStrictEqual(target.current, ['BTC:^5', 'a', 'b']);
        assert.deepStrictEqual(members, ['b', 'BTC:^5', 'a']);
        assert.deepStrictEqual(reads, [
            ['mirror', 'DOGE', 5],
            ['list', 40, 50],
        ]);
    });

    it('returns null current when the mirrored list read is not an array', async function () {
        const mirror = { action_index: 40 };
        const { db } = fakeDb(mirror, null);

        const target = await listShareTarget(db, { row, config, blockIndex: 50 });

        assert.strictEqual(target.mirror, mirror);
        assert.strictEqual(target.current, null);
    });

    for(const [label, missingOwnerConfig] of [
        ['bridge address', { ADDRESS: {} }],
        ['empty bridge address', { ADDRESS: { BRIDGE_DOGE: '' } }],
        ['address map', {}],
    ]){
        it(`halts before any read when the ${label} is missing`, async function () {
            const { db, reads } = fakeDb(null, []);

            await assert.rejects(
                listShareTarget(db, { row, config: missingOwnerConfig, blockIndex: 50 }),
                error => error instanceof ListShareHaltError &&
                    error.reason === LIST_SHARE_HALT_REASON.NO_OWNER &&
                    error.snapshot_id === 'snapshot-1'
            );
            assert.deepStrictEqual(reads, []);
        });
    }
});
