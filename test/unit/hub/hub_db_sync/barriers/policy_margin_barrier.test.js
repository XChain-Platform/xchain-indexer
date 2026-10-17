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
// The policy_snapshots barrier's content shortcut, from the offrail-config lane (2026-10-15).
// A snapshot's effective_time is the proposing leader's clock plus the largest relay floor over
// the tick's copies, and each co-signer only holds it between 60 s and 3600 s ahead of its own
// clock. Rounds for different ticks run under different leaders, so a snapshot signed after the
// newest local one can be stamped up to 3540 s before it, and a MAX(effective_time) over the
// mirror proves nothing about it. The shortcut now opens on MAX - 3540, and only on a drained
// connection; the stream watermark is what opens a block on a healthy node otherwise. The
// list-share barrier's empty-mirror path takes the same drained guard.

process.env.INDEXER_COIN = 'LTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');

// A HubDbSync over a hub DB whose policy_snapshots MAX(effective_time) is `maxEff`.
function makeSync(coin, maxEff) {
    const doQuery = sinon.stub().callsFake(async (sql, args) => {
        if (/information_schema\.TABLES/i.test(sql)) return [{ TABLE_NAME: args[0] }];
        if (/FROM policy_snapshots/.test(sql)) return [{ ts: maxEff }];
        return [];
    });
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', coin: coin });
    return sync;
}

// Two honest snapshots inside the follower window. Leader A, its clock 600 s fast, proposes
// ZERO (copies on BTC) stamped NOW + 600 + 3000; leader B, accurate, proposes EIGHT (copies on
// DOGE) five seconds later, stamped NOW + 5 + 240. Every co-signer sees both inside
// [now + 60, now + 3600]. The node holds ZERO and not yet EIGHT.
const NOW = 1700000000;
const ZERO_STAMP = NOW + 3600;
const EIGHT_STAMP = NOW + 5 + 240;

describe('policy barrier: content shortcut scoped by the follower stamp window @regression @tier1', function () {
    it('holds a block while a snapshot signed after the newest local one is due and missing', async function () {
        const sync = makeSync('LTC', ZERO_STAMP);
        await sync.refreshPolicySyncTimestamp(true);
        sync._bootstrapDrained = true;
        assert.strictEqual(sync.policySyncTimestamp, ZERO_STAMP, 'the reported watermark stays the raw MAX');
        for (let t = EIGHT_STAMP; t <= ZERO_STAMP; t += 60)
            assert.strictEqual(sync.policySyncSatisfied(t), false, 'opened at now+' + (t - NOW));
    });

    it('opens once the newest stamp covers the whole stamp spread', async function () {
        const sync = makeSync('LTC', ZERO_STAMP);
        await sync.refreshPolicySyncTimestamp(true);
        sync._bootstrapDrained = true;
        const covered = ZERO_STAMP - 3600 + 60;
        assert.strictEqual(sync.policyCoveredTimestamp, covered);
        assert.strictEqual(sync.policySyncSatisfied(covered), true);
        assert.strictEqual(sync.policySyncSatisfied(covered + 1), false);
    });

    it('opens the content shortcut only on a drained connection', async function () {
        const sync = makeSync('LTC', ZERO_STAMP);
        await sync.refreshPolicySyncTimestamp(true);
        sync._bootstrapDrained = false;
        const covered = sync.policyCoveredTimestamp;
        assert.strictEqual(sync.policySyncSatisfied(covered), false, 'a re-draining mirror proves nothing');
        sync._bootstrapDrained = true;
        assert.strictEqual(sync.policySyncSatisfied(covered), true);
    });

    it('never holds a healthy node forever: a stream watermark advance releases the waiter', async function () {
        const sync = makeSync('LTC', ZERO_STAMP);
        await sync.refreshPolicySyncTimestamp(true);
        sync._bootstrapDrained = true;
        const pending = sync.waitForPolicySync(EIGHT_STAMP, 5000);
        assert.strictEqual(sync._policyWaiters.length, 1, 'held by the scoped shortcut');
        sync.advanceWatermark(EIGHT_STAMP + sync.policyWatermarkGraceS);
        await pending;
        assert.strictEqual(sync._policyWaiters.length, 0, 'released by the heartbeat, with no new row');
    });

    it('keeps the raw MAX for a display mirror with no coin', async function () {
        const sync = makeSync(undefined, ZERO_STAMP);
        sync.coin = null;
        await sync.refreshPolicySyncTimestamp(true);
        sync._bootstrapDrained = true;
        assert.strictEqual(sync.policyCoveredTimestamp, ZERO_STAMP);
    });
});

describe('list share barrier: empty-mirror path needs a drained connection @regression @tier1', function () {
    it('holds an empty list mirror behind the height watermark until the re-drain', function () {
        const sync = makeSync('LTC', null);
        sync.listShareBootstrapped = true;
        sync.listShareMirrorEmpty  = true;
        sinon.stub(sync, 'heightSatisfied').returns(false);
        sync._bootstrapDrained = false;
        assert.strictEqual(sync.listShareSyncSatisfied(13), false,
            'a first list version written while the socket was down is not proved absent');
        sync._bootstrapDrained = true;
        assert.strictEqual(sync.listShareSyncSatisfied(13), true);
    });
});
