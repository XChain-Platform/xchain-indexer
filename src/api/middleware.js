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
 * XChain Indexer - the HTTP middleware stack.
 *
 * Mounts, in this order: Helmet, CORS, the per-IP rate limit, the JSON body
 * parser, the default-off observability layer with the poll-freshness gauge, and
 * the API-key gate. Everything read from the environment arrives through the
 * apiContext() object src/api.js builds at boot.
 *
 ********************************************************************/

const bodyParser    = require('body-parser');
const helmet        = require('helmet');
const cors          = require('cors');
// Note: express-rate-limit is mounted per-IP below (INDEXER_RATE_LIMIT_RPM,
// default 600). The indexer API is intended to be internal-only (hub +
// xchain-node managed deployments), but the stock xchain-node topology can
// publish the port on all host interfaces, so a generous limiter keeps an
// anonymous loop off GET /status and the ungated JSON-RPC reads (each of which
// costs pooled DB round-trips) without affecting the handful of legitimate
// hub/explorer callers (see sibling services: decoder, encoder, explorer, hub).
const rateLimit     = require('express-rate-limit');
const { installObservability, getLogger } = require('../observability'); // default-off /metrics + structured log shim
const { installIndexerMetrics } = require('./indexer_metrics');  // poll-freshness heartbeat gauge
const { parseCorsOrigin } = require('./cors_origin.js');
const { apiKeyGate } = require('./auth_gate');

const JSON_RPC_MAX_BATCH = 100;

function isRpcObject(v){
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// An id-less element is a JSON-RPC notification the router answers with nothing,
// so a batch of only those (or {}) would come back as 200 []. Require the
// request shape the spec names: an object with a string method (the router
// itself answers a wrong jsonrpc version with an envelope that carries the id).
function isRpcRequest(v){
    return isRpcObject(v) && typeof v.method === 'string';
}

function jsonRpcBatchGuard(req, res, next){
    // A null body, an empty batch, or a batch element that is not a request object
    // would make the router throw or answer 200 [], so reject it here as
    // structured JSON.
    if(req.body === null || (Array.isArray(req.body) && (req.body.length === 0 || !req.body.every(isRpcRequest)))){
        return res.status(400).json({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32600, message: 'Invalid Request: a batch must be a non-empty array of request objects' }
        });
    }
    // Bound batch fan-out before the router dispatches any element.
    if(!Array.isArray(req.body) || req.body.length <= JSON_RPC_MAX_BATCH)
        return next();
    return res.status(413).json({
        jsonrpc: '2.0',
        id: null,
        error: {
            code: -32600,
            message: 'Invalid Request: batch exceeds ' + JSON_RPC_MAX_BATCH + ' elements'
        }
    });
}

// The whole stack, in mount order. The gate goes last so a gated call is refused
// only after the security headers, the rate limit and the body parse have run.
function installMiddleware(app, ctx){
    installSecurityLayers(app, ctx);
    installObservabilityLayers(app, ctx);
    app.use(apiKeyGate(ctx));
}

function classifyRpcError(err){
    if(err && err.type === 'entity.too.large')
        return { status: 413, code: -32600, message: 'Request body too large' };
    if(err && err.type === 'entity.parse.failed')
        return { status: 400, code: -32700, message: 'Parse error' };
    const status = err && Number(err.status || err.statusCode);
    if(status >= 400 && status < 500)
        return { status, code: -32600, message: 'Invalid Request' };
    return { status: 500, code: -32603, message: 'Internal error' };
}

// Mounted after every route so parser and application errors use one JSON-RPC
// envelope and Express never emits its HTML stack-trace response.
function rpcErrorHandler(err, req, res, next){
    if(res.headersSent) return next(err);
    const failure = classifyRpcError(err);
    if(failure.status >= 500)
        getLogger().error('[api] JSON-RPC request failed: ' + (err && err.message));
    else
        getLogger().warn('[api] rejected request body: ' + ((err && err.type) || 'request_error') + ' (' + failure.status + ')');
    return res.status(failure.status).json({
        jsonrpc: '2.0',
        error: { code: failure.code, message: failure.message },
        id: null
    });
}

