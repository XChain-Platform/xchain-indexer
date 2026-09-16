// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The hub config overlay poll's cursor edge cases: a regressed seq-only hub, an older hub
// without a watermark, an equal non-zero watermark (same-second redelivery), and no
// re-merge on an unchanged seq.
// Part of the hub config overlay suite; see ../config.test.js.

const assert = require('assert');
const sinon = require('sinon');
const { makeIndexer, restoreOverlay } = require('./helpers/overlay_indexer.js');

let indexer;

describe('XChainIndexer hub config overlay', function () {
    afterEach(restoreOverlay);

    it('seq-only hub (no watermark): a regressed seq is a cursor reset, not a stall', async function () {
        indexer = makeIndexer();
        let clock = sinon.useFakeTimers();
        let mergeSpy = sinon.spy(indexer, 'mergeHubParams');
        let errStub  = sinon.stub(console, 'error');
        try {
            let hubStub = { configEnabled: true, getAllConfigs:sinon.stub() };
            hubStub.getAllConfigs.onCall(0).resolves({
                configs: { bitcoin: { regtest: { 'xchain-indexer': {} } } }, seq: 40
            });
            indexer.hubClient = hubStub;
            await indexer.applyHubConfigOverlay();
            assert.strictEqual(indexer.lastHubConfigSeq, 40);
            mergeSpy.resetHistory();

            process.env.HUB_CONFIG_POLL_INTERVAL_MS = '60000';
            indexer.startHubConfigPolling();

            hubStub.getAllConfigs.onCall(1).resolves({
                configs: { bitcoin: { regtest: { 'xchain-indexer': {} } } }, seq: 7
            });
            await clock.tickAsync(60000);
            assert.strictEqual(mergeSpy.called, true, 'a regressed seq-only hub must still re-apply');
            assert.strictEqual(indexer.lastHubConfigSeq, 7, 'the seq cursor must adopt the served value');
        } finally {
            if(indexer._hubConfigPollTimer) clearInterval(indexer._hubConfigPollTimer);
            errStub.restore();
            mergeSpy.restore();
            clock.restore();
            delete process.env.HUB_CONFIG_POLL_INTERVAL_MS;
        }
    });
});

describe('XChainIndexer hub config overlay', function () {
    afterEach(restoreOverlay);

    it('older hub without watermark still advances on seq alone (back-compat)', async function () {
        indexer = makeIndexer();
        let clock = sinon.useFakeTimers();
        let mergeSpy = sinon.spy(indexer, 'mergeHubParams');
        try {
            let hubStub = { configEnabled: true, getAllConfigs:sinon.stub() };
            hubStub.getAllConfigs.onCall(0).resolves({
                configs: { bitcoin: { regtest: { 'xchain-indexer': {} } } }, seq: 5   // no watermark field
            });
            indexer.hubClient = hubStub;
            await indexer.applyHubConfigOverlay();
            assert.strictEqual(indexer.lastHubConfigSeq, 5);
            assert.strictEqual(indexer.lastHubConfigWatermark, 0, 'missing watermark defaults to 0');
            mergeSpy.resetHistory();

            process.env.HUB_CONFIG_POLL_INTERVAL_MS = '60000';
            indexer.startHubConfigPolling();

            hubStub.getAllConfigs.onCall(1).resolves({
                configs: { bitcoin: { regtest: { 'xchain-indexer': {} } } }, seq: 6   // still no watermark
            });
            await clock.tickAsync(60000);
            assert.strictEqual(mergeSpy.called, true, 'seq advance alone must still re-apply');
            assert.strictEqual(indexer.lastHubConfigSeq, 6);
        } finally {
            if(indexer._hubConfigPollTimer) clearInterval(indexer._hubConfigPollTimer);
            mergeSpy.restore();
            clock.restore();
            delete process.env.HUB_CONFIG_POLL_INTERVAL_MS;
        }
    });
});

