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
const {
    publishedStallClass,
    isMirrorBarrierReason
} = require('../../../../src/XChainIndexer/stall_health.js');

describe('capability proof stall class @regression @tier1', function () {
    it('publishes a proof wait and escalates it after the hold ceiling', function () {
        assert.strictEqual(
            publishedStallClass('barrier_defer', 'capability_proof_unavailable', {}),
            'capability_proof_wait');
        assert.strictEqual(
            publishedStallClass('barrier_defer', 'capability_proof_unavailable', { ceilingExceeded: true }),
            'capability_proof_stuck');
    });

    it('does not classify proof availability as a mirror barrier reason', function () {
        assert.strictEqual(isMirrorBarrierReason('capability_proof_unavailable'), false);
    });

    it('never refines a wedge away', function () {
        assert.strictEqual(
            publishedStallClass('wedged', 'capability_proof_unavailable', { ceilingExceeded: true }),
            'wedged');
    });
});
