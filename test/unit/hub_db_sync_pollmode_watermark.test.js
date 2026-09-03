// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// ITEM 2476: when the `ws` require fails, the mirror falls back to REST polling.
// The REST snapshot endpoints are append-only, so a poll cycle can observe new-id
// INSERTs but can NEVER receive an in-place upsert or a row:deleted retraction the
// way the WS stream does. Advancing the stream watermark in that mode falsely
// certifies the mirror as live-complete and opens the settlement barriers over data
// that can be silently stale. The fix sets this._pollMode and makes _bootstrapAll
// SKIP the watermark advance (warning each cycle) while still mirroring; the normal
// WS-connected bootstrap path must still advance the watermark exactly as before.

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../src/hub_db_sync.js');

function makeSync() {
    const doQuery = sinon.stub().resolves([{ h: 0 }]);
    return new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test' });
}

describe('HubDbSync poll-mode watermark fail-closed (ITEM 2476) @regression @tier2', function () {

    it('_pollMode defaults to false on a fresh instance', function () {
        assert.strictEqual(makeSync()._pollMode, false);
    });

    it('poll mode: rows still mirrored, watermark does NOT advance, and a warning is logged each cycle', async function () {
        const sync = makeSync();
        sync._pollMode = true;
        // Each mirrored table drains cleanly (returns a per-table watermark), i.e. the
        // mirror path still runs: bootstrapping/mirroring is not skipped in poll mode.
        const bootstrapTable = sinon.stub(sync, '_bootstrapTable').callsFake(async () => 900);
        const warn = sinon.stub(console, 'warn');
        try {
            await sync._bootstrapAll();
        } finally {
            warn.restore();
        }
        // (a) rows still mirrored: every mirrored table was bootstrapped.
        assert.strictEqual(bootstrapTable.callCount, 8, 'all eight mirrored tables still bootstrap in poll mode');
        assert.strictEqual(sync._bootstrapDrained, true, 'a clean drain still marks the mirror drained');
        // (b) watermark must NOT advance in poll mode.
        assert.strictEqual(sync.streamWatermark, 0, 'poll mode must NOT advance the stream watermark');
        // (c) a prominent warning is logged.
        assert.ok(
            warn.getCalls().some((c) => /poll-mode mirror: watermark frozen/.test(String(c.args[0]))),
            'poll mode must warn that the watermark is frozen each cycle'
        );
    });

    it('WS path: bootstrap still advances the watermark to the OLDEST per-table mark exactly as before', async function () {
        const sync = makeSync();
        sync._pollMode = false;
        const marks = {
            price_snapshots: 900, oracle_prices: 880, cross_chain_matches: 910,
            cross_chain_calls: 915, capability_snapshots: 905, state_checkpoints: 920,
            anchor_reward_attestations: 925, attestation_responses: 930,
        };
        sinon.stub(sync, '_bootstrapTable').callsFake(async (table) => marks[table]);
        await sync._bootstrapAll();
        assert.strictEqual(sync._bootstrapDrained, true);
        assert.strictEqual(sync.streamWatermark, 880, 'WS path must advance to min across tables, unchanged');
    });
});
