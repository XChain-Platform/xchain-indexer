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
// The two bridge-family barriers against a schema that does NOT hold their mirror
// tables, the shape a consumer has before those tables are created in its hub DB.
//
// What these cases exist to catch, in the words of the failures they would be:
//   - a watermark statement fired once per mirrored row against a table that is not
//     there, answered 1146 by the server and swallowed here, so an operator reading
//     the logs of a mirror that never opens its bridge barrier is told nothing;
//   - a barrier that ARMS off a table it could not read, which would mint a bridged
//     credit at a block no other operator of this chain agrees with.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');

// The watermark statements, as opposed to the schema probe that now precedes them.
function watermarkCalls(calls) {
    return calls.filter(c => /MAX\(effective_time\)/.test(c.sql));
}

// A HubDbSync over a schema that holds exactly `tables`, answering the schema probe the
// way the server answers it and refusing a watermark read on a table it does not hold
// with a real 1146. Emulating the server is what makes these cases about behaviour and
// not about a string this file also writes.
function makeSyncOnSchema(tables, options = {}) {
    const calls   = [];
    const doQuery = sinon.stub().callsFake(async (sql, args) => {
        calls.push({ sql: sql, args: args });
        if (/information_schema\.TABLES/i.test(sql))
            return tables.includes(args[0]) ? [{ TABLE_NAME: args[0] }] : [];
        const named = /FROM (bridge_transfers|policy_snapshots)/.exec(sql);
        if (named && !tables.includes(named[1])) {
            const e = new Error("Table '" + named[1] + "' doesn't exist");
            e.errno = 1146;
            e.code  = 'ER_NO_SUCH_TABLE';
            throw e;
        }
        return [{ ts: 456 }];
    });
    const sync = new HubDbSync({ doQuery },
        Object.assign({ hubUrl: 'http://hub.test', coin: 'DOGE' }, options));
    sync._bootstrapDrained = true;
    return { sync, calls };
}

const BOTH_TABLES = ['bridge_transfers', 'policy_snapshots'];

describe('bridge and policy barriers on a schema without the mirror tables @regression @tier1', function () {
    it('sends no watermark statement it knows the schema will refuse', async function () {
        // Before the probe, every refresh (one per mirrored row, plus the price barrier's
        // own pass) fired a statement the server answered 1146 and this file swallowed.
        const { sync, calls } = makeSyncOnSchema([]);
        await sync.refreshBridgeSyncTimestamp();
        await sync.refreshPolicySyncTimestamp();
        assert.strictEqual(watermarkCalls(calls).length, 0);
    });

    it('keeps both barriers CLOSED, which is the side that cannot fork', async function () {
        // The absence of a table says nothing about whether transfers exist to mirror, so
        // the barrier may not open on it: a node that minted against a mirror it never read
        // would credit at a block no other operator of this chain agrees with.
        const { sync } = makeSyncOnSchema([]);
        await sync.refreshBridgeSyncTimestamp();
        await sync.refreshPolicySyncTimestamp();
        assert.strictEqual(sync.bridgeBootstrapped, false);
        assert.strictEqual(sync.policyBootstrapped, false);
        assert.strictEqual(sync.bridgeSyncSatisfied(1000), false);
        assert.strictEqual(sync.policySyncSatisfied(1000), false);
    });

    it('asks the schema once, not once per refresh', async function () {
        const { sync, calls } = makeSyncOnSchema(BOTH_TABLES);
        await sync.refreshBridgeSyncTimestamp();
        await sync.refreshBridgeSyncTimestamp();
        await sync.refreshBridgeSyncTimestamp();
        const probes = calls.filter(c => /information_schema\.TABLES/i.test(c.sql));
        assert.strictEqual(probes.length, 1);
        assert.strictEqual(watermarkCalls(calls).length, 3);
    });
});

describe('bridge and policy barriers when the schema changes underneath @regression @tier1', function () {
    it('re-probes once a negative answer ages out, so creating the table heals a running client',
        async function () {
        const { sync, calls } = makeSyncOnSchema([]);
        await sync.refreshBridgeSyncTimestamp();
        assert.strictEqual(sync.bridgeSyncTimestamp, null);
        sync.hubDb.doQuery.resetHistory();
        // The operator creates the mirror tables, and the negative memo ages past its TTL.
        sync.hubDb.doQuery.callsFake(async (sql, args) => {
            calls.push({ sql: sql, args: args });
            if (/information_schema\.TABLES/i.test(sql)) return [{ TABLE_NAME: args[0] }];
            return [{ ts: 456 }];
        });
        sync._mirrorTableMemo['bridge_transfers'].at = Date.now() - 600000;
        await sync.refreshBridgeSyncTimestamp();
        assert.strictEqual(sync.bridgeSyncTimestamp, 456, 'the created table must be picked up');
        assert.strictEqual(sync.bridgeBootstrapped, true);
    });

    it('records the 1146 a stale positive memo earns, and skips the statement next time',
        async function () {
        const { sync, calls } = makeSyncOnSchema([]);
        sync._mirrorTableMemo = { bridge_transfers: { present: true, at: Date.now() } };
        await sync.refreshBridgeSyncTimestamp();
        assert.strictEqual(watermarkCalls(calls).length, 1, 'exactly one statement pays for the wrong memo');
        assert.strictEqual(sync._mirrorTableMemo['bridge_transfers'].present, false);
        await sync.refreshBridgeSyncTimestamp();
        assert.strictEqual(watermarkCalls(calls).length, 1, 'and the next refresh does not pay it again');
        assert.strictEqual(sync.bridgeSyncTimestamp, null, 'a barrier may never arm off a failed read');
    });

    it('reads the table anyway when the probe itself fails', async function () {
        // A probe that cannot answer must not degrade a client whose mirror is fine, so it
        // answers the way this file behaved before the probe existed and the catch is the net.
        const { sync, calls } = makeSyncOnSchema(BOTH_TABLES);
        sync.hubDb.doQuery.callsFake(async (sql, args) => {
            calls.push({ sql: sql, args: args });
            if (/information_schema\.TABLES/i.test(sql)) throw new Error('information_schema refused');
            return [{ ts: 789 }];
        });
        await sync.refreshBridgeSyncTimestamp();
        assert.strictEqual(watermarkCalls(calls).length, 1);
        assert.strictEqual(sync.bridgeSyncTimestamp, 789);
    });
});
