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
 * One call, installObservability(app, { service }), gives an xchain-* service a
 * Prometheus /metrics endpoint plus a structured log shim. Both are DEFAULT
 * OFF: with no env set the call registers no route, starts no timer, opens no
 * socket, and returns a handle whose logger is a thin console passthrough. That
 * is deliberate. These services are consensus-critical and public-facing, so a
 * new listening surface has to be an operator decision, not a side effect of a
 * deploy.
 *
 * Env (all optional):
 *   METRICS_ENABLED=1        turn the endpoint on (default off)
 *   METRICS_PATH=/metrics    scrape path
 *   METRICS_TOKEN=...        require `Authorization: Bearer <token>` (timing-safe)
 *   METRICS_HTTP=1           also record per-request HTTP metrics (default on
 *                            when metrics are enabled; set 0 for endpoint-only)
 *   LOG_FORMAT=json          emit NDJSON log lines instead of plain text
 *   LOG_LEVEL=info           debug|info|warn|error
 *   LOG_SHIP_ENABLED=1 + LOG_SHIP_URL=...   POST NDJSON batches to a collector
 *   (see logShipper.js for the remaining LOG_SHIP_* tuning knobs)
 *
 * Deliberately NOT here: alerting and watchdog logic, which live with
 * /, and the fleet rollout of a Prometheus server plus a log
 * collector, which is an ops step.
 *
 * This module is canonical in xchain-hub. Edit it HERE, then re-run
 * xchain-hub/bin/sync-observability.sh to vendor it into the sibling services.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const { Registry, collectDefaultMetrics, DEFAULT_DURATION_BUCKETS } = require('./metrics');
const { createLogShipper, readLogEnv } = require('./logShipper');

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
        console: sink = console
    } = opts;

    const config = readObservabilityEnv(env);

    let registry = null;
    if (config.metricsEnabled) {
        registry = new Registry();
        collectDefaultMetrics(registry, { service, version, coin, network });
    }

    const logger = createLogShipper({ service, version, env, console: sink, registry, transport: opts.logTransport || null });

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

module.exports = {
    installObservability,
    readObservabilityEnv,
    routeLabel,
    Registry,
    collectDefaultMetrics,
    createLogShipper
};
