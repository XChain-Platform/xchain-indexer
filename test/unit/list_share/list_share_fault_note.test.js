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

function halt(reason) {
    return Object.assign(new Error(reason), { name: 'ListShareHaltError', reason });
}

function context() {
    return Object.assign({
        config: { BLOCK_CHECK_INTERVAL: 1 },
        util: { logError: sinon.stub() },
        stallReason: 'kept',
        stallClearsAt: 1234
    }, blockFaults);
}

describe('list-share block fault classification @regression @tier1', function () {

    afterEach(function () { sinon.restore(); });

    it('maps a missing snapshot to a mirror barrier with no clear instant', function () {
        const warn = sinon.stub(console, 'warn');
        const ctx = context();

        ctx.noteBlockFault(halt('SNAPSHOT_ABSENT'), 500);

        assert.strictEqual(ctx.stallReason, 'list_share_snapshot_barrier');
        assert.strictEqual(ctx.stallClearsAt, null);
        assert.strictEqual(ctx.util.logError.callCount, 0);
        assert.strictEqual(warn.callCount, 1);
        assert.match(warn.firstCall.args[0], /block 500/);
    });

    it('maps every other list-share halt to a host fault with no clear instant', function () {
        const error = sinon.stub(console, 'error');
        const ctx = context();

        ctx.noteBlockFault(halt('QUORUM'), 501);

        assert.strictEqual(ctx.stallReason, 'list_share_halt');
        assert.strictEqual(ctx.stallClearsAt, null);
        assert.strictEqual(ctx.util.logError.callCount, 0);
        assert.strictEqual(error.callCount, 1);
        assert.strictEqual(error.firstCall.args[0],
            'LIST SHARE HALT at block 501: QUORUM HALTING block processing ' +
            '(not committing; a missing or altered list version would fork)');
    });

    it('leaves stall state untouched for an unrelated error', function () {
        const ctx = context();
        const unrelated = new Error('unrelated');

        ctx.noteBlockFault(unrelated, 502);

        assert.strictEqual(ctx.stallReason, 'kept');
        assert.strictEqual(ctx.stallClearsAt, 1234);
        assert.strictEqual(ctx.util.logError.callCount, 1);
        assert.strictEqual(ctx.util.logError.firstCall.args[1], unrelated);
    });
});
