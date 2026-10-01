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

const { listMembershipHash } = require('../../../../src/consensus/list_share_hash.js');
const {
    ListShareHaltError,
    LIST_SHARE_HALT_REASON,
} = require('../../../../src/consensus/list_share_settle/halt.js');
const {
    verifyMirrorMembers,
} = require('../../../../src/consensus/list_share_settle/reread.js');

const argumentsFor = extra => ({
    mirrorIndex: '40',
    blockIndex: 90,
    membersHash: listMembershipHash(['BTC:^5', 'a', 'b']),
    snapshotId: 'snapshot-1',
    ...extra,
});

describe('list share mirror membership re-read @regression @tier1', function(){
    it('returns a sorted copy after exactly one read at the requested block', async function(){
        const source = ['b', 'BTC:^5', 'a'];
        const reads = [];
        const db = {
            getList: async (index, block) => {
                reads.push([index, block]);
                return source;
            }
        };

        const result = await verifyMirrorMembers(db, argumentsFor({}));

        assert.deepStrictEqual(result, ['BTC:^5', 'a', 'b']);
        assert.deepStrictEqual(reads, [[40, 90]]);
        assert.deepStrictEqual(source, ['b', 'BTC:^5', 'a']);
    });

    it('accepts an empty mirror list with the empty membership hash', async function(){
        const result = await verifyMirrorMembers({ getList: async () => [] }, argumentsFor({
            mirrorIndex: 7,
            membersHash: listMembershipHash([]),
        }));

        assert.deepStrictEqual(result, []);
    });

    it('halts when a mirror member is missing', async function(){
        await assert.rejects(
            verifyMirrorMembers({ getList: async () => ['a', 'b'] }, argumentsFor({})),
            error => error instanceof ListShareHaltError &&
                error.reason === LIST_SHARE_HALT_REASON.MEMBERS_HASH &&
                error.snapshot_id === 'snapshot-1'
        );
    });

    it('halts when the mirror list is unreadable', async function(){
        await assert.rejects(
            verifyMirrorMembers({ getList: async () => null }, argumentsFor({})),
            error => error instanceof ListShareHaltError &&
                error.reason === LIST_SHARE_HALT_REASON.MEMBERS_HASH &&
                error.snapshot_id === 'snapshot-1'
        );
    });

    it('rejects invalid inputs before reading the mirror', async function(){
        const validHash = listMembershipHash(['BTC:^5', 'a', 'b']);
        const invalid = [
            { mirrorIndex: 0 },
            { mirrorIndex: '040' },
            { membersHash: validHash.toUpperCase() },
        ];

        for(const extra of invalid){
            let reads = 0;
            const db = { getList: async () => { reads++; return []; } };
            await assert.rejects(verifyMirrorMembers(db, argumentsFor(extra)), TypeError);
            assert.strictEqual(reads, 0);
        }
    });
});
