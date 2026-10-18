/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * ATTEST v0 per-block admission caps.
 *
 * The cap values are consensus-visible and asserted explicitly: changing one
 * is a consensus event, not a tuning knob.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const arc    = require('../../../src/actions/attest/gates/attest_request_cap_gate.js');

describe('ATTEST per-block admission caps (spec §11.1) @regression', function () {
    describe('ATTEST_REQUEST_CAPS', function () {

        it('pins the consensus cap values', function () {
            // Changing either number changes which requests are admitted, so it is
            // a consensus event and must fail this test first.
            assert.strictEqual(arc.ATTEST_REQUEST_CAPS.perContract, 2);
            assert.strictEqual(arc.ATTEST_REQUEST_CAPS.perBlock, 10);
        });

        it('keeps the per-contract cap below the per-block ceiling', function () {
            // If one contract could fill the block the per-block cap would be the only
            // rule that ever fired and the anti-starvation half would be decorative.
            assert.ok(arc.ATTEST_REQUEST_CAPS.perContract < arc.ATTEST_REQUEST_CAPS.perBlock);
        });
    });
});
