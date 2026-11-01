/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/xchain_indexer/block_loop_db_outage.test.js
 *
 * A short MariaDB pause made the indexer exit: a pool timeout that escaped a poll pass
 * rejected runBlockLoop, start() rejected, and api.js called process.exit(1), so every
 * DB blip cost a container restart while the hub and decoders rode it out. The block
 * loop now backs off and runs the next pass, which re-reads its cursors from the
 * committed tables. Any other error, an open transaction, or an outage past the give-up
 * window still rejects, so the fatal path is unchanged for them.
 */

'use strict';

const assert = require('assert');

const XChainIndexer = require('../../../src/XChainIndexer.js');
const { isDbOutageError } = XChainIndexer;
const { buildReplayMarker, advanceReplayMarker } =
    require('../../../src/consensus/retroactive/replay_marker.js');

// The mariadb driver's pool-acquire timeout, as the rail logged it.
function poolTimeout() {
    const e = new Error('(conn:-1, no: 45028, SQLState: HY000) pool timeout: failed to retrieve a ' +
                        'connection from pool after 10002ms');
    e.name = 'SqlError'; e.errno = 45028; e.code = 'ER_GET_CONNECTION_TIMEOUT'; e.sqlState = 'HY000';
    return e;
}

function connRefused() {
    const e = new Error('connect ECONNREFUSED 127.0.0.1:3306');
    e.name = 'SqlError'; e.code = 'ECONNREFUSED'; e.errno = -61;
    return e;
}

function lostSocket() {
    const e = new Error('(conn:7, no: 45009, SQLState: 08S01) socket has unexpectedly been closed');
    e.name = 'SqlError'; e.errno = 45009; e.code = 'ER_SOCKET_UNEXPECTED_CLOSE';
    return e;
}

// A minimal indexer double running the real runBlockLoop. `outcomes` is the sequence of
// pass results: an Error rejects that pass, anything else resolves it, and the pass
// after the last outcome sets stopFlag.
function makeLoop(outcomes, { config = {}, indexerDb } = {}) {
    const calls = { passes: 0, sleeps: [] };
    const ix = {
        config: Object.assign({ BLOCK_CHECK_INTERVAL: 1000 }, config),
        stopFlag: false,
        indexerDb: indexerDb || { transactionConnection: null, apiView() { return this; } },
        util: {
            isNull: value => value === null || value === undefined,
            sleep: async (ms) => { calls.sleeps.push(ms); }
        },
        async pollDecoderOnce() {
            const outcome = outcomes[calls.passes++];
            if (calls.passes >= outcomes.length) this.stopFlag = true;
            if (outcome instanceof Error) throw outcome;
        },
        rideOutDbOutage: XChainIndexer.prototype.rideOutDbOutage,
    };
    const run = () => XChainIndexer.prototype.runBlockLoop.call(ix);
    return { ix, calls, run };
}

describe('the block loop rides out a database outage instead of exiting @regression @tier1', function () {
    let realExit, exits;
    beforeEach(function () {
        exits = 0;
        realExit = process.exit;
        process.exit = () => { exits++; };
    });
    afterEach(function () { process.exit = realExit; });

    it('keeps running through pool timeouts and a refused connection, then resumes', async function () {
        const { ix, calls, run } = makeLoop([poolTimeout(), connRefused(), 'ok']);
        await run();
        assert.strictEqual(calls.passes, 3, 'the loop must run a pass after each outage failure');
        assert.deepStrictEqual(calls.sleeps.slice(0, 2), [1000, 2000], 'outage passes back off and grow');
        assert.strictEqual(ix.dbOutage, null, 'a successful pass clears the outage record');
        assert.strictEqual(exits, 0);
    });

    it('treats the wrapped beginTransaction form and the circuit breaker refusal as an outage', async function () {
        const wrapped = new Error('beginTransaction error=' + String(poolTimeout()));
        const breaker = new Error('beginTransaction error=Error: Circuit breaker open - database connections rejected until cooldown expires');
        const { calls, run } = makeLoop([wrapped, breaker, 'ok']);
        await run();
        assert.strictEqual(calls.passes, 3);
    });

    it('names the driver errno of a wrapped beginTransaction pool timeout in the outage class', async function () {
        const wrapped = new Error('beginTransaction error=' + String(poolTimeout()));
        const { ix, run } = makeLoop([wrapped]);
        await run();
        assert.strictEqual(ix.dbOutage.lastErrorClass, 'MARIADB_45028');
    });

    it('rides out a lost database socket before rollback or replay writes begin', async function () {
        const { calls, run } = makeLoop([lostSocket(), 'ok']);
        await run();
        assert.strictEqual(calls.passes, 2);
    });
});

describe('the block loop rides out a database outage instead of exiting @regression @tier1', function () {
    let realExit, exits;
    beforeEach(function () {
        exits = 0;
        realExit = process.exit;
        process.exit = () => { exits++; };
    });
    afterEach(function () { process.exit = realExit; });

    it('rejects a lost database socket after a reorg rollback begins', async function () {
        const { ix, run } = makeLoop([]);
        let rollbackStarted = false;
        ix.rollback = {
            async rollback() {
                rollbackStarted = true;
                ix.stopFlag = true;
                throw lostSocket();
            }
        };
        ix.decoderDb = { getReorgEventWitness: async () => null };
        ix.pollDecoderOnce = async function (view) {
            await XChainIndexer.prototype.applyPendingReorgs.call(this, view,
                [{ id: 9, block_index: 100 }], 101);
        };

        await assert.rejects(run(), /socket has unexpectedly been closed/);
        assert.strictEqual(rollbackStarted, true);
    });
});

