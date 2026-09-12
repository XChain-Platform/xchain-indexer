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
// Mirror registration and the two block-loop barriers for the bridge family
// (bridge_transfers, policy_snapshots), base spec row 6a and policy spec row 5.
//
// What these cases exist to catch, in the words of the failures they would be:
//   - a transfer applied at divergent blocks on two indexers of one destination chain,
//     because the barrier opened on a watermark that an unrelated other-chain transfer
//     had raised (the item-4573 fork class, re-run for a table that mints value);
//   - a fabricated or unfenced deletion silently wiping a co-signed transfer row;
//   - a retraction DELETE built against `source_chain`, which bridge_transfers does not
//     have: errno 1054, swallowed by the retraction path, leaving a retracted transfer
//     mirrored forever and applied on the next pass;
//   - a policy snapshot mirror that is never re-read after the mirror is pruned, so the
//     cached scalar keeps a barrier open over rows that are gone.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const HubDbSync = require('../../src/hub_db_sync.js');

const SQL_DIR = path.join(__dirname, '..', '..', 'src', 'sql');

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

describe('bridge mirror registration @regression @tier1', function () {

    it('bootstraps bridge_transfers and policy_snapshots, and drains them before price_snapshots',
        async function () {
        // Registration in the bootstrap set is what makes the tables exist locally at all.
        // Order matters for a different reason (a cold start must arm the small barriers
        // before the one unbounded table drains), so both are asserted together.
        const { sync } = makeSync();
        const seen = [];
        sinon.stub(sync, '_bootstrapTable').callsFake(async (table) => { seen.push(table); return 900; });

        await sync._bootstrapAll();

        assert.ok(seen.includes('bridge_transfers'), 'bridge_transfers must bootstrap');
        assert.ok(seen.includes('policy_snapshots'), 'policy_snapshots must bootstrap');
        assert.ok(seen.indexOf('bridge_transfers') < seen.indexOf('price_snapshots'),
            'the heavy unbounded table drains last so the bridge barrier arms first');
        assert.ok(seen.indexOf('policy_snapshots') < seen.indexOf('price_snapshots'),
            'the heavy unbounded table drains last so the policy barrier arms first');
    });

    it('fences both tables on btc_chain_id, and applies a row that names this chain', function () {
        // The chain-identity fence is the observable consequence of CROSS_CHAIN_TABLES
        // membership: a regtest venue that re-genesises its Bitcoin chain keeps serving the
        // dead chain's finalized rows, and an unfenced mirror applies every one of them.
        const { sync } = makeSync();
        const ours     = 'a'.repeat(64);
        const foreign  = 'b'.repeat(64);
        sync._expectedBtcChainId = ours;

        for (const table of ['bridge_transfers', 'policy_snapshots']) {
            assert.strictEqual(sync._refuseForeignChainRow(table, { btc_chain_id: foreign }), true,
                table + ' must refuse a row from another Bitcoin chain');
            assert.strictEqual(sync._refuseForeignChainRow(table, { btc_chain_id: ours }), false,
                table + ' must apply a row from this chain');
            assert.strictEqual(sync._refuseForeignChainRow(table, { btc_chain_id: null }), false,
                table + ' must apply a pre-column NULL row');
        }
    });

    it('reports each table on its OWN watermark scalar, not the global stream watermark', function () {
        // The HUB_STATE_TABLES decision, stated as behaviour: a table on that list reports
        // the global watermark, which would hide a barrier that is behind on its own table.
        const { sync } = makeSync();
        sync.streamWatermark     = 5000;
        sync.bridgeSyncTimestamp = 111;
        sync.policySyncTimestamp = 222;

        const status = sync.mirrorStatus();

        assert.strictEqual(status.tables.bridge_transfers, 111);
        assert.strictEqual(status.tables.policy_snapshots, 222);
    });

    it('the retraction key columns the DELETE names exist in the mirrored DDL', function () {
        // The price_snapshots class of bug: _applyRetraction built a DELETE against columns
        // the mirror twin did not have, every reorg deletion threw ER_BAD_FIELD_ERROR, and
        // the retraction path swallowed it. Read the real SQL rather than trusting the map.
        const columns = (table) => new Set(
            fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8')
              .split('\n')
              .map(l => (l.trim().match(/^`?([a-z_][a-z0-9_]*)`?\b/i) || [])[1])
              .filter(Boolean));

        const transfers = columns('bridge_transfers');
        for (const c of ['src_chain', 'src_action_index', 'push_generation', 'effective_time', 'status'])
            assert.ok(transfers.has(c), 'bridge_transfers.sql is missing `' + c + '`, which _applyRetraction ' +
                'or the bridge barrier names');

        const snapshots = columns('policy_snapshots');
        for (const c of ['origin_chain', 'effective_time', 'status'])
            assert.ok(snapshots.has(c), 'policy_snapshots.sql is missing `' + c + '`, which the policy barrier names');
    });
});

