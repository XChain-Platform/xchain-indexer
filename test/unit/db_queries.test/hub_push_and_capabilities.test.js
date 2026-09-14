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
 **********************************************************************
 * test/unit/db_queries.test/hub_push_and_capabilities.test.js
 *
 * The hub push queue and its pending reads, capability snapshots and the
 * active capability count.
 *
 * Part of the Database query suite (see ../db_queries.test.js): real method
 * logic against a stubbed doQuery, no live MariaDB required.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { makeDb } = require('./helpers/db_stub');

afterEach(function () {
    sinon.restore();
});

// ---------------------------------------------------------------------------
// getActiveCapabilityCount
// ---------------------------------------------------------------------------
describe('Database.getActiveCapabilityCount() @regression @tier1', function () {
    function makeDbWithCap() {
        const db = makeDb();
        db.config.STAKING = { CAPABILITIES: { attestation: { MIN_STAKE: '10000' } } };
        return db;
    }

    it('returns 0 when capability is not configured', async function () {
        const db = makeDbWithCap();
        sinon.stub(db, 'getStatusId').resolves(1);
        sinon.stub(db, 'doQuery').resolves([{ cnt: 5 }]);
        // 'unknown' capability is not in config
        assert.strictEqual(await db.getActiveCapabilityCount('unknown', 100), 0);
    });

    it('returns count when capability is configured', async function () {
        const db = makeDbWithCap();
        sinon.stub(db, 'getStatusId').resolves(1);
        sinon.stub(db, 'doQuery').resolves([{ cnt: 7 }]);
        assert.strictEqual(await db.getActiveCapabilityCount('attestation', 100), 7);
    });

    it('returns 0 when doQuery returns empty', async function () {
        const db = makeDbWithCap();
        sinon.stub(db, 'getStatusId').resolves(1);
        sinon.stub(db, 'doQuery').resolves([]);
        assert.strictEqual(await db.getActiveCapabilityCount('attestation', 100), 0);
    });

    it('passes blockIndex args when provided', async function () {
        const db = makeDbWithCap();
        sinon.stub(db, 'getStatusId').resolves(1);
        const q = sinon.stub(db, 'doQuery').resolves([{ cnt: 0 }]);
        await db.getActiveCapabilityCount('attestation', 500);
        const args = q.firstCall.args[1];
        assert.ok(args.includes(500));
    });
});

// ---------------------------------------------------------------------------
// enqueueHubPush / markHubPushDelivered / recordHubPushAttempt
// ---------------------------------------------------------------------------
describe('Database hub push queue methods @regression @tier1', function () {
    it('enqueueHubPush inserts a row with serialized payload', async function () {
        const db   = makeDb();
        const conn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        db.pool.getConnection.resolves(conn);
        const payload = { action_index: 42, type: 'price', data: 'abc' };
        await db.enqueueHubPush('price', payload);
        const sql = conn.query.firstCall.args[0];
        assert.match(sql, /INSERT INTO pending_hub_pushes/i);
        const args = conn.query.firstCall.args[1];
        assert.strictEqual(args[0], 'price');
        assert.strictEqual(args[1], 42);
        assert.strictEqual(JSON.parse(args[2]).action_index, 42);
    });

    it('enqueueHubPush keys the row on an explicit rollback index when one is given', async function () {
        const db   = makeDb();
        const conn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        db.pool.getConnection.resolves(conn);
        // The ATTEST batch shape: the payload names the head (100) for the explorer link,
        // while the action that LANDS the delivery is the completing chunk (200). The
        // column is the reorg purge key, so it must carry 200 and the payload must not
        // be rewritten.
        await db.enqueueHubPush('attest_batch', { action_index: 100, rows: [] }, 200);
        const args = conn.query.firstCall.args[1];
        assert.strictEqual(args[1], 200, 'the column takes the rollback key');
        assert.strictEqual(JSON.parse(args[2]).action_index, 100, 'the payload keeps the head');
    });

    it('markHubPushDelivered deletes the row', async function () {
        const db   = makeDb();
        const conn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        db.pool.getConnection.resolves(conn);
        await db.markHubPushDelivered(7);
        assert.match(conn.query.firstCall.args[0], /DELETE FROM pending_hub_pushes/i);
        assert.deepStrictEqual(conn.query.firstCall.args[1], [7]);
    });

    it('recordHubPushAttempt runs an UPDATE', async function () {
        const db   = makeDb();
        const conn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        db.pool.getConnection.resolves(conn);
        await db.recordHubPushAttempt(3, 'timeout', 5);
        assert.match(conn.query.firstCall.args[0], /UPDATE pending_hub_pushes/i);
    });

    it('recordHubPushAttempt defaults maxAttempts to 10 on invalid input', async function () {
        const db   = makeDb();
        const conn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        db.pool.getConnection.resolves(conn);
        await db.recordHubPushAttempt(1, 'err', -1);
        // Should still call query without throwing
        assert.ok(conn.query.calledOnce);
    });
});