describe('XChainIndexer hub config overlay', function () {
    afterEach(restoreOverlay);

    it('poll re-applies on an EQUAL non-zero watermark (same-second redelivery, seq stuck at 0)', async function () {
        // The hub reads its config watermark BEFORE the rows, so a write stamped in the
        // same epoch-second as the returned watermark rides the full config tree while the
        // watermark stays equal. A strict `>` gate would skip it forever on a seq-0
        // standalone hub; an equal non-zero watermark must be treated as re-apply-eligible
        // (the merge is idempotent).
        indexer = makeIndexer();
        let clock = sinon.useFakeTimers();
        let mergeSpy = sinon.spy(indexer, 'mergeHubParams');
        try {
            let hubStub = { configEnabled: true, getAllConfigs:sinon.stub() };
            // Startup: seq 0, watermark 1000.
            hubStub.getAllConfigs.onCall(0).resolves({
                configs: { bitcoin: { regtest: { 'xchain-indexer': {} } } }, seq: 0, watermark: 1000
            });
            indexer.hubClient = hubStub;
            await indexer.applyHubConfigOverlay();
            assert.strictEqual(indexer.lastHubConfigWatermark, 1000);
            mergeSpy.resetHistory();

            process.env.HUB_CONFIG_POLL_INTERVAL_MS = '60000';
            indexer.startHubConfigPolling();

            // Tick 1: same non-zero watermark 1000 (a same-second redelivered write) -> must re-apply.
            hubStub.getAllConfigs.onCall(1).resolves({
                configs: { bitcoin: { regtest: { 'xchain-indexer': {} } } }, seq: 0, watermark: 1000
            });
            await clock.tickAsync(60000);
            assert.strictEqual(mergeSpy.called, true, 'equal non-zero watermark must re-apply (redelivery)');
            assert.strictEqual(indexer.lastHubConfigWatermark, 1000, 'watermark bookkeeping stays put');
        } finally {
            if(indexer._hubConfigPollTimer) clearInterval(indexer._hubConfigPollTimer);
            mergeSpy.restore();
            clock.restore();
            delete process.env.HUB_CONFIG_POLL_INTERVAL_MS;
        }
    });
});

describe('XChainIndexer hub config overlay', function () {
    afterEach(restoreOverlay);

    it('poll does NOT re-merge every tick on a seq-only hub with no watermark (no regression)', async function () {
        // Missing watermark defaults to 0. The equal-watermark redelivery path is gated on
        // watermark > 0, so a seq-only hub whose seq is unchanged must stay a no-op and not
        // re-merge the tree every poll.
        indexer = makeIndexer();
        let clock = sinon.useFakeTimers();
        let mergeSpy = sinon.spy(indexer, 'mergeHubParams');
        try {
            let hubStub = { configEnabled: true, getAllConfigs:sinon.stub() };
            hubStub.getAllConfigs.onCall(0).resolves({
                configs: { bitcoin: { regtest: { 'xchain-indexer': {} } } }, seq: 5   // no watermark field
            });
            indexer.hubClient = hubStub;
            await indexer.applyHubConfigOverlay();
            assert.strictEqual(indexer.lastHubConfigWatermark, 0);
            mergeSpy.resetHistory();

            process.env.HUB_CONFIG_POLL_INTERVAL_MS = '60000';
            indexer.startHubConfigPolling();

            // Tick: seq unchanged at 5, still no watermark -> must NOT re-merge.
            hubStub.getAllConfigs.onCall(1).resolves({
                configs: { bitcoin: { regtest: { 'xchain-indexer': {} } } }, seq: 5   // still no watermark
            });
            await clock.tickAsync(60000);
            assert.strictEqual(mergeSpy.called, false, 'seq-only hub with no watermark must not re-merge on an unchanged seq');
        } finally {
            if(indexer._hubConfigPollTimer) clearInterval(indexer._hubConfigPollTimer);
            mergeSpy.restore();
            clock.restore();
            delete process.env.HUB_CONFIG_POLL_INTERVAL_MS;
        }
    });
});