describe('bridge sync barrier @regression @tier1', function () {

    it('scopes MAX(effective_time) to transfers touching this coin on either leg', async function () {
        // A global max is the fork: the hub broadcasts every finalized transfer to every
        // mirror, so an unrelated DOGE->LTC transfer would raise this watermark past the
        // block time and open the barrier before this chain's own transfers are local.
        const { sync, calls } = makeSync({ coin: 'DOGE' }, [{ ts: 456 }]);

        await sync._refreshBridgeSyncTimestamp();

        assert.match(calls[0].sql, /FROM bridge_transfers/);
        assert.match(calls[0].sql, /src_chain\s*=\s*\?\s+OR\s+dest_chain\s*=\s*\?/i);
        assert.deepStrictEqual(calls[0].args, ['DOGE', 'DOGE']);
        assert.strictEqual(sync.bridgeSyncTimestamp, 456);
    });

    it('falls back to an unscoped watermark when no coin is configured', async function () {
        const { sync, calls } = makeSync({}, [{ ts: 9 }]);
        await sync._refreshBridgeSyncTimestamp();
        assert.ok(!/src_chain/.test(calls[0].sql), 'no coin means no chain filter');
        assert.deepStrictEqual(calls[0].args, []);
    });

    it('leaves the cached watermark untouched when the table is not there yet', async function () {
        const { sync, doQuery } = makeSync({ coin: 'DOGE' });
        sync.bridgeSyncTimestamp = 777;
        doQuery.rejects(new Error("Table 'bridge_transfers' doesn't exist"));
        await sync._refreshBridgeSyncTimestamp();
        assert.strictEqual(sync.bridgeSyncTimestamp, 777, 'a missing table must not reset the scalar');
    });

    it('an empty mirror satisfies the barrier ONLY after a full bootstrap drain', async function () {
        // The #1788 rule: the NULL fast path may never be armed from a holed mirror, or a
        // node that drained nothing would mint at the wrong block and fork.
        const { sync } = makeSync({ coin: 'DOGE' });
        sync.bridgeSyncTimestamp = null;
        assert.strictEqual(sync._bridgeSyncSatisfied(1000), false, 'un-bootstrapped: must defer');
        sync.bridgeBootstrapped = true;
        assert.strictEqual(sync._bridgeSyncSatisfied(1000), true);
    });

    it('opens on the stream watermark at exactly its own grace, not one second earlier', function () {
        // The grace is a consensus input: every node must open at the same instant. Pin both
        // sides of the boundary so a changed constant or a borrowed one reddens here.
        const { sync } = makeSync({ coin: 'DOGE' });
        sync.bridgeBootstrapped  = true;
        sync.bridgeSyncTimestamp = 500;                     // armed, far behind the tip
        const grace = sync.bridgeWatermarkGraceS;
        sync.streamWatermark = 1000 + grace;
        assert.strictEqual(sync._bridgeSyncSatisfied(1000), true);
        sync.streamWatermark = 1000 + grace - 1;
        assert.strictEqual(sync._bridgeSyncSatisfied(1000), false, 'must defer until the grace is covered');
    });

    it('waitForBridgeSync resolves at once when the mirror is already past the block time', async function () {
        const { sync } = makeSync({ coin: 'DOGE' });
        sync.bridgeSyncTimestamp = 2000;
        assert.strictEqual(await sync.waitForBridgeSync(1500, 5000), 2000);
        assert.strictEqual(sync._bridgeWaiters.length, 0);
    });

    it('waitForBridgeSync rejects when the mirror and the watermark both stay behind', async function () {
        const { sync } = makeSync({ coin: 'DOGE' }, [{ ts: 500 }]);
        sync.bridgeBootstrapped  = true;
        sync.bridgeSyncTimestamp = 500;
        await assert.rejects(
            () => sync.waitForBridgeSync(1000, 30),
            /bridge sync barrier timed out .* block_time 1000 \(bridge mirror at 500\)/);
        assert.strictEqual(sync._bridgeWaiters.length, 0, 'the timed-out waiter must be dropped');
    });

    it('waitForBridgeSync self-heals on timeout when the local mirror had actually caught up',
        async function () {
        // A missed refresh on a stream or reconnect edge leaves the scalar stale behind a
        // mirror that is current; without the re-read the block defers a full timeout for
        // nothing, once per block.
        const { sync } = makeSync({ coin: 'DOGE' }, [{ ts: 4000 }]);
        sync.bridgeBootstrapped  = true;
        sync.bridgeSyncTimestamp = 500;                     // stale in memory, 4000 in the DB
        assert.strictEqual(await sync.waitForBridgeSync(1000, 30), 4000);
    });

    it('a watermark advance releases an in-flight waiter without a new row', async function () {
        const { sync } = makeSync({ coin: 'DOGE' });
        sync.bridgeBootstrapped  = true;
        sync.bridgeSyncTimestamp = 500;
        const pending = sync.waitForBridgeSync(1000, 5000);
        assert.strictEqual(sync._bridgeWaiters.length, 1);
        sync._advanceWatermark(1000 + sync.bridgeWatermarkGraceS);
        await pending;
        assert.strictEqual(sync._bridgeWaiters.length, 0, 'released by the watermark, not by a row');
    });

    it('is a no-op when the mirror is disabled (single-host node)', async function () {
        const sync = new HubDbSync(null, {});
        assert.strictEqual(sync.enabled, false);
        assert.strictEqual(await sync.waitForBridgeSync(1000, 5000), null);
    });
});

