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
 *********************************************************************/

// The remote-token pin barrier: the block-loop member, its place in the chain, and the
// HubDbSync height wait it rides.

'use strict';

const assert = require('assert');
const sinon = require('sinon');
const gateRegistry = require('../../../src/consensus/gate_registry.js');
const mirrorBarriers = require('../../../src/XChainIndexer/mirror_barriers.js');
const priceBarriers = require('../../../src/XChainIndexer/price_barriers.js');
const watermarkMethods = require('../../../src/hub/hub_db_sync/watermarks.js');
const remoteTokenMethods = require('../../../src/hub/hub_db_sync/barriers/remote_token.js');
const {
    REMOTE_TOKEN_ADMISSION_KEY,
    REMOTE_TOKEN_RETRY_STALL_REASON
} = require('../../../src/actions/cross_chain_remote_token');
const { isMirrorBarrierReason } = require('../../../src/XChainIndexer/stall_health.js');

const SWAP = [{ data: 'SWAP|0|LTC|BARR|10||BTC|XT|5||addr|||x' }];

function context(overrides = {}) {
    return Object.assign({
        config: { NETWORK: 'regtest', COIN: 'LTC' },
        hubDbSync: { waitForRemoteTokenSync: sinon.stub().resolves(true) },
        hubDb: null,
        priceSyncTimeoutMs: 4321,
        remoteTokenBarrierForceBlock: null,
        stallReason: 'kept',
        stallClearsAt: 1234
    }, mirrorBarriers, overrides);
}

const ARM = 'XC_REMOTE_TOKEN_ADMISSION_REGTEST_ACTIVATION';

describe('remote-token pin barrier, block-loop member @regression @tier1', function () {
    beforeEach(() => { process.env[ARM] = 'armed'; });
    afterEach(() => { delete process.env[ARM]; sinon.restore(); });

    it('does nothing on a regtest venue that has not set the variable', async function () {
        delete process.env[ARM];
        const ctx = context({ remoteTokenBarrierForceBlock: 500 });
        assert.strictEqual(await ctx.deferOnRemoteTokenSync(500), false);
        assert.strictEqual(ctx.hubDbSync.waitForRemoteTokenSync.callCount, 0);
        assert.strictEqual(ctx.remoteTokenBarrierSkipped, false);
    });

    it('does nothing below the activation, and records no skip', async function () {
        const ctx = context({ config: { NETWORK: 'testnet', COIN: 'LTC' }, remoteTokenBarrierForceBlock: 500 });
        assert.strictEqual(await ctx.deferOnRemoteTokenSync(500), false);
        assert.strictEqual(ctx.hubDbSync.waitForRemoteTokenSync.callCount, 0);
        assert.strictEqual(ctx.remoteTokenBarrierSkipped, false);
    });

    it('skips a block on its first attempt and records the skip for the read to find', async function () {
        const ctx = context();
        assert.strictEqual(await ctx.deferOnRemoteTokenSync(500), false);
        assert.strictEqual(ctx.hubDbSync.waitForRemoteTokenSync.callCount, 0);
        assert.strictEqual(ctx.remoteTokenBarrierSkipped, true);
        assert.strictEqual(ctx.remoteTokenBarrierBlock, 500);
    });

    it('waits on the retry of a block whose admitted read failed it closed', async function () {
        const ctx = context({ remoteTokenBarrierForceBlock: 500 });
        assert.strictEqual(await ctx.deferOnRemoteTokenSync(500), false);
        assert.deepStrictEqual(ctx.hubDbSync.waitForRemoteTokenSync.firstCall.args, [4321, 500]);
        assert.strictEqual(ctx.remoteTokenBarrierSkipped, false);
        const other = context({ remoteTokenBarrierForceBlock: 499 });
        await other.deferOnRemoteTokenSync(500);
        assert.strictEqual(other.hubDbSync.waitForRemoteTokenSync.callCount, 0, 'the force is one block, not a latch');
    });

    it('defers with a height-keyed stall when the wait rejects', async function () {
        sinon.stub(console, 'warn');
        const ctx = context({ hubDbSync: { waitForRemoteTokenSync: sinon.stub().rejects(new Error('behind')) }, remoteTokenBarrierForceBlock: 501 });
        assert.strictEqual(await ctx.deferOnRemoteTokenSync(501), true);
        assert.strictEqual(REMOTE_TOKEN_RETRY_STALL_REASON, 'remote_token_retry_barrier');
        assert.strictEqual(ctx.stallReason, REMOTE_TOKEN_RETRY_STALL_REASON);
        assert.strictEqual(isMirrorBarrierReason(ctx.stallReason), true);
        assert.strictEqual(ctx.stallClearsAt, null);
    });
});