// ---------------------------------------------------------------------------
// getPendingHubPushes
// ---------------------------------------------------------------------------
describe('Database.getPendingHubPushes() @regression @tier1', function () {
    it('defaults limit to 50 on invalid input', async function () {
        const db   = makeDb();
        const conn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        db.pool.getConnection.resolves(conn);
        await db.getPendingHubPushes(-1);
        const sql = conn.query.firstCall.args[0];
        assert.match(sql, /SELECT/i);
    });

    it('uses provided limit', async function () {
        const db   = makeDb();
        const conn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        db.pool.getConnection.resolves(conn);
        await db.getPendingHubPushes(10);
        const sql  = conn.query.firstCall.args[0];
        const args = conn.query.firstCall.args[1];
        assert.strictEqual(args[args.length - 1], 10, 'limit is the last bound parameter');
        assert.match(sql, /LIMIT \?/);
    });

    // Head-of-line blocking fix: the due-time predicate
    // must be pushed into SQL, mirroring HubPushQueue.isDue's backoff formula
    // (delay = LEAST(base * 2^(attempts-1), max)), so pending-but-not-due rows no
    // longer occupy the LIMIT batch slots.
    it('bakes the exponential-backoff due-time predicate into the WHERE clause', async function () {
        const db   = makeDb();
        const conn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        db.pool.getConnection.resolves(conn);
        await db.getPendingHubPushes(50, { baseBackoffMs: 30000, maxBackoffMs: 600000 });
        const sql  = conn.query.firstCall.args[0];
        const args = conn.query.firstCall.args[1];
        assert.match(sql, /last_attempted_at IS NULL/);
        assert.match(sql, /LEAST\(\? \* POW\(2, GREATEST\(attempts - 1, 0\)\), \?\)/);
        assert.deepStrictEqual(args, [30, 600, 50], 'base/max backoff converted to whole seconds, then the limit');
    });

    it('defaults the backoff window when no backoffOpts are passed', async function () {
        const db   = makeDb();
        const conn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        db.pool.getConnection.resolves(conn);
        await db.getPendingHubPushes(50);
        const args = conn.query.firstCall.args[1];
        assert.deepStrictEqual(args, [30, 600, 50], 'falls back to the same 30s/600s defaults HubPushQueue uses');
    });
});

// ---------------------------------------------------------------------------
// getCapabilitySnapshotValidators / isPubkeyInCapabilitySnapshot
// ---------------------------------------------------------------------------
describe('Database capability snapshot methods @regression @tier1', function () {
    it('getCapabilitySnapshotValidators returns mapped results', async function () {
        const db = makeDb();
        // Consensus input read on the hub mirror: routed through doQueryStrict so a
        // transient DB fault cannot collapse the capable set to empty on one node.
        sinon.stub(db, 'doQueryStrict').resolves([
            { pubkey: 'aa', amount: '5000' },
            { pubkey: 'bb', amount: null }
        ]);
        const result = await db.getCapabilitySnapshotValidators('cross_chain', 100);
        assert.deepStrictEqual(result[0], { pubkey: 'aa', amount: '5000' });
        // A NULL amount is coerced to '0' to match the sibling getCapabilitySnapshotWeights
        // and the BTC local path, so it never surfaces as the literal string 'null'.
        assert.deepStrictEqual(result[1], { pubkey: 'bb', amount: '0' });
    });

    it('isPubkeyInCapabilitySnapshot returns true when row found', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQueryStrict').resolves([{ 1: 1 }]);
        assert.strictEqual(await db.isPubkeyInCapabilitySnapshot('aa', 'cross_chain', 100), true);
    });

    it('isPubkeyInCapabilitySnapshot returns false when no row', async function () {
        const db = makeDb();
        sinon.stub(db, 'doQueryStrict').resolves([]);
        assert.strictEqual(await db.isPubkeyInCapabilitySnapshot('aa', 'cross_chain', 100), false);
    });
});
