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
 * Harness for the REST /status smoke suites: a minimal Express app mounting the
 * same GET /status route as src/api.js over a stub indexer, a listener on an
 * ephemeral loopback port, and the GET helper the suites read it with. The
 * /status suite (test/smoke/connected/api_status.test.js) and the hub-mirror
 * suite beside it (../hub_mirror.test.js) build the route through this one copy.
 */

'use strict';

const http       = require('http');
const express    = require('express');
const helmet     = require('helmet');

// Standalone copy of src/XChainIndexer.js stallWedged (the smoke harness deliberately
// reconstructs the route rather than importing the module, which pulls in native DB
// deps). The canonical function is unit-tested in test/unit/stall_health.test.js.
function stallWedged(stallReason, lastBlockCommittedAt, graceMs, now, stallClearsAtMs = null){
    if(!stallReason) return false;
    if(lastBlockCommittedAt == null) return false;
    if(Number.isFinite(stallClearsAtMs) && now < stallClearsAtMs) return false;
    return (now - lastBlockCommittedAt) > graceMs;
}

// Standalone copies of the status discriminators, same rationale as above; the
// canonical functions are unit-tested in test/unit/stall_health.test.js.
function waitingOnFutureBlock(stallReason, stallClearsAtMs, now){
    if(!stallReason) return false;
    if(!Number.isFinite(stallClearsAtMs)) return false;
    return now < stallClearsAtMs;
}

function stallClassOf(stallReason, lastBlockCommittedAt, graceMs, now, stallClearsAtMs = null){
    if(!stallReason) return 'none';
    if(waitingOnFutureBlock(stallReason, stallClearsAtMs, now)) return 'future_block_wait';
    if(stallWedged(stallReason, lastBlockCommittedAt, graceMs, now, stallClearsAtMs)) return 'wedged';
    return 'barrier_defer';
}

function atProcessableTip(isSynced, stallReason, stallClearsAtMs, now){
    return !!isSynced || waitingOnFutureBlock(stallReason, stallClearsAtMs, now);
}

// ---------------------------------------------------------------------------
// Helper: GET a path and return { status, body }
// ---------------------------------------------------------------------------
function getJson(port, path) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path,
            method: 'GET',
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end',  () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data) });
                } catch (e) {
                    reject(new Error('Failed to parse response JSON: ' + data));
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// Build an app mounting the same /status handler as src/api.js against the
// supplied stub indexer. Mirrors the api.js route logic (the smoke harness
// reconstructs the route rather than importing api.js, which auto-starts).
function buildApp(indexer) {
    const app = express();
    app.use(helmet());
    app.get('/status', async (req, res) => {
        let indexerBlock = null;
        let indexerDbUnreachable = false;
        try {
            if(indexer.indexerDb)
                indexerBlock = await indexer.indexerDb.getLatestBlockIndex();
        } catch (err) {
            // Database unreachable; leave indexerBlock null so lag stays null.
            indexerDbUnreachable = true;
        }
        let decoderBlock = (indexer.lastDecoderBlock != null) ? Number(indexer.lastDecoderBlock) : null;
        // Same status-code contract as api.js: 503 on DB-unreachable/wedge so the
        // http_get container healthcheck can observe unhealthy; a not-synced catch-up
        // AND a stalled-but-still-advancing barrier defer (degraded) both stay 200.
        let now       = Date.now();
        let stalled   = !!indexer.stallReason;
        let wedged    = stallWedged(indexer.stallReason, indexer.lastBlockCommittedAt,
                                    indexer.healthStallGraceMs, now, indexer.stallClearsAt);
        // Hub mirror connectivity (row 48, attest-response-mirror spec), mirroring api.js:
        // absent hubDbSync (single-host deployment) or a throwing snapshot both degrade to
        // the same honest disabled shape rather than fail the whole probe or claim connected.
        let hubMirror;
        try {
            hubMirror = indexer.hubDbSync
                ? indexer.hubDbSync.mirrorStatus()
                : { configured: false, connected: false, bootstrapped: false, streamWatermark: null, tables: {} };
        } catch (err) {
            hubMirror = { configured: false, connected: false, bootstrapped: false, streamWatermark: null, tables: {} };
        }
        let unhealthy = indexerDbUnreachable || wedged;
        res.status(unhealthy ? 503 : 200).json({
            indexerBlock: indexerBlock,
            decoderBlock: decoderBlock,
            lag:          (decoderBlock != null && indexerBlock != null)
                            ? decoderBlock - indexerBlock
                            : null,
            isSynced:     indexer.isSynced(),
            atProcessableTip: atProcessableTip(indexer.isSynced(), indexer.stallReason,
                                               indexer.stallClearsAt, now),
            stallReason:  indexer.stallReason || null,
            stallClearsAt: indexer.stallClearsAt || null,
            degraded:     stalled && !wedged,
            waitingOnFutureBlock: waitingOnFutureBlock(indexer.stallReason, indexer.stallClearsAt, now),
            stallClass:   stallClassOf(indexer.stallReason, indexer.lastBlockCommittedAt,
                                       indexer.healthStallGraceMs, now, indexer.stallClearsAt),
            lastBlockCommittedAt: indexer.lastBlockCommittedAt || null,
            hubMirror:    hubMirror
        });
    });
    return app;
}

// Serve a fresh app for one stub indexer on an ephemeral loopback port, so each
// case gets its own route state and cases never collide on a port.
function listen(indexer) {
    return new Promise((resolve) => {
        const server = buildApp(indexer).listen(0, '127.0.0.1', () => {
            resolve({ server, port: server.address().port });
        });
    });
}

module.exports = { getJson, listen };
