'use strict';

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

const assert = require('assert');
const {
    gasLessBtcSource,
    denyBoundToken,
    allowBoundToken,
    denyBoundAddress,
    allowBoundAddress,
    unboundGuard,
} = require('../../fixtures/custody_guard_scenarios');

const BTC_SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

function withoutContractIndex(binding) {
    const remainder = { ...binding };
    delete remainder.contract_index;
    return remainder;
}

function assertBoundRow(binding) {
    assert.strictEqual(Object.getPrototypeOf(binding), Object.prototype);
    assert.strictEqual(Number.isInteger(binding.contract_index), true);
    assert.strictEqual(binding.contract_index > 0, true);
}

describe('custody guard scenario fixtures', function () {
    it('provides a BTC source balance map with an explicit zero GAS balance', function () {
        assert.deepStrictEqual(gasLessBtcSource(), {
            [BTC_SOURCE]: { 1: '1000', 2: '0' },
        });
    });

    it('provides plain positive-index rows for every bound guard scenario', function () {
        [
            denyBoundToken(1),
            allowBoundToken(1),
            denyBoundAddress(BTC_SOURCE),
            allowBoundAddress(BTC_SOURCE),
        ].forEach(assertBoundRow);
    });

    it('changes only the controller index between DENY and ALLOW bindings', function () {
        const pairs = [
            [denyBoundToken(1), allowBoundToken(1)],
            [denyBoundAddress(BTC_SOURCE), allowBoundAddress(BTC_SOURCE)],
        ];

        // Route DENY versus ALLOW through contract_index, the field maybeRunCustodyGuard reads.
        for(const [denyBinding, allowBinding] of pairs) {
            assert.notStrictEqual(denyBinding.contract_index, allowBinding.contract_index);
            assert.deepStrictEqual(
                withoutContractIndex(denyBinding),
                withoutContractIndex(allowBinding)
            );
        }
    });

    it('provides exactly null for an unbound guard', function () {
        assert.strictEqual(unboundGuard(), null);
    });
});
