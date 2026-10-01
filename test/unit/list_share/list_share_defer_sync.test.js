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
const mirrorBarriers = require('../../../src/XChainIndexer/mirror_barriers.js');

function context(overrides = {}) {
    return Object.assign({
        config: { NETWORK: 'regtest', COIN: 'BTC' },
        hubDbSync: { waitForListShareSync: sinon.stub().resolves() },
        priceSyncTimeoutMs: 4321,
        mirrorAdmissionActiveAt() { return true; },
        stallReason: 'kept',
        stallClearsAt: 1234
    }, mirrorBarriers, overrides);
}

describe('list-share mirror sync barrier @regression @tier1', function () {

    afterEach(function () { sinon.restore(); });

    it('does not wait while the list-share consumer gate is unarmed', async function () {
        const ctx = context({ config: { NETWORK: 'testnet', COIN: 'BTC' } });

        assert.strictEqual(await ctx.deferOnListShareSync(500, 1000), false);
        assert.strictEqual(ctx.hubDbSync.waitForListShareSync.callCount, 0);
    });

    it('does not wait while mirror admission is inactive', async function () {
        const ctx = context({ mirrorAdmissionActiveAt() { return false; } });

        assert.strictEqual(await ctx.deferOnListShareSync(500, 1000), false);
        assert.strictEqual(ctx.hubDbSync.waitForListShareSync.callCount, 0);
    });

    it('returns false without a hub mirror', async function () {
        const ctx = context({ hubDbSync: null });

        assert.strictEqual(await ctx.deferOnListShareSync(500, 1000), false);
        assert.strictEqual(ctx.stallReason, 'kept');
        assert.strictEqual(ctx.stallClearsAt, 1234);
    });

    it('leaves stall state untouched when the armed wait resolves', async function () {
        const ctx = context();

        assert.strictEqual(await ctx.deferOnListShareSync(500, 1000), false);
        assert.deepStrictEqual(ctx.hubDbSync.waitForListShareSync.firstCall.args, [4321, 500]);
        assert.strictEqual(ctx.stallReason, 'kept');
        assert.strictEqual(ctx.stallClearsAt, 1234);
    });

    it('sets a height-keyed stall when the armed wait rejects', async function () {
        const error = new Error('behind');
        const wait = sinon.stub().rejects(error);
        const warn = sinon.stub(console, 'warn');
        const ctx = context({ hubDbSync: { waitForListShareSync: wait } });

        assert.strictEqual(await ctx.deferOnListShareSync(501, 1001), true);
        assert.deepStrictEqual(wait.firstCall.args, [4321, 501]);
        assert.strictEqual(ctx.stallReason, 'list_share_sync_barrier');
        assert.strictEqual(ctx.stallClearsAt, null);
        assert.strictEqual(warn.callCount, 1);
        assert.strictEqual(warn.firstCall.args[0], 'Deferring block 501 (list share sync)');
    });
});
