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
    nextBarrierHold,
    stallClassOf,
    stallWedged
} = require('../../../../src/XChainIndexer/stall_health.js');
const { BRIDGE_PROOF_BARRIER } = require('../../../../src/consensus/bridge_proof_client/stall.js');

const NOW = 1800000000000;

describe('bridge proof stall class @regression @tier1', function () {
    it('remains a non-wedging wait outside the mirror hold', function () {
        assert.strictEqual(stallClassOf(BRIDGE_PROOF_BARRIER, NOW - 99999999, 1, NOW),
            'bridge_proof_wait');
        assert.strictEqual(stallWedged(BRIDGE_PROOF_BARRIER, NOW - 99999999, 1, NOW), false);
        assert.strictEqual(nextBarrierHold(null, 700, BRIDGE_PROOF_BARRIER, null, NOW), null);
    });
});
