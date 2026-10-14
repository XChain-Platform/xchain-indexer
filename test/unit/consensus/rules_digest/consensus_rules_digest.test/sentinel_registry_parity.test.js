/*
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 */

'use strict';

const assert = require('assert');

const crd      = require('../../../../../src/consensus_rules_digest.js');
const core     = require('../../../../../src/protocol_changes/core.js');
const registry = require('../../../../../src/consensus/gate_registry');

describe('consensus rules digest far-future sentinel', function () {
    // Pin the digest's own spelling of the sentinel to the registry's (the digest is a
    // carrier-pinned byte twin, so it restates the value rather than requiring it).
    it('equals the registry UNARMED sentinel, so a re-spelled UNARMED cannot leave parked rows reported active', function () {
        assert.strictEqual(typeof crd.FAR_FUTURE_HEIGHT_SENTINEL, 'number');
        assert.strictEqual(crd.FAR_FUTURE_HEIGHT_SENTINEL, core.UNARMED,
            'consensus_rules_digest.js FAR_FUTURE_HEIGHT_SENTINEL drifted from protocol_changes/core.js UNARMED; ' +
            'activeGatesAt would report every UNARMED row below the old value as active');
        assert.strictEqual(crd.FAR_FUTURE_HEIGHT_SENTINEL, registry.UNARMED,
            'the gate registry the digest reads exports a different UNARMED than the digest skips on');
    });
});
