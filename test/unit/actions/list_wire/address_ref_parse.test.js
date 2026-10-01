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
    addressRefId,
    isAddressRefItem
} = require('../../../../src/actions/list/address_ref_parse.js');

describe('list address reference parser', function () {
    it('returns the canonical positive integer digits without numeric coercion', function () {
        assert.strictEqual(addressRefId('^7'), '7');
        assert.strictEqual(addressRefId('^99999999999999999999'), '99999999999999999999');
    });

    it('rejects non-canonical caret references and non-reference values', function () {
        let invalid = [
            '^007', '^0', '^', '^ 1', '^1.5', '^0x10', '^-1', '^1e3', '^abc',
            '7', 'bc1qxyz', '', null, 7, undefined
        ];
        for(let item of invalid)
            assert.strictEqual(addressRefId(item), null);
    });

    it('identifies exactly the items accepted by addressRefId', function () {
        assert.strictEqual(isAddressRefItem('^12'), true);
        assert.strictEqual(isAddressRefItem('^012'), false);
    });
});
