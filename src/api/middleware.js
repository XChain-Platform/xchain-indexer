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
 * Mounts, in this order: Helmet, the JSON body parser, CORS, the per-IP rate
 * limit, the default-off observability layer with the poll-freshness gauge, and
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
const { installObservability } = require('../observability');   // default-off /metrics + structured log shim
const { installIndexerMetrics } = require('./indexer_metrics');  // poll-freshness heartbeat gauge
const { parseCorsOrigin } = require('./cors_origin.js');
const { apiKeyGate } = require('./auth_gate');

// The whole stack, in mount order. The gate goes last so a gated call is refused
// only after the security headers, the body parse and the rate limit have run.
function installMiddleware(app, ctx){
    installSecurityLayers(app, ctx);
    installObservabilityLayers(app, ctx);
    app.use(apiKeyGate(ctx));
}

function installSecurityLayers(app, { CONFIG_ENV }){
    // Use Helmet to increase security
    app.use(helmet());

    // Allow JSON requests
    app.use(bodyParser.json());

    // Allow CORS (restricted to the configured allowlist, defaults to localhost).
    // CORS_ORIGIN is comma-separated, not a single origin: handing `cors` the raw
    // string makes it echo that string verbatim to every caller, a multi-value
    // header no browser accepts, so every listed origin is blocked while the
    // header reads as configured. See src/api/cors_origin.js.
    app.use(cors({
        origin: parseCorsOrigin(CONFIG_ENV.CORS_ORIGIN || 'http://localhost'),
        methods: ['POST']
    }));

    // Per-IP rate limit, generous by default (the real callers are a handful of
    // hub/explorer processes). Bounds an anonymous flood against GET /status and
    // the ungated JSON-RPC read methods, both of which cost pooled DB round-trips
    // per hit, so the perimeter assumption is no longer the only guard.
    app.use(rateLimit({
        windowMs: 60 * 1000,
        limit: parseInt(CONFIG_ENV.INDEXER_RATE_LIMIT_RPM) || 600,
        standardHeaders: true,
        legacyHeaders: false
    }));
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

module.exports = { installMiddleware };
