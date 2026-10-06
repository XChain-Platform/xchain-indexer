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

const { listRefFor } = require('../../../../../src/api/rpc/token_policy/list_ref.js');

const SHARED_LISTS = [{ root_index: '12', share_block: '100', share_action_index: 13 }];
const MIRROR = {
    action_index: '40',
    home_chain: 'DOGE',
    home_list_index: 2701,
    block_index: '50'
};

function ref(overrides = {}){
    return listRefFor(Object.assign({
        coin: 'BTC',
        root: 12,
        originBlock: 100,
        sharedLists: SHARED_LISTS,
        mirror: null
    }, overrides));
}

describe('token policy list references', function () {
    it('references a home-shared root at its share block', function () {
        assert.strictEqual(ref(), 'BTC:12');
    });

    it('references a mirror by its home-chain identity', function () {
        assert.strictEqual(ref({ root: 40, sharedLists: [], mirror: MIRROR }), 'DOGE:2701');
    });

    it('keeps a root shared after the origin block as a full copy', function () {
        assert.strictEqual(ref({ originBlock: 99 }), null);
    });

    it('keeps a mirror created after the origin block as a full copy', function () {
        assert.strictEqual(ref({ root: 40, originBlock: 49, sharedLists: [], mirror: MIRROR }), null);
    });

    it('keeps an unshared local list as a full copy', function () {
        assert.strictEqual(ref({ root: 41, sharedLists: [], mirror: null }), null);
    });

    it('rejects a non-integer root', function () {
        for(const root of ['12', 12.5, NaN, null, undefined])
            assert.strictEqual(ref({ root }), null);
    });

    it('rejects a non-integer origin block', function () {
        for(const originBlock of ['100', 100.5, NaN, null, undefined])
            assert.strictEqual(ref({ originBlock }), null);
    });

    it('rejects a non-array shared-list answer', function () {
        for(const sharedLists of [null, undefined, {}, 'shared'])
            assert.strictEqual(ref({ sharedLists }), null);
    });
});