function installSecurityLayers(app, { CONFIG_ENV }){
    // Use Helmet to increase security
    app.use(helmet());

    // Allow CORS (restricted to the configured allowlist, defaults to localhost).
    // CORS_ORIGIN is comma-separated, not a single origin: handing `cors` the raw
    // string makes it echo that string verbatim to every caller, a multi-value
    // header no browser accepts, so every listed origin is blocked while the
    // header reads as configured. See src/api/cors_origin.js.
    app.use(cors({
        origin: parseCorsOrigin(CONFIG_ENV.CORS_ORIGIN || 'http://localhost'),
        methods: ['POST']
    }));

    // Per-IP rate limit, mounted ahead of the body parser so a malformed (400) or
    // oversize (413) POST is counted and eventually refused like any other request,
    // generous by default (the real callers are a handful of
    // hub/explorer processes). Bounds an anonymous flood against GET /status and
    // the ungated JSON-RPC read methods, both of which cost pooled DB round-trips
    // per hit, so the perimeter assumption is no longer the only guard.
    app.use(rateLimit({
        windowMs: 60 * 1000,
        limit: parseInt(CONFIG_ENV.INDEXER_RATE_LIMIT_RPM) || 600,
        standardHeaders: true,
        legacyHeaders: false,
        // The default refusal is a text/html string. Answer with the same JSON-RPC
        // envelope as every other refusal; the limiter has already set the
        // Retry-After and RateLimit-* headers before calling the handler.
        handler: (req, res, next, options) => res.status(options.statusCode).json({
            jsonrpc: '2.0',
            error: { code: -32600, message: 'Too many requests, please try again later.' },
            id: null
        })
    }));

    // Allow JSON requests. inflate: false makes body-parser answer 415 to any
    // Content-Encoding body without running a decompressor, so the Brotli and gzip
    // decoders of the Node runtime are never reachable from a request body.
    //
    // The limit must sit above the largest action the explorer's preflight and
    // feequote proxy forward (390,000 characters of params, mirroring the
    // protocol envelope payload ceiling) plus the JSON wrapper, so no HTTP hop
    // refuses an action the indexer would have judged. Anything larger is still
    // refused with 413.
    app.use(bodyParser.json({ inflate: false, limit: '512kb' }));
    app.use(jsonRpcBatchGuard);
}

function installObservabilityLayers(app, { indexer, CONFIG_ENV, INDEXER_NETWORK }){
    // Prometheus /metrics plus a structured log shim, both DEFAULT OFF.
    // Nothing is registered and no timer starts unless METRICS_ENABLED (and, for
    // log shipping, LOG_SHIP_ENABLED + LOG_SHIP_URL) are set. The coin/network
    // labels let one Prometheus scrape distinguish the per-chain indexers.
    // See src/observability/README.md.
    let indexerVersion = '';
    try { indexerVersion = require('../../package.json').version; } catch { /* version label is cosmetic */ }
    const observability = installObservability(app, {
        service: 'xchain-indexer',
        version: indexerVersion,
        coin:    CONFIG_ENV.INDEXER_COIN || '',
        network: INDEXER_NETWORK || ''
    });

    // Poll-freshness heartbeat (item 9bee49e8). Commit recency lives in the
    // /status JSON only, so a wedged block poller leaves no trace on the scrape
    // and is undetectable if /status polling itself regresses. No-ops when
    // metrics are off (registry null unless METRICS_ENABLED).
    installIndexerMetrics(observability, indexer);
}

module.exports = { installMiddleware, rpcErrorHandler, jsonRpcBatchGuard, JSON_RPC_MAX_BATCH };
