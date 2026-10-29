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

// The mariadb driver's pool-acquire timeout, as the rail logged it.
function poolTimeout() {
    const e = new Error('(conn:-1, no: 45028, SQLState: HY000) pool timeout: failed to retrieve a ' +
                        'connection from pool after 10002ms');
    e.name = 'SqlError'; e.errno = 45028; e.code = 'ER_GET_CONNECTION_TIMEOUT'; e.sqlState = 'HY000';
    return e;
}

function connRefused() {
    const e = new Error('connect ECONNREFUSED 127.0.0.1:3306');
    e.code = 'ECONNREFUSED'; e.errno = -61;
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
        util: { sleep: async (ms) => { calls.sleeps.push(ms); } },
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
        const breaker = new Error('Circuit breaker open - database connections rejected until cooldown expires');
        const { calls, run } = makeLoop([wrapped, breaker, 'ok']);
        await run();
        assert.strictEqual(calls.passes, 3);
    });

    it('caps the backoff so the heartbeat keeps stamping through a long outage', async function () {
        const outcomes = Array.from({ length: 12 }, poolTimeout).concat(['ok']);
        const { calls, run } = makeLoop(outcomes);
        await run();
        assert.ok(Math.max(...calls.sleeps) <= 30000, 'no backoff sleep exceeds the cap');
    });

    it('exits the loop on stop during an outage without one more backoff sleep', async function () {
        const { calls, run } = makeLoop([poolTimeout()]);
        await run();
        assert.strictEqual(calls.passes, 1);
        assert.deepStrictEqual(calls.sleeps, []);
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
});
