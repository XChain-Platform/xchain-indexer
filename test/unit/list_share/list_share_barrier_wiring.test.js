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
const gateRegistry = require('../../../src/consensus/gate_registry.js');
const mirrorBarriers = require('../../../src/XChainIndexer/mirror_barriers.js');
const priceBarriers = require('../../../src/XChainIndexer/price_barriers.js');
const blockFaults = require('../../../src/XChainIndexer/block_faults.js');

function barrierContext(overrides = {}) {
    return Object.assign({
        config: { NETWORK: 'regtest', COIN: 'BTC' },
        hubDbSync: { waitForListShareSync: sinon.stub().resolves() },
        priceSyncTimeoutMs: 4321,
        mirrorAdmissionActiveAt: sinon.stub().returns(true),
        stallReason: 'kept',
        stallClearsAt: 1234
    }, mirrorBarriers, overrides);
}

function faultContext() {
    return Object.assign({
        config: { BLOCK_CHECK_INTERVAL: 1 },
        util: { logError: sinon.stub() },
        stallReason: 'kept',
        stallClearsAt: 1234
    }, blockFaults);
}

function halt(reason) {
    return Object.assign(new Error(reason), { name: 'ListShareHaltError', reason });
}

describe('list-share block-loop barrier wiring @regression @tier1', function () {
    beforeEach(function () {
        sinon.stub(gateRegistry, 'activeAt').returns(true);
    });

    afterEach(function () {
        sinon.restore();
    });

    it('chains the list-share barrier immediately after the policy barrier', async function () {
        const calls = [];
        const ctx = { evaluatePriceBarrier: sinon.stub().returns(false) };
        for (const name of [
            'deferOnPriceSync', 'deferOnOracleSync', 'deferOnMatchSync', 'deferOnCallSync',
            'deferOnBridgeSync', 'deferOnPolicySync', 'deferOnDirectCallPresence',
            'deferOnAnchorAttestSync', 'deferOnAttestResponseSync', 'deferOnSnapshotSync'
        ]) {
            ctx[name] = sinon.stub().callsFake(async function () {
                calls.push(name);
                return false;
            });
        }
        ctx.deferOnListShareSync = sinon.stub().callsFake(async function () {
            calls.push('deferOnListShareSync');
            return true;
        });

        assert.strictEqual(await priceBarriers.deferOnSyncBarriers.call(ctx, 500, 1000, [], null), true);
        assert.deepStrictEqual(calls.slice(-2), ['deferOnPolicySync', 'deferOnListShareSync']);
        sinon.assert.notCalled(ctx.deferOnDirectCallPresence);
    });

    it('does not wait without both consumer gates armed', async function () {
        gateRegistry.activeAt.returns(false);
        const consumerOff = barrierContext();
        assert.strictEqual(await consumerOff.deferOnListShareSync(500, 1000), false);
        sinon.assert.notCalled(consumerOff.hubDbSync.waitForListShareSync);

        gateRegistry.activeAt.returns(true);
        const admissionOff = barrierContext({ mirrorAdmissionActiveAt: sinon.stub().returns(false) });
        assert.strictEqual(await admissionOff.deferOnListShareSync(500, 1000), false);
        sinon.assert.notCalled(admissionOff.hubDbSync.waitForListShareSync);
    });

    it('does not wait without a hub mirror', async function () {
        const ctx = barrierContext({ hubDbSync: null });

        assert.strictEqual(await ctx.deferOnListShareSync(500, 1000), false);
        sinon.assert.notCalled(gateRegistry.activeAt);
        sinon.assert.notCalled(ctx.mirrorAdmissionActiveAt);
    });

    it('returns false after an armed wait is satisfied', async function () {
        const ctx = barrierContext();

        assert.strictEqual(await ctx.deferOnListShareSync(500, 1000), false);
        sinon.assert.calledOnceWithExactly(gateRegistry.activeAt,
            'list_share_consumer_activation.LIST_SHARE_CONSUMER_ACTIVATION',
            'regtest', 'BTC', 500, null);
        sinon.assert.calledOnceWithExactly(ctx.hubDbSync.waitForListShareSync, 4321, 500);
        assert.strictEqual(ctx.stallReason, 'kept');
        assert.strictEqual(ctx.stallClearsAt, 1234);
    });

    it('sets a height-keyed barrier after an armed wait is rejected', async function () {
        const wait = sinon.stub().rejects(new Error('behind'));
        const warn = sinon.stub(console, 'warn');
        const ctx = barrierContext({ hubDbSync: { waitForListShareSync: wait } });

        assert.strictEqual(await ctx.deferOnListShareSync(501, 1001), true);
        sinon.assert.calledOnceWithExactly(wait, 4321, 501);
        assert.strictEqual(ctx.stallReason, 'list_share_sync_barrier');
        assert.strictEqual(ctx.stallClearsAt, null);
        sinon.assert.calledOnce(warn);
    });

    it('classifies list-share halts and ignores other errors', function () {
        const warn = sinon.stub(console, 'warn');
        const error = sinon.stub(console, 'error');
        const snapshot = faultContext();
        const altered = faultContext();
        const unrelated = faultContext();

        snapshot.noteBlockFault(halt('SNAPSHOT_ABSENT'), 600);
        assert.strictEqual(snapshot.stallReason, 'list_share_snapshot_barrier');
        assert.strictEqual(snapshot.stallClearsAt, null);
        sinon.assert.notCalled(snapshot.util.logError);

        altered.noteBlockFault(halt('ALTERED_VERSION'), 601);
        assert.strictEqual(altered.stallReason, 'list_share_halt');
        assert.strictEqual(altered.stallClearsAt, null);
        sinon.assert.notCalled(altered.util.logError);

        unrelated.noteBlockFault(new Error('other'), 602);
        assert.strictEqual(unrelated.stallReason, 'kept');
        assert.strictEqual(unrelated.stallClearsAt, 1234);
        sinon.assert.calledOnce(unrelated.util.logError);
        sinon.assert.calledOnce(warn);
        sinon.assert.calledOnce(error);
    });
});
