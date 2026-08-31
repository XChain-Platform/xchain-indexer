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
 * XChain shared observability - service wiring
 *
 * Two calls wire an xchain-* service up:
 *
 *   patchConsole({ service })       at the TOP of the entry file, before any
 *                                   line is logged; routes bare console.* calls
 *                                   through the shim so levels, formats and
 *                                   redaction apply without rewriting call
 *                                   sites.
 *   installObservability(app, ...)  where the Express app exists; adds the
 *                                   /metrics route and HTTP instrumentation.
 *
 * No socket and no route without env: METRICS_ENABLED alone opens the endpoint,
 * and shipping needs both LOG_SHIP_ENABLED and a URL. These services are
 * consensus-critical and public-facing, so a new listening surface stays an
 * operator decision rather than a side effect of a deploy. The metrics REGISTRY
 * is not gated, only the endpoint is: counters have to exist on the default
 * fleet or nothing can ever record into them.
 *
 * Env (all optional):
 *   METRICS_ENABLED=1        turn the endpoint on (default off)
 *   METRICS_PATH=/metrics    scrape path
 *   METRICS_TOKEN=...        require `Authorization: Bearer <token>` (timing-safe)
 *   METRICS_HTTP=1           also record per-request HTTP metrics (default on
 *                            when metrics are enabled; set 0 for endpoint-only)
 *   LOG_FORMAT=json          emit NDJSON log lines instead of plain text
 *   LOG_LEVEL=info           debug|info|warn|error
 *   XCHAIN_LOG_PATCH=0       leave console.* alone (test bootstraps set this)
 *   LOG_SHIP_ENABLED=1 + LOG_SHIP_URL=...   POST NDJSON batches to a collector
 *   (see logShipper.js for the remaining LOG_SHIP_* tuning knobs)
 *
 * Deliberately NOT here: alerting and watchdog logic, which live elsewhere,
 * and the fleet rollout of a Prometheus server plus a log collector, which
 * is an ops step.
 *
 * This module is canonical in xchain-hub. Edit it HERE, then re-run
 * xchain-hub/bin/sync-observability.sh to vendor it into the sibling services.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const util = require('util');
const { Registry, collectDefaultMetrics, DEFAULT_DURATION_BUCKETS } = require('./metrics');
const { createLogShipper, readLogEnv } = require('./logShipper');

// Process-wide handles. A service is one process loading exactly one vendored
// copy of this module, so module scope is the right scope: a globalThis key
// would buy nothing and would collide across a monorepo test run.
let _logger = null;
let _registry = null;
let _patched = null;
// The shipper's housekeeping counters (log_lines_emitted_total and friends)
// can only be registered once per registry. Now that the registry is shared and
// always constructed, a second shipper on it would throw at construction, which
// on the real wiring path (patchConsole at the top of api.js, then
// installObservability further down) would take the service out at startup.
let _shipperAttached = false;
// The bound pre-patch console. Every shipper built after patchConsole must
// write HERE, not to the global console: the shim's default sink is the global
// object by reference, so a second shipper taking that default would emit its
// formatted line INTO the patched console and get it formatted a second time
// (`<ts> warn [svc] <ts> warn [svc] msg`).
let _sink = null;

const CONSOLE_METHODS = { log: 'info', info: 'info', warn: 'warn', error: 'error', debug: 'debug' };

function toBool(v, fallback = false) {
    if (v === undefined || v === null || v === '') return fallback;
    return /^(1|true|yes|on)$/i.test(String(v));
}

function readObservabilityEnv(env = process.env) {
    const enabled = toBool(env.METRICS_ENABLED, false);
    let path = (env.METRICS_PATH || '/metrics').trim();
    if (!path.startsWith('/')) path = `/${path}`;
    return {
        metricsEnabled: enabled,
        metricsPath:    path,
        // Not logged anywhere; only compared timing-safely against the header.
        metricsToken:   env.METRICS_TOKEN || '',
        httpMetrics:    enabled && toBool(env.METRICS_HTTP, true),
        log:            readLogEnv(env)
    };
}

function timingSafeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    // Length is compared first because timingSafeEqual throws on a mismatch;
    // token length is not the secret.
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// Path label for HTTP metrics. Express route patterns ("/hub-db/snapshot/:t")
// are already low-cardinality; a raw URL is not, so anything without a matched
// route falls back to its first path segment. This is the difference between a
// dozen series and one per block height.
function routeLabel(req) {
    if (req.route && req.route.path) {
        const base = req.baseUrl || '';
        const p = `${base}${req.route.path}`;
        return p === '' ? '/' : p;
    }
    const raw = (req.originalUrl || req.url || '/').split('?')[0];
    const seg = raw.split('/').filter(Boolean)[0];
    return seg ? `/${seg}` : '/';
}

