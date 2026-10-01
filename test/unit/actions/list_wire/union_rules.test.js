// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');

const {
    canonicalMemberIndex,
    unionResultVerdict,
    memberTypeVerdict,
    storedTypeVerdict,
} = require('../../../../src/actions/list/union_rules.js');

const CAPS = { unionMax: 16, shareMax: 10000 };

describe('LIST union rules', function(){
    describe('canonicalMemberIndex', function(){
        it('accepts only canonical positive decimal strings', function(){
            assert.strictEqual(canonicalMemberIndex('1'), '1');
            assert.strictEqual(canonicalMemberIndex('12'), '12');

            for(const item of ['0', '012', '1.5', '-3', 'abc', '', null, 12])
                assert.strictEqual(canonicalMemberIndex(item), null);
        });
    });

    describe('unionResultVerdict', function(){
        it('rejects an empty member list only when creating a union', function(){
            assert.strictEqual(unionResultVerdict({
                isCreate: true, memberCount: 0, mergedCount: 0
            }, CAPS), 'invalid: ITEM (no member list)');
            assert.strictEqual(unionResultVerdict({
                isCreate: false, memberCount: 0, mergedCount: 0
            }, CAPS), null);
        });

        it('accepts 16 members and rejects 17 members', function(){
            assert.strictEqual(unionResultVerdict({
                isCreate: true, memberCount: 16, mergedCount: 5
            }, CAPS), null);
            assert.strictEqual(unionResultVerdict({
                isCreate: true, memberCount: 17, mergedCount: 5
            }, CAPS), 'invalid: ITEM (union exceeds LIST_UNION_MAX_MEMBERS)');
        });

        it('accepts 10000 merged members and rejects 10001', function(){
            assert.strictEqual(unionResultVerdict({
                isCreate: false, memberCount: 16, mergedCount: 10000
            }, CAPS), null);
            assert.strictEqual(unionResultVerdict({
                isCreate: false, memberCount: 16, mergedCount: 10001
            }, CAPS), 'invalid: ITEM (union exceeds LIST_SHARE_MAX_MEMBERS)');
        });

        it('reports verdicts in validation order', function(){
            assert.strictEqual(unionResultVerdict({
                isCreate: true, memberCount: 0, mergedCount: 10001
            }, CAPS), 'invalid: ITEM (no member list)');
            assert.strictEqual(unionResultVerdict({
                isCreate: true, memberCount: 17, mergedCount: 10001
            }, CAPS), 'invalid: ITEM (union exceeds LIST_UNION_MAX_MEMBERS)');
        });
    });

    describe('type verdicts', function(){
        it('requires the member and union member types to match', function(){
            assert.strictEqual(memberTypeVerdict(2, 2), null);
            assert.strictEqual(memberTypeVerdict(1, 2), 'invalid: LIST (type)');
        });

        it('rejects a stored union type', function(){
            assert.strictEqual(storedTypeVerdict(3), 'invalid: LIST (union)');
            assert.strictEqual(storedTypeVerdict(2), null);
        });
    });
});
