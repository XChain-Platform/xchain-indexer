// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Pins the container exit path. `docker stop` sends SIGTERM to node (PID 1 via the
// Dockerfile's exec-form CMD) and this drain is everything that happens between
// that signal and the process ending, so the properties asserted here are the ones
// that decide whether a rolling upgrade aborts a MariaDB write transaction.

const assert = require('assert');
const { createShutdown, createIndexerDrain, closeServer, resolveTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS } = require('../../src/shutdown');

const silentLog = { log(){}, warn(){}, error(){} };

// Minimal XChainIndexer stand-in: records call ORDER, because the ordering is the
// contract (health flag before stop, pools closed last).
function makeIndexer(order){
    let resolveLoop;
    const loop = new Promise((res) => { resolveLoop = res; });
    const db = (name) => ({
        closed: false,
        async close(){ this.closed = true; order.push('close:' + name); }
    });
    return {
        stopped: false,
        indexerDb: db('indexerDb'),
        decoderDb: db('decoderDb'),
        hubDb:     db('hubDb'),
        loop,
        // The real stop() only sets stopFlag; the loop breaks at the next block
        // boundary, which the test models by resolving the loop promise later.
        stop(){ this.stopped = true; order.push('stop'); setImmediate(resolveLoop); }
    };
}

function makeServer(order){
    return {
        closed: false,
        idleDropped: false,
        close(cb){ this.closed = true; order.push('server.close'); setImmediate(cb); },
        closeIdleConnections(){ this.idleDropped = true; }
    };
}