// Express dispatches its router stack in registration order, so a timing
// middleware added after a route never sees a request that route answers. The
// six services wire this call at different points in their api.js, so the layer
// is moved to the front of the stack instead of trusting call order: otherwise
// a service silently exports zero HTTP metrics. Best effort by design, since it
// reaches into Express internals; the middleware still works (for later routes)
// if the internals ever move.
function hoistToFront(app, handle) {
    try {
        const router = app.router || app._router;
        if (!router || !Array.isArray(router.stack)) return false;
        const idx = router.stack.findIndex((layer) => layer && layer.handle === handle);
        if (idx <= 0) return idx === 0;
        const [layer] = router.stack.splice(idx, 1);
        router.stack.unshift(layer);
        return true;
    } catch {
        return false;
    }
}

/**
 * Registers the metrics endpoint and HTTP instrumentation on an Express app.
 *
 * @param {object} app                Express application (may be null: logging-only use)
 * @param {object} opts
 * @param {string} opts.service       service name, e.g. 'xchain-hub'
 * @param {string} [opts.version]     package version, stamped on xchain_service_info
 * @param {string} [opts.coin]        BTC|LTC|DOGE for per-chain services
 * @param {string} [opts.network]     mainnet|testnet|regtest
 * @param {object} [opts.env]         env bag (defaults to process.env)
 * @returns {{enabled:boolean, registry:?Registry, logger:object, shutdown:function}}
 */
function installObservability(app, opts = {}) {
    const {
        service = 'xchain-service',
        version = '',
        coin    = '',
        network = '',
        env     = process.env,
        console: sink = null
    } = opts;

    const config = readObservabilityEnv(env);

    // The registry is ALWAYS constructed, and only the /metrics route is gated.
    // Building it under METRICS_ENABLED meant every counter a consensus module
    // registers "when metrics are on" simply did not exist on the default
    // fleet, which is every box: the counters were unreachable, not merely
    // unscraped. Registering series costs nothing until something renders them.
    const registry = getRegistry({ service, version, coin, network });

    // One process, one shipper. When patchConsole already built it and this
    // caller wants no special sink or transport, adopt it rather than running a
    // second one: two shippers would split the line counters and each hold
    // their own ship buffer.
    const adopt = _logger && !opts.console && !opts.logTransport;
    const logger = adopt
        ? _logger
        : newShipper({ service, version, env, console: sink, transport: opts.logTransport || null });
    if (!_logger) _logger = logger;

    if (!config.metricsEnabled || !app || typeof app.use !== 'function') {
        return {
            enabled:  false,
            config,
            registry,
            logger,
            shutdown: () => logger.stop()
        };
    }

    const httpRequests = registry.counter({
        name: 'http_requests_total',
        help: 'HTTP requests handled, by method, route and status class',
        labelNames: ['method', 'route', 'status']
    });
    const httpDuration = registry.histogram({
        name: 'http_request_duration_seconds',
        help: 'HTTP request latency in seconds',
        labelNames: ['method', 'route'],
        buckets: DEFAULT_DURATION_BUCKETS
    });
    const inFlight = registry.gauge({
        name: 'http_requests_in_flight',
        help: 'HTTP requests currently being served'
    });

    if (config.httpMetrics) {
        const timing = (req, res, next) => {
            // The scrape itself is excluded: counting it makes every dashboard
            // show traffic that is only the monitoring system.
            if ((req.path || req.url || '').split('?')[0] === config.metricsPath) return next();
            const stop = process.hrtime.bigint();
            inFlight.inc({}, 1);
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                inFlight.dec({}, 1);
                const seconds = Number(process.hrtime.bigint() - stop) / 1e9;
                const route  = routeLabel(req);
                const method = (req.method || 'GET').toUpperCase();
                try {
                    httpDuration.observe({ method, route }, seconds);
                    httpRequests.inc({ method, route, status: String(res.statusCode) }, 1);
                } catch { /* instrumentation must never break a response */ }
            };
            // 'close' covers a client that hangs up before 'finish' fires, which
            // would otherwise leak the in-flight gauge upward forever.
            res.on('finish', finish);
            res.on('close', finish);
            next();
        };
        app.use(timing);
        hoistToFront(app, timing);
    }

    app.get(config.metricsPath, (req, res) => {
        if (config.metricsToken) {
            const header = req.headers.authorization || '';
            const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
            if (!presented || !timingSafeEqual(presented, config.metricsToken)) {
                res.set('WWW-Authenticate', 'Bearer');
                return res.status(401).type('text/plain').send('unauthorized\n');
            }
        }
        let body;
        try {
            body = registry.render();
        } catch (err) {
            logger.error('metrics render failed', { err: err.message });
            return res.status(500).type('text/plain').send('# metrics render failed\n');
        }
        res.set('Content-Type', registry.contentType());
        res.set('Cache-Control', 'no-store');
        return res.status(200).send(body);
    });

    return {
        enabled: true,
        config,
        registry,
        logger,
        shutdown: () => logger.stop()
    };
}

