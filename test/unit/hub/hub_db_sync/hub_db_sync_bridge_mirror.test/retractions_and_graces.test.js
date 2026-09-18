// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');

// A HubDbSync whose `enabled` flag is true (hub URL + hub DB), with a recording doQuery.
// `rows` is what every query answers with; individual cases override it.
function makeSync(options = {}, rows = []) {
    const calls   = [];
    const doQuery = sinon.stub().callsFake(async (sql, args) => {
        calls.push({ sql: sql, args: args });
        return (typeof rows === 'function') ? rows(sql, args) : rows;
    });
    const sync = new HubDbSync({ doQuery }, Object.assign({ hubUrl: 'http://hub.test' }, options));
    return { sync, doQuery, calls };
}

describe('bridge-family watermark graces @regression @tier1', function () {

    it('each barrier resolves its OWN frozen constant, so no two share a knob', function () {
        // Sharing a grace couples one barrier to another producer's stamping rule; the call
        // barrier was split out of the match grace for exactly that reason. The bridge engine
        // is a third producer and the policy poll a fourth.
        const frozen = HubDbSync.HUB_SYNC_WATERMARK_GRACE_S;
        assert.strictEqual(typeof frozen.bridge, 'number', 'bridge needs its own frozen entry');
        assert.strictEqual(typeof frozen.policy, 'number', 'policy needs its own frozen entry');

        const { sync } = makeSync({ coin: 'DOGE', network: 'regtest' });
        assert.strictEqual(sync.bridgeWatermarkGraceS, frozen.bridge);
        assert.strictEqual(sync.policyWatermarkGraceS, frozen.policy);
    });

    it('the regtest bridge override moves ONLY the bridge barrier', function () {
        const saved = process.env.HUB_SYNC_BRIDGE_GRACE_S;
        process.env.HUB_SYNC_BRIDGE_GRACE_S = '7';
        try {
            const { sync } = makeSync({ coin: 'DOGE', network: 'regtest' });
            assert.strictEqual(sync.bridgeWatermarkGraceS, 7);
            assert.strictEqual(sync.policyWatermarkGraceS, HubDbSync.HUB_SYNC_WATERMARK_GRACE_S.policy);
            assert.strictEqual(sync.matchWatermarkGraceS,  HubDbSync.HUB_SYNC_WATERMARK_GRACE_S.match);
            assert.strictEqual(sync.callWatermarkGraceS,   HubDbSync.HUB_SYNC_WATERMARK_GRACE_S.call);
        } finally {
            if (saved === undefined) delete process.env.HUB_SYNC_BRIDGE_GRACE_S;
            else process.env.HUB_SYNC_BRIDGE_GRACE_S = saved;
        }
    });

    it('an off-regtest override is IGNORED: a per-node grace forks settlement', function () {
        const saved = process.env.HUB_SYNC_POLICY_GRACE_S;
        process.env.HUB_SYNC_POLICY_GRACE_S = '9999';
        try {
            const { sync } = makeSync({ coin: 'DOGE', network: 'mainnet' });
            assert.strictEqual(sync.policyWatermarkGraceS, HubDbSync.HUB_SYNC_WATERMARK_GRACE_S.policy);
        } finally {
            if (saved === undefined) delete process.env.HUB_SYNC_POLICY_GRACE_S;
            else process.env.HUB_SYNC_POLICY_GRACE_S = saved;
        }
    });
});

// No network wired, so the co-signature gate never arms and these cases exercise the
// fence and the DELETE shape alone (the same harness the cross_chain_calls cases use).
function makeApply(options = {}) {
    const calls   = [];
    const doQuery = sinon.stub().callsFake(async (sql, args) => {
        calls.push({ sql: sql, args: args });
        // The barrier refresh a retraction triggers asks the schema for its table first, and
        // a mirror that just had a row deleted from that table plainly has it.
        if (/information_schema\.TABLES/i.test(sql)) return [{ TABLE_NAME: args[0] }];
        return [];
    });
    const sync    = new HubDbSync({ doQuery }, Object.assign({ hubUrl: 'http://hub.test' }, options));
    return { sync, calls };
}

