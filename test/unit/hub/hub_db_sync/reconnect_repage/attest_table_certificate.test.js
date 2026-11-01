// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// After a hub reconnect the full bootstrap re-pages price_snapshots, the heaviest table, last.
// The anchor-reward and ATTEST-response barriers read only their own tables, so once those
// tables have drained on the new connection their per-table certificate must open them;
// waiting on the global watermark held every BTC block for the whole price re-page. Each
// certificate stays bound to its own connection, and the latches still refuse it.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { makeSync, ready } = require('./helpers/fake_mirror.js');

const BLOCK_TIME = 9000;
const OLD_WATERMARK = 100;              // what the previous connection's full drain certified

function certify(sync, table, watermark) {
    return sync.certifyTableDrain({ table: table, connectionEpoch: sync._wsEpoch,
                                    selectorRevision: sync._selectorRevision,
                                    watermark: watermark, heights: null });
}

// A mirror that certified everything on its previous connection, lost the socket, and is
// now on the replacement connection with the price re-page still running.
function reconnected() {
    const { sync } = makeSync();
    ready(sync);
    sync._bootstrapDrained = true;
    sync.advanceWatermark(OLD_WATERMARK);
    sync.resetOnSocketClose();
    ready(sync);
    return sync;
}

const frameFor = (sync) => ({ ts: BLOCK_TIME + Math.max(sync.anchorAttestWatermarkGraceS,
                                                        sync.attestResponseWatermarkGraceS) });

describe('HubDbSync attest barriers open on their own table certificate during a price re-page @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('both attest barriers open once their tables drain, while the global gate stays shut', async function () {
        const sync = reconnected();
        assert.strictEqual(sync.anchorAttestSyncSatisfied(BLOCK_TIME), false);
        assert.strictEqual(sync.attestResponseSyncSatisfied(BLOCK_TIME), false);
        const anchorWait = sync.waitForAnchorAttestationSync(BLOCK_TIME, 5000);
        const responseWait = sync.waitForAttestationResponseSync(BLOCK_TIME, 5000);

        certify(sync, 'anchor_reward_attestations', 8000);
        certify(sync, 'attestation_responses', 8000);
        sync.handleWatermarkFrame(frameFor(sync));

        assert.strictEqual(sync.anchorAttestSyncSatisfied(BLOCK_TIME), true);
        assert.strictEqual(sync.attestResponseSyncSatisfied(BLOCK_TIME), true);
        await anchorWait;
        await responseWait;
        assert.strictEqual(sync._anchorAttestWaiters.length, 0, 'the deferred block was released');
        assert.strictEqual(sync._attestResponseWaiters.length, 0);
        assert.strictEqual(sync._bootstrapDrained, false, 'price_snapshots still holds the heartbeat gate');
        assert.strictEqual(sync.streamWatermark, OLD_WATERMARK, 'the global watermark did not move');
    });

    it('the drained snapshot watermark alone covers a block it reaches', function () {
        const sync = reconnected();
        certify(sync, 'anchor_reward_attestations', BLOCK_TIME + sync.anchorAttestWatermarkGraceS);
        assert.strictEqual(sync.anchorAttestSyncSatisfied(BLOCK_TIME), true);
        assert.strictEqual(sync.attestResponseSyncSatisfied(BLOCK_TIME), false, 'its table has not drained');
    });

    it('a full drain still opens the heartbeat gate and advances the global watermark', function () {
        const sync = reconnected();
        certify(sync, 'anchor_reward_attestations', 8000);
        assert.strictEqual(sync.certifyFullDrain([8500, 8200], sync._wsEpoch), false,
                           'the owed re-pages hold the gate until they settle');
        // Every table's re-page from the new connection completes, price_snapshots last.
        for (const table of sync.repageOwedTables())
            sync.settleRepageOwed({ table: table, repageSeq: sync.repageOwedSeq(table) });
        assert.strictEqual(sync.certifyFullDrain([8500, 8200], sync._wsEpoch), true);
        assert.strictEqual(sync._bootstrapDrained, true);
        assert.strictEqual(sync.streamWatermark, 8200);
        sync.handleWatermarkFrame(frameFor(sync));
        assert.strictEqual(sync.streamWatermark, frameFor(sync).ts);
        assert.strictEqual(sync.attestResponseSyncSatisfied(BLOCK_TIME), true);
    });
});

describe('HubDbSync attest table certificate stays fail-closed @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('a certificate from the previous socket never opens either barrier', function () {
        const sync = reconnected();
        certify(sync, 'anchor_reward_attestations', 8000);
        certify(sync, 'attestation_responses', 8000);
        sync.resetOnSocketClose();
        ready(sync);
        sync.handleWatermarkFrame(frameFor(sync));
        assert.strictEqual(sync.anchorAttestSyncSatisfied(BLOCK_TIME), false);
        assert.strictEqual(sync.attestResponseSyncSatisfied(BLOCK_TIME), false);
    });

    it('a queued heartbeat from the prior socket cannot advance the replacement certificate', async function () {
        const sync = reconnected();
        const oldEpoch = sync._wsEpoch;
        const oldRevision = sync._selectorRevision;
        sync.resetOnSocketClose();
        ready(sync);
        certify(sync, 'anchor_reward_attestations', 8000);
        sync.enqueueStreamFrame(Object.assign({ type: 'watermark' }, frameFor(sync)), oldEpoch, oldRevision);
        await sync._msgChain;
        assert.strictEqual(sync.anchorAttestSyncSatisfied(BLOCK_TIME), false);
    });

    it('an apply failure or a schema refusal keeps both barriers shut', function () {
        for (const latch of ['_applyFailureSeen', '_schemaMismatchSeen']) {
            const sync = reconnected();
            certify(sync, 'anchor_reward_attestations', 8000);
            certify(sync, 'attestation_responses', 8000);
            sync.handleWatermarkFrame(frameFor(sync));
            sync[latch] = true;
            assert.strictEqual(sync.anchorAttestSyncSatisfied(BLOCK_TIME), false, latch);
            assert.strictEqual(sync.attestResponseSyncSatisfied(BLOCK_TIME), false, latch);
        }
    });

    it('a poll-mode drain certifies no coverage', function () {
        const sync = reconnected();
        sync._pollMode = true;
        certify(sync, 'anchor_reward_attestations', BLOCK_TIME + 100000);
        certify(sync, 'attestation_responses', BLOCK_TIME + 100000);
        assert.strictEqual(sync.anchorAttestSyncSatisfied(BLOCK_TIME), false);
        assert.strictEqual(sync.attestResponseSyncSatisfied(BLOCK_TIME), false);
    });
});