/**
 * The process's metrics registry, created on first ask. Consensus modules
 * register counters at require time, long before installObservability runs,
 * so this must not depend on the wiring order of any api.js.
 */
function getRegistry(info = {}) {
    if (!_registry) {
        _registry = new Registry();
        collectDefaultMetrics(_registry, {
            service: info.service || 'xchain-service',
            version: info.version || '',
            coin:    info.coin    || '',
            network: info.network || ''
        });
    }
    return _registry;
}

// Returned once and resolved on every call, so a module can do
// `const log = getLogger()` at require time and still reach the real shipper
// once patchConsole/installObservability has run. Before either, it falls
// through to the global console rather than throwing: a module that logs while
// being required must not be able to kill the process.
const _lazyLogger = {
    log(level, msg, fields) {
        if (_logger) return _logger.log(level, msg, fields);
        const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
        fn(fields && Object.keys(fields).length ? `${msg} ${util.inspect(fields, { depth: 2 })}` : String(msg));
        return null;
    },
    debug(msg, fields) { return this.log('debug', msg, fields); },
    info(msg, fields)  { return this.log('info',  msg, fields); },
    warn(msg, fields)  { return this.log('warn',  msg, fields); },
    error(msg, fields) { return this.log('error', msg, fields); }
};

function getLogger() { return _lazyLogger; }

// Attaches the shared registry to the FIRST shipper only; later shippers get
// their own line accounting and leave the shared series alone.
function newShipper(opts) {
    const registry = _shipperAttached ? null : getRegistry(opts);
    if (registry) _shipperAttached = true;
    return createLogShipper({ ...opts, console: opts.console || _sink || console, registry });
}

/**
 * Routes the service's existing bare console.* calls through the log shim, so
 * levels, formats and redaction apply to the ~850 hub call sites and their
 * siblings without rewriting one of them.
 *
 * Called at the TOP of an entry file, before anything logs. Every service logs
 * before installObservability runs today (hub api.js:29 vs :407, and the same
 * shape in the decoder, indexer, encoder and tracker), and the lines that get
 * lost that way are the env-validation and crash lines an operator most needs
 * framed. That is why this is a separate call rather than part of install.
 *
 * Set XCHAIN_LOG_PATCH=0 to disable, which is what each repo's test bootstrap
 * does: the suites stub and reassign console freely, and they must see stock
 * console regardless of require order.
 *
 * @param {object} opts
 * @param {string} opts.service   service name stamped on every line
 * @returns {{patched:boolean, logger:object, unpatch:function}}
 */
function patchConsole(opts = {}) {
    const { service = 'xchain-service', version = '', coin = '', network = '', env = process.env } = opts;

    if (_patched) return _patched;
    if (String(env.XCHAIN_LOG_PATCH || '') === '0') {
        return { patched: false, logger: getLogger(), unpatch: () => {} };
    }

    // Bind the originals into a NEW object BEFORE replacing anything. The shim's
    // default sink is the global console object by reference, so handing the
    // logger the live console and then patching it makes every line recurse
    // into itself.
    const sink = {};
    const originals = {};
    for (const name of Object.keys(CONSOLE_METHODS)) {
        const fn = typeof console[name] === 'function' ? console[name] : console.log;
        originals[name] = console[name];
        sink[name] = fn.bind(console);
    }
    sink.log = sink.log || sink.info;
    _sink = sink;

    const logger = newShipper({ service, version, coin, network, env, console: sink });
    _logger = logger;

    for (const [name, level] of Object.entries(CONSOLE_METHODS)) {
        // util.format is console's own argument semantics: printf-style format
        // strings resolve (about 40 hub sites use them) and a trailing Error
        // keeps its stack. A trailing object is NOT promoted into fields;
        // structured fields come from getLogger(), never from a guess about
        // what a console call meant.
        console[name] = (...args) => { logger.log(level, util.format(...args)); };
    }

    _patched = {
        patched: true,
        logger,
        unpatch() {
            for (const [name, fn] of Object.entries(originals)) {
                if (fn === undefined) delete console[name];
                else console[name] = fn;
            }
            _patched = null;
            _sink = null;
            if (_logger === logger) _logger = null;
        }
    };
    return _patched;
}

function unpatchConsole() { if (_patched) _patched.unpatch(); }

// Tests only: drops the process-wide handles so an assertion about a fresh
// process does not inherit the previous test's shipper or registry.
function _resetObservability() {
    unpatchConsole();
    _logger = null;
    _registry = null;
    _shipperAttached = false;
}

module.exports = {
    installObservability,
    readObservabilityEnv,
    routeLabel,
    Registry,
    collectDefaultMetrics,
    createLogShipper,
    patchConsole,
    unpatchConsole,
    getLogger,
    getRegistry,
    _resetObservability
};