describe('graceful shutdown', function(){

    describe('createShutdown', function(){

        it('runs the drain and exits zero when it completes', async function(){
            const codes = [];
            let drained = false;
            const shutdown = createShutdown({
                drain: async () => { drained = true; },
                exit: (c) => codes.push(c),
                log: silentLog
            });
            shutdown('SIGTERM');
            await new Promise((r) => setTimeout(r, 10));
            assert.strictEqual(drained, true);
            assert.deepStrictEqual(codes, [0]);
        });

        it('is idempotent: a second signal does not re-enter the drain', async function(){
            const codes = [];
            let calls = 0;
            const shutdown = createShutdown({
                drain: async () => { calls++; await new Promise((r) => setTimeout(r, 20)); },
                exit: (c) => codes.push(c),
                log: silentLog
            });
            shutdown('SIGTERM');
            shutdown('SIGTERM');
            shutdown('SIGINT');
            await new Promise((r) => setTimeout(r, 60));
            assert.strictEqual(calls, 1, 'drain must run exactly once');
            assert.deepStrictEqual(codes, [0]);
        });

        // The reason the handler is safe to install at all: registering one REMOVES
        // node's default terminate, so without this bound a hung drain turns every
        // stop into a container that lingers until the supervisor's grace expires.
        it('hard-exits non-zero when the drain overruns its budget', async function(){
            const codes = [];
            const shutdown = createShutdown({
                drain: () => new Promise(() => {}),   // never settles
                timeoutMs: 20,
                exit: (c) => codes.push(c),
                log: silentLog
            });
            shutdown('SIGTERM');
            await new Promise((r) => setTimeout(r, 80));
            assert.deepStrictEqual(codes, [1]);
        });

        it('exits non-zero when the drain throws, and only once', async function(){
            const codes = [];
            const shutdown = createShutdown({
                drain: async () => { throw new Error('pool refused to close'); },
                timeoutMs: 50,
                exit: (c) => codes.push(c),
                log: silentLog
            });
            shutdown('SIGTERM');
            await new Promise((r) => setTimeout(r, 120));
            assert.deepStrictEqual(codes, [1]);
        });

        it('does not fire the hard-exit timer after a clean drain', async function(){
            const codes = [];
            const shutdown = createShutdown({
                drain: async () => {},
                timeoutMs: 20,
                exit: (c) => codes.push(c),
                log: silentLog
            });
            shutdown('SIGTERM');
            await new Promise((r) => setTimeout(r, 80));
            assert.deepStrictEqual(codes, [0], 'a cleared timer must not add a second exit');
        });
    });

    describe('resolveTimeoutMs', function(){
        it('prefers an explicit budget, then the env var, then the default', function(){
            assert.strictEqual(resolveTimeoutMs(1234, {}), 1234);
            assert.strictEqual(resolveTimeoutMs(undefined, { SHUTDOWN_TIMEOUT_MS: '4321' }), 4321);
            assert.strictEqual(resolveTimeoutMs(undefined, {}), DEFAULT_SHUTDOWN_TIMEOUT_MS);
            assert.strictEqual(resolveTimeoutMs(0, { SHUTDOWN_TIMEOUT_MS: 'nonsense' }), DEFAULT_SHUTDOWN_TIMEOUT_MS);
        });

        it('stays under Docker\'s 10s default stop grace', function(){
            assert.ok(DEFAULT_SHUTDOWN_TIMEOUT_MS < 10000,
                'a budget at or above the grace period ends in the daemon\'s SIGKILL, which is what this replaces');
        });
    });

    describe('closeServer', function(){
        it('resolves once, and drops idle keep-alive sockets that would hold close() open', async function(){
            const order = [];
            const server = makeServer(order);
            await closeServer(server);
            assert.strictEqual(server.closed, true);
            assert.strictEqual(server.idleDropped, true);
        });

        it('resolves on a missing or closeless server rather than hanging the drain', async function(){
            await closeServer(null);
            await closeServer({});
        });
    });

    describe('createIndexerDrain', function(){

        it('flips health, stops the indexer, drains the server and loop, then closes pools', async function(){
            const order   = [];
            const indexer = makeIndexer(order);
            const server  = makeServer(order);
            let running   = true;

            const drain = createIndexerDrain({
                indexer,
                server,
                loopSettled: indexer.loop,
                onDraining: () => { running = false; order.push('health-flag'); },
                log: silentLog
            });
            await drain();

            assert.strictEqual(running, false, '/status must stop reporting the indexer running');
            assert.strictEqual(indexer.stopped, true);
            assert.strictEqual(server.closed, true);

            // The health flag must go down BEFORE stop(), because stop() only sets
            // stopFlag and the block loop can take a whole block to notice it.
            assert.ok(order.indexOf('health-flag') < order.indexOf('stop'),
                'health flag must flip before stop(), not after');
            // Pools close LAST: the HTTP drain and the block loop both still need them.
            for(const name of ['indexerDb', 'decoderDb', 'hubDb']){
                assert.ok(order.indexOf('close:' + name) > order.indexOf('server.close'),
                    name + ' must close after the server has drained');
                assert.ok(order.indexOf('close:' + name) > order.indexOf('stop'),
                    name + ' must close after the block loop was told to stop');
            }
            assert.ok(indexer.indexerDb.closed && indexer.decoderDb.closed && indexer.hubDb.closed);
        });

        it('waits for the block loop to break before closing pools', async function(){
            const order   = [];
            const indexer = makeIndexer(order);
            const server  = makeServer(order);

            let breakLoop;
            const loop = new Promise((res) => { breakLoop = res; });
            const drain = createIndexerDrain({ indexer, server, loopSettled: loop, log: silentLog });

            let settled = false;
            const running = drain().then(() => { settled = true; });

            await new Promise((r) => setTimeout(r, 30));
            assert.strictEqual(settled, false, 'the drain must not finish while the block loop is mid-block');
            assert.strictEqual(indexer.indexerDb.closed, false,
                'closing a pool under an open block transaction is the exact abort this fix removes');

            breakLoop();
            await running;
            assert.strictEqual(indexer.indexerDb.closed, true);
        });

        // start() is already .catch()'d at the call site, where a fatal error exits 1.
        // A rejection reaching the drain is that same handled error and must not turn a
        // clean stop into a hard exit.
        it('survives a rejected loop promise', async function(){
            const order   = [];
            const indexer = makeIndexer(order);
            const server  = makeServer(order);
            const drain = createIndexerDrain({
                indexer, server,
                loopSettled: Promise.reject(new Error('fatal indexer error')),
                log: silentLog
            });
            await drain();
            assert.strictEqual(indexer.indexerDb.closed, true);
        });

        it('drains a partially-built process without throwing', async function(){
            const drain = createIndexerDrain({ indexer: null, server: null, log: silentLog });
            await drain();
        });
    });
});
