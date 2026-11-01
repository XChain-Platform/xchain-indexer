// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

// The hub answers a capability proof over its shared BTC indexer budget as 429
// with Retry-After. The mirror client reads that wait off the response and holds
// its later proof GETs until it passes, instead of retrying into the refusal.

const assert = require('assert');
const http = require('http');
const sinon = require('sinon');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');

function makeSync(hubUrl = 'http://hub.test') {
    const hubDb = { doQuery: sinon.stub().resolves([]) };
    return new HubDbSync(hubDb, { hubUrl, network: 'regtest' });
}

function listen(handler) {
    return new Promise(resolve => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function rateLimited(retryAfterMs) {
    const error = new Error('HTTP 429');
    error.statusCode = 429;
    if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
    return error;
}

let server = null;
let clock = null;

function cleanup(done) {
    if (clock) clock.restore();
    clock = null;
    if (!server) return done();
    server.close(() => done());
    server = null;
}

async function readsRetryAfter() {
    server = await listen((req, res) => {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '7' });
        res.end(JSON.stringify({ error: 'PROOF_RATE_LIMITED' }));
    });
    const sync = makeSync('http://127.0.0.1:' + server.address().port);
    await assert.rejects(sync.httpGet('/hub-db/snapshot/capability_snapshot_proof'), error => {
        assert.strictEqual(error.message, 'HTTP 429');
        assert.strictEqual(error.statusCode, 429);
        assert.strictEqual(error.retryAfterMs, 7000);
        return true;
    });
}

async function carriesStatusWithoutWait() {
    let answers = [[503, {}], [429, {}], [429, { 'Retry-After': 'soon' }]];
    server = await listen((req, res) => {
        let [status, headers] = answers.shift();
        res.writeHead(status, headers);
        res.end('{}');
    });
    const sync = makeSync('http://127.0.0.1:' + server.address().port);
    for (let status of [503, 429, 429]) {
        await assert.rejects(sync.httpGet('/x'), error => {
            assert.strictEqual(error.statusCode, status);
            assert.strictEqual(error.retryAfterMs, undefined);
            return true;
        });
    }
}

async function holdsNextGet() {
    clock = sinon.useFakeTimers({ now: 1000 });
    const sync = makeSync();
    const startedAt = [];
    sinon.stub(sync, 'httpGet').callsFake(async () => {
        startedAt.push(Date.now());
        if (startedAt.length === 1) throw rateLimited(3000);
        return { proof: 'ok' };
    });

    await assert.rejects(sync.fetchCapabilitySnapshotProof(12, 'cross_chain', ['aa11']), /HTTP 429/);
    const next = sync.fetchCapabilitySnapshotProof(13, 'cross_chain', ['bb22']);
    await clock.tickAsync(2999);
    assert.deepStrictEqual(startedAt, [1000]);
    await clock.tickAsync(1);
    await next;
    assert.deepStrictEqual(startedAt, [1000, 4000]);
}

async function rereadsWait() {
    clock = sinon.useFakeTimers({ now: 1000 });
    const sync = makeSync();
    const startedAt = [];
    sinon.stub(sync, 'httpGet').callsFake(async () => {
        startedAt.push(Date.now());
        return { proof: 'ok' };
    });

    await sync.fetchCapabilitySnapshotProof(12, 'cross_chain', ['aa11']);
    const next = sync.fetchCapabilitySnapshotProof(13, 'cross_chain', ['bb22']);
    await clock.tickAsync(50);
    sync.deferCapabilityProofRequests(rateLimited(2000));
    await clock.tickAsync(1950);
    assert.deepStrictEqual(startedAt, [1000]);
    await clock.tickAsync(50);
    await next;
    assert.deepStrictEqual(startedAt, [1000, 3050]);
}

async function keepsSpacing() {
    clock = sinon.useFakeTimers({ now: 1000 });
    const sync = makeSync();
    const startedAt = [];
    sinon.stub(sync, 'httpGet').callsFake(async () => {
        startedAt.push(Date.now());
        if (startedAt.length === 1) {
            const error = new Error('HTTP 503');
            error.statusCode = 503;
            throw error;
        }
        return { proof: 'ok' };
    });

    await assert.rejects(sync.fetchCapabilitySnapshotProof(12, 'cross_chain', ['aa11']), /HTTP 503/);
    const next = sync.fetchCapabilitySnapshotProof(13, 'cross_chain', ['bb22']);
    await clock.tickAsync(110);
    await next;
    assert.deepStrictEqual(startedAt, [1000, 1110]);
}

describe('HubDbSync capability proof Retry-After', function () {
    afterEach(cleanup);
    it('reads the status and Retry-After of a hub 429 onto the rejection', readsRetryAfter);
    it('carries the status but no wait for a 503 or a 429 without a usable header', carriesStatusWithoutWait);
    it('holds the next proof GET until the Retry-After of a 429 has passed', holdsNextGet);
    it('re-reads the wait when a 429 lands while a later GET is already sleeping', rereadsWait);
    it('keeps the ordinary spacing after a failure that is not a rate limit', keepsSpacing);
});
