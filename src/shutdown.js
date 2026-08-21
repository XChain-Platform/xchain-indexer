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
 *
 * XChain Indexer - Graceful shutdown
 *
 * Bounded, idempotent drain for SIGTERM/SIGINT. The Dockerfile CMD runs node
 * as PID 1, so `docker stop` delivers SIGTERM here; without a handler node's
 * default action terminates the process wherever the block loop happens to be,
 * which for this service means killing a MariaDB write transaction on every
 * reboot and every rolling upgrade and leaving InnoDB crash recovery to clean
 * up. See the CMD comment in Dockerfile for why npm as PID 1 hid this.
 *
 * Registering a handler REMOVES node's default terminate, so every handler
 * built here carries its own hard-exit timer: a drain that hangs must still
 * end the process, or a stop becomes an indefinitely lingering container under
 * any supervisor with a long or unbounded grace period. That is strictly worse
 * than the SIGKILL this replaces, so the bound is not optional.
 *
 ********************************************************************/

// Hard-exit budget for the whole drain. Docker's default stop grace is 10s and
// xchain-node issues a bare `docker stop`, so the default sits under it: an
// overrun that ends in our own logged exit is diagnosable, one that ends in the
// daemon's SIGKILL is not. SHUTDOWN_TIMEOUT_MS overrides for a slow chain.
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8000;

function resolveTimeoutMs(timeoutMs, env){
    if(Number.isFinite(timeoutMs) && timeoutMs > 0) return timeoutMs;
    const raw = parseInt((env || process.env).SHUTDOWN_TIMEOUT_MS, 10);
    return (Number.isFinite(raw) && raw > 0) ? raw : DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

// Close an http.Server and resolve once it has stopped listening. Idle keep-alive
// sockets would otherwise hold close() open indefinitely while no request is in
// flight, so they are dropped explicitly; requests already being served are left
// to finish, which is the whole point of draining rather than exiting.
function closeServer(server){
    return new Promise((resolve) => {
        if(!server || typeof server.close !== 'function') return resolve();
        let settled = false;
        const done = () => { if(!settled){ settled = true; resolve(); } };
        try {
            server.close(done);
            if(typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
        } catch(_){
            done();
        }
    });
}

// Best-effort close of a set of Database handles, deduped by identity because one
// process can hold the same handle under two names. A pool that refuses to close
// must not abort the rest of the drain, so failures are logged and swallowed.
async function closeDatabases(handles, log){
    const logger = log || console;
    const seen = new Set();
    for(const db of (handles || [])){
        if(!db || typeof db.close !== 'function' || seen.has(db)) continue;
        seen.add(db);
        try { await db.close(); }
        catch(err){ logger.warn('Shutdown: closing a database pool failed: ' + (err && err.message ? err.message : err)); }
    }
}

/**
 * Build an idempotent signal handler that runs `drain` under a hard-exit bound.
 *
 * @param {object}   opts
 * @param {function} opts.drain      async work to finish before exiting
 * @param {number}   [opts.timeoutMs] hard-exit budget (default SHUTDOWN_TIMEOUT_MS / 8000)
 * @param {function} [opts.exit]     process-exit seam (tests pass their own)
 * @param {object}   [opts.log]      console-shaped logger
 * @returns {function(string): void} handler to register on SIGTERM / SIGINT
 */
function createShutdown({ drain, timeoutMs, exit, log } = {}){
    const onExit  = exit || ((code) => process.exit(code));
    const logger  = log || console;
    const budget  = resolveTimeoutMs(timeoutMs);
    let signalled = false;

    return function shutdown(signal){
        // A second signal must not restart the sequence: re-entering would call
        // stop() and close pools underneath a drain already using them, which is
        // the mid-transaction abort this handler exists to prevent.
        if(signalled){
            logger.log('Shutdown already in progress; ignoring ' + (signal || 'signal') + '.');
            return;
        }
        signalled = true;
        logger.log('Received ' + (signal || 'signal') + ', draining (hard exit in ' + budget + 'ms)...');

        let finished = false;
        const timer = setTimeout(() => {
            if(finished) return;
            finished = true;
            // Non-zero: the drain did NOT complete, so work was cut off exactly as a
            // SIGKILL would have cut it. A clean drain below exits 0.
            logger.error('Shutdown drain exceeded ' + budget + 'ms; exiting hard.');
            onExit(1);
        }, budget);

        Promise.resolve().then(() => drain()).then(
            () => {
                if(finished) return;
                finished = true;
                clearTimeout(timer);
                logger.log('Shutdown drain complete; exiting.');
                onExit(0);
            },
            (err) => {
                if(finished) return;
                finished = true;
                clearTimeout(timer);
                logger.error('Shutdown drain failed:', err);
                onExit(1);
            }
        );
    };
}

/**
 * The indexer's drain, as its own function so the exit path is unit-testable
 * (src/api.js runs startApi() at module load and cannot be required by a test).
 *
 * Order is load-bearing:
 *   1. flip the health flag FIRST, because stop() only sets stopFlag and the block
 *      loop can take a whole block to notice; answering /status healthy through
 *      that window is what makes a rolling upgrade drop traffic into a dying node.
 *   2. stop() the indexer (stopFlag + hub push queue).
 *   3. drain the HTTP server and the block loop together; the loop breaks at the
 *      block boundary checked in XChainIndexer.start(), never mid-transaction.
 *   4. close DB pools LAST, since both of the above still need them.
 *
 * The wait on step 3 is deliberately unbounded HERE and bounded by the caller's
 * hard-exit timer instead, because the only two ways it can overrun both end the
 * same way: a block slow enough to outlast the budget, and a boot still inside
 * db.js' bounded connect retry (5s per attempt), which never entered the loop at
 * all. In both the process leaves with a logged non-zero exit rather than a clean
 * one, which is correct - anything that exits before the loop breaks cut work off,
 * exactly as the SIGKILL did. Measured: a DB-less boot stopped mid-retry exits 1
 * at the budget instead of lingering.
 *
 * @param {object}   opts
 * @param {object}   opts.indexer      XChainIndexer instance
 * @param {object}   opts.server       http.Server returned by app.listen()
 * @param {Promise}  [opts.loopSettled] promise that settles when start()'s loop exits
 * @param {function} [opts.onDraining] flips the api-local indexerRunning flag
 * @param {object}   [opts.log]        console-shaped logger
 */
function createIndexerDrain({ indexer, server, loopSettled, onDraining, log } = {}){
    const logger = log || console;
    return async function drain(){
        if(typeof onDraining === 'function') onDraining();
        if(indexer && typeof indexer.stop === 'function') indexer.stop();

        await Promise.all([
            closeServer(server),
            // start() resolves when the block loop breaks on stopFlag. It is already
            // .catch()'d at the call site (a fatal indexer error exits 1 there), so a
            // rejection here is that same handled error and must not fail the drain.
            Promise.resolve(loopSettled).catch(() => {})
        ]);

        await closeDatabases(
            indexer ? [indexer.indexerDb, indexer.decoderDb, indexer.hubDb] : [],
            logger
        );
    };
}

module.exports = {
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    resolveTimeoutMs,
    closeServer,
    closeDatabases,
    createShutdown,
    createIndexerDrain
};
