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
const { effectiveOfferLists } = require('../../../../src/db/orders/cross_chain_offer_lists.js');

describe('cross-chain offer list fold', function(){
    it('keeps creation lists when the offer is unedited', function(){
        assert.deepStrictEqual(
            effectiveOfferLists({ allow_list: 5, block_list: 6 }, []),
            { allow_list: 5, block_list: 6 }
        );
    });

    it('uses the latest valid edit independently for each field', function(){
        let edits = [
            { allow_list: 8, block_list: null },
            { allow_list: null, block_list: '9' },
            { allow_list: '10', block_list: null }
        ];
        assert.deepStrictEqual(
            effectiveOfferLists({ allow_list: 5, block_list: 6 }, edits),
            { allow_list: 10, block_list: 9 }
        );
    });

    it('turns a zero edit into a detached null without falling back', function(){
        assert.deepStrictEqual(
            effectiveOfferLists({ allow_list: 5, block_list: 6 }, [{ allow_list: 0, block_list: '0' }]),
            { allow_list: null, block_list: null }
        );
    });

    it('allows a non-zero edit after a zero edit', function(){
        let edits = [
            { allow_list: 0, block_list: 0 },
            { allow_list: 12, block_list: null }
        ];
        assert.deepStrictEqual(
            effectiveOfferLists({ allow_list: 5, block_list: 6 }, edits),
            { allow_list: 12, block_list: null }
        );
    });

    it('skips null, empty-string and non-numeric edit values', function(){
        let edits = [
            { allow_list: null, block_list: '' },
            { allow_list: '', block_list: 'not-a-number' }
        ];
        assert.deepStrictEqual(
            effectiveOfferLists({ allow_list: 5, block_list: 6 }, edits),
            { allow_list: 5, block_list: 6 }
        );
    });

    it('accepts a BigInt edit value', function(){
        assert.deepStrictEqual(
            effectiveOfferLists({ allow_list: 5, block_list: 6 }, [{ allow_list: 3n, block_list: undefined }]),
            { allow_list: 3, block_list: 6 }
        );
    });

    it('treats a non-array edit value as no edits', function(){
        assert.deepStrictEqual(
            effectiveOfferLists({ allow_list: 0, block_list: null }, null),
            { allow_list: 0, block_list: null }
        );
    });

    it('does not mutate the creation or edits', function(){
        let creation = { allow_list: 5, block_list: 6 };
        let edits = [{ allow_list: 8, block_list: 0 }];
        let result = effectiveOfferLists(creation, edits);
        assert.notStrictEqual(result, creation);
        assert.deepStrictEqual(creation, { allow_list: 5, block_list: 6 });
        assert.deepStrictEqual(edits, [{ allow_list: 8, block_list: 0 }]);
        assert.deepStrictEqual(result, { allow_list: 8, block_list: null });
    });
});