describe('policy sync barrier @regression @tier1', function () {

    it('scopes the watermark to snapshots this chain can apply, by origin_chain', async function () {
        // A policy snapshot names no destination (every chain holding a copy applies it), so
        // there is no dest_chain to key on. The one set of rows this chain can never apply is
        // the ones it originates: it already holds that policy natively.
        const { sync, calls } = makeSync({ coin: 'BTC' }, [{ ts: 321 }]);

        await sync._refreshPolicySyncTimestamp();

        assert.match(calls[0].sql, /FROM policy_snapshots/);
        assert.match(calls[0].sql, /origin_chain\s*<>\s*\?/i);
        assert.ok(!/dest_chain/.test(calls[0].sql), 'a policy row has no destination to scope by');
        assert.deepStrictEqual(calls[0].args, ['BTC']);
        assert.strictEqual(sync.policySyncTimestamp, 321);
    });

    it('an empty mirror satisfies the barrier ONLY after a full bootstrap drain', function () {
        const { sync } = makeSync({ coin: 'DOGE' });
        sync.policySyncTimestamp = null;
        assert.strictEqual(sync._policySyncSatisfied(1000), false);
        sync.policyBootstrapped = true;
        assert.strictEqual(sync._policySyncSatisfied(1000), true);
    });

    it('opens on the stream watermark at exactly its own grace', function () {
        const { sync } = makeSync({ coin: 'DOGE' });
        sync.policyBootstrapped  = true;
        sync.policySyncTimestamp = 500;
        const grace = sync.policyWatermarkGraceS;
        sync.streamWatermark = 1000 + grace;
        assert.strictEqual(sync._policySyncSatisfied(1000), true);
        sync.streamWatermark = 1000 + grace - 1;
        assert.strictEqual(sync._policySyncSatisfied(1000), false);
    });

    it('waitForPolicySync rejects behind a stale mirror and names the mirror position', async function () {
        const { sync } = makeSync({ coin: 'DOGE' }, [{ ts: 500 }]);
        sync.policyBootstrapped  = true;
        sync.policySyncTimestamp = 500;
        await assert.rejects(
            () => sync.waitForPolicySync(1000, 30),
            /policy sync barrier timed out .* block_time 1000 \(policy mirror at 500\)/);
    });

    it('waitForPolicySync self-heals on timeout when the local mirror had caught up', async function () {
        const { sync } = makeSync({ coin: 'DOGE' }, [{ ts: 4000 }]);
        sync.policyBootstrapped  = true;
        sync.policySyncTimestamp = 500;
        assert.strictEqual(await sync.waitForPolicySync(1000, 30), 4000);
    });

    it('a watermark advance releases an in-flight waiter without a new row', async function () {
        // The #1984 deadlock class: a quiet table must never freeze the tip. A heartbeat is
        // the only evidence that arrives when no row does, so _advanceWatermark has to reach
        // this waiter list as well as the older ones.
        const { sync } = makeSync({ coin: 'DOGE' });
        sync.policyBootstrapped  = true;
        sync.policySyncTimestamp = 500;
        const pending = sync.waitForPolicySync(1000, 5000);
        assert.strictEqual(sync._policyWaiters.length, 1);
        sync._advanceWatermark(1000 + sync.policyWatermarkGraceS);
        await pending;
        assert.strictEqual(sync._policyWaiters.length, 0, 'released by the watermark, not by a row');
    });
});

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

