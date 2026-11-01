/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 *
 * Boundary coverage for the pure retroactive witness status rules.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const {
    witnessFromPhase,
    statusRulesDigest,
} = require('../../../../../src/consensus/retroactive/witness_status.js');

const MAP_DIGEST = 'a'.repeat(64);
const NEXT_DIGEST = 'b'.repeat(64);

describe('retroactive witness status rules @regression @tier1', function () {
    it('maps every witness phase to its public status', function () {
        assert.strictEqual(witnessFromPhase('witness'), 'running');
        assert.strictEqual(witnessFromPhase('witnessed'), 'passed');
        assert.strictEqual(witnessFromPhase('final'), 'passed');
        assert.strictEqual(witnessFromPhase('diverged'), 'diverged');
    });

    it('preserves an absent phase as an absent witness status', function () {
        assert.strictEqual(witnessFromPhase(null), null);
        assert.strictEqual(witnessFromPhase(undefined), null);
    });

    it('rejects values outside the witness phase vocabulary', function () {
        for(const phase of ['bogus', '', false, 0, {}])
            assert.throws(() => witnessFromPhase(phase), /invalid retroactive replay phase/);
    });

    it('reports rules_to while witnessing an open replay marker', function () {
        for(const state of ['pending', 'replaying']){
            const marker = { state, rules_to: NEXT_DIGEST };
            assert.strictEqual(statusRulesDigest(MAP_DIGEST, marker, 'witness'), NEXT_DIGEST);
        }
    });

    it('reports the map digest outside an open witness phase', function () {
        assert.strictEqual(statusRulesDigest(MAP_DIGEST,
            { state: 'replayed', rules_to: NEXT_DIGEST }, 'witness'), MAP_DIGEST);
        assert.strictEqual(statusRulesDigest(MAP_DIGEST,
            { state: 'replaying', rules_to: NEXT_DIGEST }, 'witnessed'), MAP_DIGEST);
        assert.strictEqual(statusRulesDigest(MAP_DIGEST,
            { state: 'pending', rules_to: NEXT_DIGEST }, 'final'), MAP_DIGEST);
        assert.strictEqual(statusRulesDigest(MAP_DIGEST, null, null), MAP_DIGEST);
        assert.strictEqual(statusRulesDigest(MAP_DIGEST, undefined, 'witness'), MAP_DIGEST);
    });
});
