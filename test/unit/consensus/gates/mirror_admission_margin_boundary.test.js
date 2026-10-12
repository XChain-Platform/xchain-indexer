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
const {
    stampMarginAt,
    rowMarginAt,
    consumerTargetAt,
} = require('../../../../src/consensus/gates/mirror_admission_margin_boundary.js');

const M = 4;
const M_CHAIN = 14;
const H = 1000;

describe('mirror-admission margin boundary', function(){
    it('changes the stamp margin when the chain margin reaches the boundary', function(){
        assert.strictEqual(stampMarginAt(M, M_CHAIN, H, 985), M);
        assert.strictEqual(stampMarginAt(M, M_CHAIN, H, 986), M_CHAIN);
    });

    it('changes the row margin at the admission boundary', function(){
        assert.strictEqual(rowMarginAt(M, M_CHAIN, H, 999), M);
        assert.strictEqual(rowMarginAt(M, M_CHAIN, H, 1000), M_CHAIN);
    });

    it('selects the consumer target on both sides of the boundary', function(){
        assert.strictEqual(consumerTargetAt(M, M_CHAIN, H, 999), 995);
        assert.strictEqual(consumerTargetAt(M, M_CHAIN, H, 1000), 986);
        assert.strictEqual(consumerTargetAt(M, M_CHAIN, H, 1010), 996);
    });

    it('never returns a target above the old-margin target', function(){
        for(let B = 990; B <= 1030; B++)
            assert.ok(consumerTargetAt(M, M_CHAIN, H, B) <= B - M, 'block ' + B);
    });

    for(const invalid of [null, undefined, NaN, Infinity, -Infinity]){
        it('uses the old margin when the chain margin is ' + String(invalid), function(){
            assert.strictEqual(stampMarginAt(M, invalid, H, 1000), M);
            assert.strictEqual(rowMarginAt(M, invalid, H, 1000), M);
            assert.strictEqual(consumerTargetAt(M, invalid, H, 1000), 996);
        });

        it('uses the old margin when the boundary height is ' + String(invalid), function(){
            assert.strictEqual(stampMarginAt(M, M_CHAIN, invalid, 1000), M);
            assert.strictEqual(rowMarginAt(M, M_CHAIN, invalid, 1000), M);
            assert.strictEqual(consumerTargetAt(M, M_CHAIN, invalid, 1000), 996);
        });
    }
});