describe('the block loop rides out a database outage instead of exiting @regression @tier1', function () {
    let realExit, exits;
    beforeEach(function () {
        exits = 0;
        realExit = process.exit;
        process.exit = () => { exits++; };
    });
    afterEach(function () { process.exit = realExit; });

    it('marks replay witness and marker appends as restart-only work', async function () {
        const writeError = lostSocket();
        const view = { doQueryStrict: async () => { throw writeError; } };
        const ix = Object.create(XChainIndexer.prototype);
        Object.assign(ix, {
            decoderDb: { apiView() { return this; } },
            replayWitnessPhase: null,
            replayWitness: null,
            replayMarker: advanceReplayMarker(buildReplayMarker({
                target: 10,
                replayTo: 20,
                rulesFrom: 'a'.repeat(64),
                rulesTo: 'b'.repeat(64)
            }), 'replaying')
        });
        const phase = {
            phase: 'diverged',
            target: 10,
            replay_to: 20,
            rules_from: 'a'.repeat(64),
            window_count: 1,
            map_count: 1
        };

        await assert.rejects(ix.replayWitnessDeps(view).recordWitnessPhase('c'.repeat(64), phase),
            /socket has unexpectedly been closed/);
        assert.strictEqual(ix._passRestartOnFault, true);

        ix._passRestartOnFault = false;
        await assert.rejects(ix.completeRetroactiveReplay(view, 20),
            /socket has unexpectedly been closed/);
        assert.strictEqual(ix._passRestartOnFault, true);
    });
});

describe('the block loop rides out a database outage instead of exiting @regression @tier1', function () {
    let realExit, exits;
    beforeEach(function () {
        exits = 0;
        realExit = process.exit;
        process.exit = () => { exits++; };
    });
    afterEach(function () { process.exit = realExit; });

    it('caps the backoff so the heartbeat keeps stamping through a long outage', async function () {
        const outcomes = Array.from({ length: 12 }, poolTimeout).concat(['ok']);
        const { calls, run } = makeLoop(outcomes);
        await run();
        assert.ok(Math.max(...calls.sleeps) <= 30000, 'no backoff sleep exceeds the cap');
    });

    it('exits the loop on stop during an outage without one more backoff sleep', async function () {
        const { ix, calls, run } = makeLoop([poolTimeout()]);
        await run();
        assert.strictEqual(calls.passes, 1);
        assert.deepStrictEqual(calls.sleeps, []);
        assert.strictEqual(ix.dbOutage.lastErrorClass, 'ER_GET_CONNECTION_TIMEOUT');
    });

    it('control: a non-database error still rejects the loop, so the fatal path is intact', async function () {
        const { calls, run } = makeLoop([new Error('boom'), 'ok']);
        await assert.rejects(run(), /boom/);
        assert.strictEqual(calls.passes, 1);
    });

    it('control: an outage with a transaction left open on indexerDb still rejects', async function () {
        const indexerDb = { transactionConnection: {}, apiView() { return this; } };
        const { run } = makeLoop([poolTimeout(), 'ok'], { indexerDb });
        await assert.rejects(run(), /pool timeout/);
    });

    it('control: an outage past the give-up window rejects for the supervisor restart', async function () {
        const { ix, run } = makeLoop([poolTimeout(), 'ok'], { config: { DB_OUTAGE_GIVE_UP_MS: 1 } });
        ix.dbOutage = { since: Date.now() - 1000, failures: 40 };
        await assert.rejects(run(), /pool timeout/);
    });
});

describe('isDbOutageError names only database outages', function () {
    it('matches driver, socket, wrapped, cause-chained and breaker errors', function () {
        assert.ok(isDbOutageError(poolTimeout()));
        assert.ok(isDbOutageError(connRefused()));
        assert.ok(isDbOutageError(new Error('beginTransaction error=' + String(poolTimeout()))));
        assert.ok(isDbOutageError(new Error('outer', { cause: connRefused() })));
        assert.ok(isDbOutageError(new Error('Circuit breaker opened after 5 consecutive failures - cooling down for 30s')));
        assert.ok(isDbOutageError(new Error('Could not connect to MariaDB after 30 attempts. Giving up.')));
    });

    it('does not match a logic or SQL error', function () {
        assert.ok(!isDbOutageError(new Error('boom')));
        const dup = new Error("(conn:12, no: 1062, SQLState: 23000) Duplicate entry '1' for key 'PRIMARY'");
        dup.errno = 1062; dup.code = 'ER_DUP_ENTRY';
        assert.ok(!isDbOutageError(dup));
        assert.ok(!isDbOutageError(null));
    });

    it('does not classify hub or tracker socket failures as database outages', function () {
        assert.strictEqual(isDbOutageError(new Error('hub HTTP ECONNREFUSED')), false);
        const http = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8080'), {
            code: 'ECONNREFUSED'
        });
        assert.strictEqual(isDbOutageError(http), false);
    });

    it('does not classify a wrapped pool timeout whose text names access denied as an outage', function () {
        const wrapped = new Error('beginTransaction error=SqlError: (conn:-1, no: 45028, SQLState: HY000) ' +
            'pool timeout: failed to retrieve a connection from pool after 10000ms; ' +
            '(conn:-1, no: 1045, SQLState: 28000) Access denied for user');
        assert.strictEqual(isDbOutageError(wrapped), false);
    });

    it('does not classify a pool timeout caused by access denied as an outage', function () {
        const denied = Object.assign(new Error('(conn:-1, no: 1045, SQLState: 28000) Access denied'), {
            name: 'SqlError', errno: 1045, code: 'ER_ACCESS_DENIED_ERROR'
        });
        const outer = poolTimeout();
        outer.cause = denied;
        assert.strictEqual(isDbOutageError(outer), false);
    });
});
