/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
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

const fixture = require('../../fixtures/list_share_ticker_mirror.json');
const { listMembershipHash } = require('../../../src/consensus/list_share_hash.js');

function compareUtf8(left, right){
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function assertStrictUtf8Order(values){
    for(let index = 1; index < values.length; index += 1){
        assert(compareUtf8(values[index - 1], values[index]) < 0);
    }
}

describe('list-share ticker mirror fixture @regression @tier1', function(){
    const [full, delta] = fixture.versions;

    it('pins the two canonical fixture versions', function(){
        assert.deepStrictEqual(fixture, {
            home_chain: 'DOGE',
            list_type: 1,
            preinterned: ['doge:pepe'],
            versions: [
                {
                    seq: 1,
                    kind: 'full',
                    added: ['BTC:NOPE', 'BTC:^5', 'DOGE:PEPE', 'LTC:^9'],
                    removed: [],
                    members: ['BTC:NOPE', 'BTC:^5', 'DOGE:PEPE', 'LTC:^9'],
                    members_hash: 'c6ed855d236b8010f7ca14d82cdcd5d4df9cafd239255cd66f6cec7aa09780f4'
                },
                {
                    seq: 2,
                    kind: 'delta',
                    added: ['LTC:BAR'],
                    removed: ['DOGE:PEPE'],
                    members: ['BTC:NOPE', 'BTC:^5', 'LTC:BAR', 'LTC:^9'],
                    members_hash: '56ba849c8c2f6af5b8b85552ae4d24337a4a71b5c80283816e8e229c31080e9b'
                }
            ]
        });
    });

    it('keeps every member array in strict UTF-8 byte order', function(){
        const arrays = [
            fixture.preinterned,
            full.added,
            full.removed,
            full.members,
            delta.added,
            delta.removed,
            delta.members
        ];

        for(const values of arrays) assertStrictUtf8Order(values);
    });

    it('pins each membership hash to listMembershipHash', function(){
        for(const version of fixture.versions){
            assert.strictEqual(version.members_hash, listMembershipHash(version.members));
        }
    });

    it('derives the delta members from the full version', function(){
        const recomposed = full.members
            .filter(member => !delta.removed.includes(member))
            .concat(delta.added)
            .sort(compareUtf8);

        assert.deepStrictEqual(delta.members, recomposed);
    });

    it('keeps the delta strict against the full version', function(){
        for(const member of delta.added) assert(!full.members.includes(member));
        for(const member of delta.removed) assert(full.members.includes(member));
    });

    it('preinterns the case-folded DOGE ticker only', function(){
        assert.strictEqual(fixture.preinterned.length, 1);
        assert.notStrictEqual(fixture.preinterned[0], 'DOGE:PEPE');
        assert.strictEqual(fixture.preinterned[0].toUpperCase(), 'DOGE:PEPE');
    });
});
