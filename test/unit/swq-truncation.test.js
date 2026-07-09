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
 **********************************************************************
 * test/unit/swq-truncation.test.js
 *
 * CONSENSUS-SAFETY GUARD for SWQ-TRUNC-1: the stake-weighted quorum predicate
 * must FAIL CLOSED on a truncated snapshot. getStakeWeightsByCapability caps its
 * result and marks the returned array `truncated`; a truncated set has silently-
 * dropped sources, so S is under-counted and a reduced 2/3 bar could finalize a
 * round a full snapshot would reject (a stake-eviction forge: one source spamming
 * >cap delegated keys to evict honest sources). This is a LOCAL guard in addition
 * to the cross-repo conformance vector (which skips when xchain-documentation is
 * not checked out). Byte-identical primitive across all vendored copies.
 */

'use strict';

const assert = require('assert');
const swq    = require('../../src/stake_weighted_quorum.js');

describe('stake_weighted_quorum fail-closed on truncation (SWQ-TRUNC-1) @regression @security', function () {

    // The same snapshot is quorate when NOT truncated (baseline sanity).
    it('a single-source snapshot is quorate when NOT truncated', function () {
        const validators = [{ pubkey: 'K1', source: 's1', weight: '10' }];
        assert.strictEqual(swq.meetsStakeThreshold(validators, ['K1']), true);
    });

    it('meetsStakeThreshold returns false when the snapshot array is marked truncated', function () {
        const validators = [{ pubkey: 'K1', source: 's1', weight: '10' }];
        validators.truncated = true;   // the set-builder marks its capped result this way
        assert.strictEqual(swq.meetsStakeThreshold(validators, ['K1']), false,
            'a truncated snapshot must never finalize (would otherwise be a reduced-quorum forge)');
    });

    it('totalStake throws on a truncated snapshot (its sum is meaningless)', function () {
        const validators = [{ pubkey: 'K1', source: 's1', weight: '10' }];
        validators.truncated = true;
        assert.throws(() => swq.totalStake(validators), /truncated/);
    });

    it('a non-truncated snapshot still sums normally (no false positive)', function () {
        const validators = [
            { pubkey: 'K1', source: 's1', weight: '10' },
            { pubkey: 'K2', source: 's2', weight: '5' }
        ];
        assert.strictEqual(String(swq.totalStake(validators)), '15');
    });

    it('a falsy/absent truncated marker does not trip the guard', function () {
        const validators = [{ pubkey: 'K1', source: 's1', weight: '10' }];
        validators.truncated = false;
        assert.strictEqual(swq.meetsStakeThreshold(validators, ['K1']), true);
    });
});
