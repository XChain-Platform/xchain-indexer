// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');

function makeSync() {
    return new HubDbSync({ doQuery: async () => [] }, { hubUrl: 'enabled' });
}

describe('HubDbSync attest waiter timeout self-heal @regression @tier2', function () {
    it('anchor reward: resolves when completeness advanced without the release event', async function () {
        const sync = makeSync();
        sync.streamWatermark = 0;

        const pending = sync.waitForAnchorAttestationSync(1000, 30);
        assert.strictEqual(sync._anchorAttestWaiters.length, 1, 'the stale watermark arms a waiter');

        sync.streamWatermark = 1000 + sync.anchorAttestWatermarkGraceS;

        const got = await pending;
        assert.strictEqual(got, sync.streamWatermark);
        assert.strictEqual(sync._anchorAttestWaiters.length, 0, 'the timeout re-check clears the waiter');
    });

    it('attestation response: resolves when completeness advanced without the release event', async function () {
        const sync = makeSync();
        sync.streamWatermark = 0;

        const pending = sync.waitForAttestationResponseSync(1000, 30);
        assert.strictEqual(sync._attestResponseWaiters.length, 1, 'the stale watermark arms a waiter');

        sync.streamWatermark = 1000 + sync.attestResponseWatermarkGraceS;

        const got = await pending;
        assert.strictEqual(got, sync.streamWatermark);
        assert.strictEqual(sync._attestResponseWaiters.length, 0, 'the timeout re-check clears the waiter');
    });
});

describe('HubDbSync attest waiter timeout self-heal @regression @tier2', function () {
    it('anchor reward: still rejects when completeness remains behind', async function () {
        const sync = makeSync();

        await assert.rejects(
            sync.waitForAnchorAttestationSync(1000, 30),
            /anchor-reward attestation mirror barrier timed out/
        );
        assert.strictEqual(sync._anchorAttestWaiters.length, 0, 'the timed-out waiter is removed');
    });

    it('attestation response: still rejects when completeness remains behind', async function () {
        const sync = makeSync();

        await assert.rejects(
            sync.waitForAttestationResponseSync(1000, 30),
            /attestation response mirror barrier timed out/
        );
        assert.strictEqual(sync._attestResponseWaiters.length, 0, 'the timed-out waiter is removed');
    });
});
