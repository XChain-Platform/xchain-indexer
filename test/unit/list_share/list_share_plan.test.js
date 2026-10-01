'use strict';

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
 *********************************************************************/

const assert = require('assert');
const path = require('path');

const { listMembershipHash } = require('../../../src/consensus/list_share_hash.js');
const { planDueVersions } = require('../../../src/consensus/list_share_settle/plan.js');
const { nextMembership } = require('../../../src/consensus/list_share_settle/delta.js');

const vectors = require(path.resolve(
    __dirname,
    '../../../../xchain-documentation/protocol/test-vectors/list_share.json'
));

const list = (home_chain, home_list_index, applied, rows) => ({
    home_chain, home_list_index, applied, rows
});
const row = (seq, height) => ({ seq, admit_block_btc: height });
const plan = (lists, extra = {}) => planDueVersions({
    lists,
    coin: 'BTC',
    blockIndex: 150,
    cap: 10,
    ...extra
});

describe('shared-list due planning and membership steps @regression @tier1', function(){
    it('matches every authoritative members-hash vector', function(){
        for(const vector of vectors.membersHash)
            assert.strictEqual(listMembershipHash(vector.members), vector.expected, vector.name);
    });

    it('matches every authoritative delta vector', function(){
        for(const vector of vectors.deltas){
            const result = nextMembership(vector.prev, {
                seq: 2,
                added: vector.added,
                removed: vector.removed,
                members_hash: listMembershipHash(vector.next)
            });
            assert.deepStrictEqual(result, { membership: vector.next }, vector.name);
        }
    });

    it('halts on a sequence gap behind a due row', function(){
        assert.deepStrictEqual(plan([list('DOGE', 7, 0, [row(2, 100)])]), {
            halt: { reason: 'SEQ_GAP', home_chain: 'DOGE', home_list_index: 7, seq: 1 }
        });
    });

    it('halts on a missing height behind a due row', function(){
        assert.deepStrictEqual(plan([list('DOGE', 7, 0, [row(1, null), row(2, 100)])]), {
            halt: { reason: 'NO_HEIGHT', home_chain: 'DOGE', home_list_index: 7, seq: 1 }
        });
    });

    it('waits when the next row is not yet due', function(){
        assert.deepStrictEqual(plan([list('DOGE', 7, 0, [row(1, 151)])]), { due: [] });
    });

    it('caps rows after deterministic list and sequence ordering', function(){
        const d1 = row(1, 1), d2 = row(2, 1), l1 = row(1, 1), l2 = row(2, 1);
        const result = plan([
            list('LTC', 2, 0, [l1, l2]),
            list('DOGE', 9, 0, [d1, d2])
        ], { blockIndex: 10, cap: 3 });
        assert.deepStrictEqual(result.due, [d1, d2, l1]);
    });

    it('does not let a filled cap hide a halt in a later list', function(){
        assert.deepStrictEqual(plan([
            list('DOGE', 1, 0, [row(1, 1)]),
            list('LTC', 1, 0, [row(2, 1)])
        ], { blockIndex: 10, cap: 1 }), {
            halt: { reason: 'SEQ_GAP', home_chain: 'LTC', home_list_index: 1, seq: 1 }
        });
    });

    it('builds version 1 only when no mirror membership exists', function(){
        const full = vectors.canonicals.find(vector => vector.seq === 1);
        const transport = {
            seq: full.seq,
            added: full.members,
            removed: [],
            members_hash: full.members_hash
        };
        assert.deepStrictEqual(nextMembership(null, transport), { membership: full.members });
        assert.deepStrictEqual(nextMembership([], transport), { halt: 'DELTA' });
    });

    it('requires canonical added members for version 1', function(){
        const members = ['bc1qmemberalpha', 'ltc1qmemberbeta'];
        for(const added of [members.slice().reverse(), [members[0], members[0]]]){
            assert.deepStrictEqual(nextMembership(null, {
                seq: 1,
                added,
                removed: [],
                members_hash: listMembershipHash(added)
            }), { halt: 'DELTA' });
        }
    });

    it('requires an empty removed list for version 1', function(){
        const added = ['bc1qmemberalpha'];
        assert.deepStrictEqual(nextMembership(null, {
            seq: 1,
            added,
            removed: ['ltc1qmemberbeta'],
            members_hash: listMembershipHash(added)
        }), { halt: 'DELTA' });
    });

    it('removes and adds members in canonical byte order', function(){
        const vector = vectors.deltas.find(item => item.name === 'remove and add in one version');
        const result = nextMembership(vector.prev, {
            seq: 2,
            added: vector.added,
            removed: vector.removed,
            members_hash: listMembershipHash(vector.next)
        });
        assert.deepStrictEqual(result, { membership: vector.next });
    });

    it('refuses every authoritative non-strict delta', function(){
        for(const vector of vectors.nonStrictDeltas){
            const result = nextMembership(vector.prev, {
                seq: 2,
                added: vector.added,
                removed: vector.removed,
                members_hash: listMembershipHash(vector.prev)
            });
            assert.deepStrictEqual(result, { halt: 'DELTA' }, vector.name);
        }
    });

    it('halts when the resulting membership hash differs', function(){
        const result = nextMembership(['bc1qmemberalpha'], {
            seq: 2,
            added: ['ltc1qmemberbeta'],
            removed: [],
            members_hash: listMembershipHash(['bc1qmemberalpha'])
        });
        assert.deepStrictEqual(result, { halt: 'MEMBERS_HASH' });
    });
});