describe('remote-token pin barrier, block-loop wiring @regression @tier1', function () {
    beforeEach(() => { process.env[ARM] = 'armed'; });
    afterEach(() => { delete process.env[ARM]; sinon.restore(); });

    it('uses the direct-hub-DB floor wait when there is no mirror client', async function () {
        const direct = sinon.stub().resolves();
        const ctx = context({ hubDbSync: null, hubDb: {}, waitForDirectRemoteTokenPresence: direct, remoteTokenBarrierForceBlock: 502 });
        assert.strictEqual(await ctx.deferOnRemoteTokenSync(502), false);
        assert.deepStrictEqual(direct.firstCall.args, [502]);
    });

    it('neither waits nor records a skip with no hub database at all', async function () {
        const ctx = context({ hubDbSync: null, hubDb: null, remoteTokenBarrierForceBlock: 503 });
        assert.strictEqual(await ctx.deferOnRemoteTokenSync(503), false);
        assert.strictEqual(ctx.remoteTokenBarrierSkipped, false);
    });

    it('chains immediately after the list-share barrier', async function () {
        const calls = [];
        const ctx = { evaluatePriceBarrier: sinon.stub().returns(false) };
        for (const name of ['deferOnPriceSync', 'deferOnPriceLandingSync', 'deferOnOracleSync', 'deferOnMatchSync',
            'deferOnCallSync', 'deferOnBridgeSync', 'deferOnPolicySync', 'deferOnListShareSync', 'deferOnRemoteTokenSync',
            'deferOnDirectCallPresence', 'deferOnAnchorAttestSync', 'deferOnAttestResponseSync', 'deferOnSnapshotSync'])
            ctx[name] = async (...args) => { calls.push([name, args]); return false; };
        await priceBarriers.deferOnSyncBarriers.call(ctx, 9, 99, SWAP, null);
        const at = calls.findIndex(c => c[0] === 'deferOnRemoteTokenSync');
        assert.strictEqual(calls[at - 1][0], 'deferOnListShareSync');
        assert.deepStrictEqual(calls[at][1], [9]);
    });
});

describe('remote-token pin barrier, HubDbSync height wait @regression @tier1', function () {
    function sync(heights) {
        const s = Object.assign({
            enabled: true, coin: 'LTC', network: 'regtest',
            heightWatermarks: heights || {}, _heightShortfalls: {},
            remoteTokenBootstrapped: false, _remoteTokenWaiters: [], _bootstrapDrained: false
        }, watermarkMethods, remoteTokenMethods);
        return s;
    }

    it('holds until the table is drained, with no empty-mirror escape', async function () {
        const s = sync({ remote_token_snapshots: { LTC: 1000 } });
        assert.strictEqual(s.remoteTokenSyncSatisfied(100), false);
        await s.refreshRemoteTokenSyncState(false);
        assert.strictEqual(s.remoteTokenSyncSatisfied(100), false, 'a live row must not arm the barrier');
        await s.refreshRemoteTokenSyncState(true);
        assert.strictEqual(s.remoteTokenSyncSatisfied(100), true);
    });

    it('opens at B only when the watermark reaches B minus the table margin', async function () {
        // LTC's chain margin (14 blocks on remote_token_snapshots) is active from genesis on regtest.
        const s = sync({ remote_token_snapshots: { LTC: 95 } });
        await s.refreshRemoteTokenSyncState(true);
        assert.strictEqual(s.remoteTokenSyncSatisfied(109), true);
        assert.strictEqual(s.remoteTokenSyncSatisfied(110), false);
        assert.strictEqual(s.remoteTokenSyncSatisfied(111), false);
    });

    it('reads its own table and chain only', async function () {
        const s = sync({ list_snapshots: { LTC: 5000 }, remote_token_snapshots: { BTC: 5000 } });
        await s.refreshRemoteTokenSyncState(true);
        assert.strictEqual(s.remoteTokenSyncSatisfied(100), false);
    });

    it('releases a waiter on a height advance and rejects one that stays short', async function () {
        const s = sync({ remote_token_snapshots: { LTC: 10 } });
        await s.refreshRemoteTokenSyncState(true);
        s.releaseHeightWaiters = function () { this.releaseRemoteTokenWaiters(); };
        const waiting = s.waitForRemoteTokenSync(5000, 100);
        s.noteHeights({ remote_token_snapshots: { LTC: 96 } });
        assert.strictEqual(await waiting, true);
        await assert.rejects(s.waitForRemoteTokenSync(20, 500),
            /remote token sync barrier timed out .* waiting for block_height 500 \(admission height remote_token_snapshots\.LTC at 96, needs 486\)/);
        assert.strictEqual(s._remoteTokenWaiters.length, 0);
    });

    it('resolves at once with sync disabled', async function () {
        const s = sync({});
        s.enabled = false;
        assert.strictEqual(await s.waitForRemoteTokenSync(10, 100), true);
    });

    it('is armed exactly where the registry row is', function () {
        assert.strictEqual(gateRegistry.activeAt(REMOTE_TOKEN_ADMISSION_KEY, 'regtest', 'LTC', 0, null), false);
        process.env[ARM] = 'armed';
        try { assert.strictEqual(gateRegistry.activeAt(REMOTE_TOKEN_ADMISSION_KEY, 'regtest', 'LTC', 0, null), true); }
        finally { delete process.env[ARM]; }
        // The v0.24.0 cut arms LTC:testnet at 4927400.
        assert.strictEqual(gateRegistry.activeAt(REMOTE_TOKEN_ADMISSION_KEY, 'testnet', 'LTC', 4927399, null), false);
        assert.strictEqual(gateRegistry.activeAt(REMOTE_TOKEN_ADMISSION_KEY, 'testnet', 'LTC', 4927400, null), true);
        assert.strictEqual(gateRegistry.activeAt(REMOTE_TOKEN_ADMISSION_KEY, 'mainnet', 'LTC', 9999999998, null), false);
    });
});
