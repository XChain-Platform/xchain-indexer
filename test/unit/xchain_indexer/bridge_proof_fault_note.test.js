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
const sinon = require('sinon');
const blockFaults = require('../../../src/XChainIndexer/block_faults.js');
const { stallClassOf, stallWedged, nextBarrierHold } = require('../../../src/XChainIndexer/stall_health.js');
const { BRIDGE_PROOF_BARRIER, BridgeProofUnavailableError } =
    require('../../../src/consensus/bridge_proof_client/stall.js');

// A plain object carrying the block-fault methods, as the list-share fault tests build it.
function context() {
    return Object.assign({
        config: { BLOCK_CHECK_INTERVAL: 1 },
        util: { logError: sinon.stub() },
        stallReason: 'kept',
        stallClearsAt: 1234
    }, blockFaults);
}

describe('bridge proof block fault classification @regression @tier1', function () {

    const NOW = 1000000000;
    const GRACE = 120000;

    afterEach(function () { sinon.restore(); });

    it('defers a real bridge proof error under the one reason the health verdicts match', function () {
        const ctx = context();
        const err = new BridgeProofUnavailableError('ab'.repeat(32), 'test');

        ctx.noteBlockFault(err, 700);

        assert.strictEqual(ctx.stallReason, BRIDGE_PROOF_BARRIER);
        assert.strictEqual(ctx.stallReason, err.stallReason);
        assert.strictEqual(ctx.stallClearsAt, null);
        assert.strictEqual(ctx.util.logError.callCount, 0);
    });

    it('grades that deferred block a bridge proof wait, never a wedge, with no barrier hold', function () {
        const ctx = context();

        ctx.noteBlockFault(new BridgeProofUnavailableError('cd'.repeat(32), 'test'), 701);

        // A commit ten minutes old would read wedged for any other reason.
        assert.strictEqual(stallClassOf(ctx.stallReason, NOW - 600000, GRACE, NOW, null), 'bridge_proof_wait');
        assert.strictEqual(stallWedged(ctx.stallReason, NOW - 600000, GRACE, NOW, null), false);
        assert.strictEqual(nextBarrierHold(null, 701, ctx.stallReason, null, NOW), null);
    });
});