describe('bridge mirror retraction @regression @tier1', function () {

    // No network wired, so the co-signature gate never arms and these cases exercise the
    // fence and the DELETE shape alone (the same harness the cross_chain_calls cases use).
    function makeApply(options = {}) {
        const calls   = [];
        const doQuery = sinon.stub().callsFake(async (sql, args) => { calls.push({ sql: sql, args: args }); return []; });
        const sync    = new HubDbSync({ doQuery }, Object.assign({ hubUrl: 'http://hub.test' }, options));
        return { sync, calls };
    }

    it('REFUSES an unfenced deletion of a bridge_transfers row', async function () {
        // row:deleted arrives unsigned over the hub stream. Without the quorum-class rule a
        // compromised hub key wipes co-signed transfers out of every mirror.
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'bridge_transfers', source_chain: 'BTC', from_action_index: 10 });
        assert.strictEqual(calls.length, 0, 'no DELETE may run for an unfenced quorum-class retraction');
    });

    it('deletes by src_chain / src_action_index under the push_generation fence', async function () {
        // Not source_chain: bridge_transfers spells its source leg src_chain, and the wrong
        // name is errno 1054, swallowed, leaving the retracted row mirrored and appliable.
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'bridge_transfers', source_chain: 'BTC',
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
        await sync._applyRetraction({ table: 'bridge_transfers', source_chain: 'LTC', from_action_index: 4,
                                      to_action_index: 9, retraction_generation: 1 });
        assert.match(calls[0].sql, /src_action_index >= \? AND src_action_index <= \?/);
        assert.deepStrictEqual(calls[0].args, ['LTC', 4, 9, 1]);
    });

    it('re-reads the bridge watermark after the delete', async function () {
        // The barrier caches MAX(effective_time). A deletion that removed the row holding
        // the maximum leaves that scalar high, and a high scalar opens the barrier over
        // transfers that are gone.
        const { sync, calls } = makeApply({ coin: 'DOGE' });
        await sync._applyRetraction({ table: 'bridge_transfers', source_chain: 'BTC',
                                      from_action_index: 50, retraction_generation: 3 });
        assert.ok(calls.some(c => /MAX\(effective_time\)/i.test(c.sql) && /bridge_transfers/.test(c.sql)),
            'the bridge watermark must be re-read after a retraction');
    });

    it('NEVER deletes a policy_snapshots row, fenced or not', async function () {
        // A superseding policy arrives as a new row at a higher policy_seq. There is no
        // deletion shape for this table, which is why it carries no RETRACTION_COLUMNS entry.
        const { sync, calls } = makeApply();
        await sync._applyRetraction({ table: 'policy_snapshots', source_chain: 'BTC', from_action_index: 1 });
        await sync._applyRetraction({ table: 'policy_snapshots', source_chain: 'BTC', from_action_index: 1,
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
        await sync._refreshAllSyncHeights();
        assert.ok(calls.some(c => /FROM bridge_transfers/.test(c.sql)), 'bridge watermark must be re-read');
        assert.ok(calls.some(c => /FROM policy_snapshots/.test(c.sql)), 'policy watermark must be re-read');
    });
});
