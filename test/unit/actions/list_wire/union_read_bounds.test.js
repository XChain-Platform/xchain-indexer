// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const { validateUnionResult } = require('../../../../src/actions/list/union.js');

function context(getList){
    return {
        indexerDb: { getList },
        isCreateFormat: format => format === 'create'
    };
}

describe('LIST union read bounds @regression', function(){
    it('rejects an over-cap union without hydrating any member list', async function(){
        let reads = 0;
        const list = Array.from({ length: 17 }, (_, i) => String(i + 1));
        const verdict = await validateUnionResult.call(context(async () => {
            reads++;
            return ['unused'];
        }), { TYPE: 3, BLOCK_INDEX: 9 }, 'create', list, {}, null);

        assert.strictEqual(verdict, 'invalid: ITEM (union exceeds LIST_UNION_MAX_MEMBERS)');
        assert.strictEqual(reads, 0);
    });

    it('stops hydrating once the merged-size verdict is fixed', async function(){
        let reads = 0;
        const oversized = Array.from({ length: 10001 }, (_, i) => 'item-' + i);
        const verdict = await validateUnionResult.call(context(async () => {
            reads++;
            return reads === 1 ? oversized : ['unused'];
        }), { TYPE: 3, BLOCK_INDEX: 9 }, 'edit', ['1', '2', '3'], {}, null);

        assert.strictEqual(verdict, 'invalid: ITEM (union exceeds LIST_SHARE_MAX_MEMBERS)');
        assert.strictEqual(reads, 1);
    });
});