describe('bridge mirror retraction @regression @tier1', function () {
    it('REFUSES an unfenced deletion of a bridge_transfers row', async function () {
        // row:deleted arrives unsigned over the hub stream. Without the quorum-class rule a
        // compromised hub key wipes co-signed transfers out of every mirror.
        const { sync, calls } = makeApply();
        await sync.applyRetraction({ table: 'bridge_transfers', source_chain: 'BTC', from_action_index: 10 });
        assert.strictEqual(calls.length, 0, 'no DELETE may run for an unfenced quorum-class retraction');
    });

    it('deletes by src_chain / src_action_index under the push_generation fence', async function () {
        // Not source_chain: bridge_transfers spells its source leg src_chain, and the wrong
        // name is errno 1054, swallowed, leaving the retracted row mirrored and appliable.
        const { sync, calls } = makeApply();
        await sync.applyRetraction({ table: 'bridge_transfers', source_chain: 'BTC',
                                      from_action_index: 50, retraction_generation: 3 });
        assert.match(calls[0].sql, /DELETE FROM bridge_transfers WHERE src_chain = \?/);
        assert.match(calls[0].sql, /src_action_index >= \?/);
        assert.ok(!/source_chain/.test(calls[0].sql), 'bridge_transfers has no source_chain column');
        assert.match(calls[0].sql, /push_generation <= \?/);
        assert.ok(!/src_action_index <= \?/.test(calls[0].sql), 'must stay open-ended without to_action_index');
        assert.deepStrictEqual(calls[0].args, ['BTC', 50, 3]);
    });

    it('bounds the delete when the event carries to_action_index', async function () {
        const { sync, calls } = makeApply();
        await sync.applyRetraction({ table: 'bridge_transfers', source_chain: 'LTC', from_action_index: 4,
                                      to_action_index: 9, retraction_generation: 1 });
        assert.match(calls[0].sql, /src_action_index >= \? AND src_action_index <= \?/);
        assert.deepStrictEqual(calls[0].args, ['LTC', 4, 9, 1]);
    });

    it('re-reads the bridge watermark after the delete', async function () {
        // The barrier caches MAX(effective_time). A deletion that removed the row holding
        // the maximum leaves that scalar high, and a high scalar opens the barrier over
        // transfers that are gone.
        const { sync, calls } = makeApply({ coin: 'DOGE' });
        await sync.applyRetraction({ table: 'bridge_transfers', source_chain: 'BTC',
                                      from_action_index: 50, retraction_generation: 3 });
        assert.ok(calls.some(c => /MAX\(effective_time\)/i.test(c.sql) && /bridge_transfers/.test(c.sql)),
            'the bridge watermark must be re-read after a retraction');
    });
});

describe('bridge mirror retraction @regression @tier1', function () {
    it('NEVER deletes a policy_snapshots row, fenced or not', async function () {
        // A superseding policy arrives as a new row at a higher policy_seq. There is no
        // deletion shape for this table, which is why it carries no RETRACTION_COLUMNS entry.
        const { sync, calls } = makeApply();
        await sync.applyRetraction({ table: 'policy_snapshots', source_chain: 'BTC', from_action_index: 1 });
        await sync.applyRetraction({ table: 'policy_snapshots', source_chain: 'BTC', from_action_index: 1,
                                      retraction_generation: 2 });
        assert.deepStrictEqual(calls.filter(c => /DELETE/i.test(c.sql)), [],
            'policy_snapshots must never be deleted from the mirror');
    });
});

describe('bridge mirror reconnect refresh @regression @tier2', function () {

    it('_refreshAllSyncHeights re-reads both bridge-family watermarks', async function () {
        // A dropped socket freezes the in-memory scalars behind a mirror that is current;
        // the reconnect edge clears the waiters from data already local instead of making
        // every deferred block wait out its full timeout.
        const { sync, calls } = makeSync({ coin: 'DOGE' }, [{ ts: 1 }]);
        await sync.refreshAllSyncHeights();
        assert.ok(calls.some(c => /FROM bridge_transfers/.test(c.sql)), 'bridge watermark must be re-read');
        assert.ok(calls.some(c => /FROM policy_snapshots/.test(c.sql)), 'policy watermark must be re-read');
    });
});
