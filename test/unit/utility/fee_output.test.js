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
const { findFeeOutput } = require('../../../src/utility/fee_output.js');

describe('findFeeOutput', function(){
    it('returns the first output whose address matches', function(){
        let first = { address: 'fee-address', value: 10 };
        let second = { address: 'fee-address', value: 20 };

        assert.strictEqual(findFeeOutput([first, second], 'fee-address'), first);
    });

    it('returns the first output whose scriptPubKey_address matches', function(){
        let first = { scriptPubKey_address: 'fee-address', value: 10 };
        let second = { scriptPubKey_address: 'fee-address', value: 20 };

        assert.strictEqual(findFeeOutput([first, second], 'fee-address'), first);
    });

    it('returns the earlier output when different fields match', function(){
        let earlier = { scriptPubKey_address: 'fee-address' };
        let later = { address: 'fee-address' };

        assert.strictEqual(findFeeOutput([earlier, later], 'fee-address'), earlier);
    });

    it('returns null when no output matches', function(){
        let outputs = [{ address: 'other-address' }, { scriptPubKey_address: 'another-address' }];

        assert.strictEqual(findFeeOutput(outputs, 'fee-address'), null);
    });

    it('returns null for empty or non-array inputs', function(){
        for(let outputs of [[], null, undefined, {}])
            assert.strictEqual(findFeeOutput(outputs, 'fee-address'), null);
    });
});
