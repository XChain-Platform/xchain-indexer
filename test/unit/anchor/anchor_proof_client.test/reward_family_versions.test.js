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
 **********************************************************************
 * test/unit/anchor/anchor_proof_client.test/reward_family_versions.test.js
 *
 * The gate-free family lookup: a fresh copy of a family's wire versions, with the
 * pre-restart bytes 6 and 7 removed only when the caller passes exactly true.
 */
'use strict';

const assert = require('assert');
const binding = require('../../../../src/consensus/doge_peer_clients/anchor_proof_client/binding.js');

const f = binding.rewardFamilyVersions;

describe('rewardFamilyVersions', function () {
    it('returns the full list for each family by default', function () {
        assert.deepStrictEqual(f('archive'), [1, 6]);
        assert.deepStrictEqual(f('bundle'), [0, 3, 7]);
    });

    it('drops bytes 6 and 7 when legacyDropped is true', function () {
        assert.deepStrictEqual(f('archive', { legacyDropped: true }), [1]);
        assert.deepStrictEqual(f('bundle', { legacyDropped: true }), [0, 3]);
    });

    it('keeps bytes 6 and 7 for a legacyDropped that is not exactly true', function () {
        assert.deepStrictEqual(f('bundle', { legacyDropped: 1 }), [0, 3, 7]);
        assert.deepStrictEqual(f('archive', { legacyDropped: 'true' }), [1, 6]);
        assert.deepStrictEqual(f('archive', { legacyDropped: false }), [1, 6]);
    });

    it('returns null for an unknown or inherited family name', function () {
        assert.strictEqual(f('chain'), null);
        assert.strictEqual(f('constructor'), null);
        assert.strictEqual(f('toString'), null);
        assert.strictEqual(f(undefined), null);
    });

    it('returns a copy that can be mutated without changing the map', function () {
        f('archive').push(9);
        f('bundle', { legacyDropped: true }).push(9);
        assert.deepStrictEqual(binding.REWARD_FAMILY_VERSIONS, { archive: [1, 6], bundle: [0, 3, 7] });
    });

    it('leaves 6 and 7 in ATTESTED_VERSIONS', function () {
        assert.deepStrictEqual(binding.ATTESTED_VERSIONS, [0, 1, 3, 4, 5, 6, 7]);
    });
});
