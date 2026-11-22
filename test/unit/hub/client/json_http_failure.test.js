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
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const http = require('http');
const sinon = require('sinon');
const HubClient = require('../../../../src/hub/hub_client.js');
const HubPushQueue = require('../../../../src/hub/hub_push_queue.js');

function startHub(reply) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => reply(JSON.parse(body), res));
        });
        server.listen(0, '127.0.0.1', () => resolve({
            server,
            url: 'http://127.0.0.1:' + server.address().port + '/'
        }));
    });
}

function closeHub(hub) {
    return new Promise(resolve => hub.server.close(resolve));
}

function jsonReply(status, body, headers) {
    return (_req, res) => {
        res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers));
        res.end(JSON.stringify(body));
    };
}

async function clientError(reply) {
    const hub = await startHub(reply);
    try {
        const client = new HubClient(hub.url, '');
        return await client.pushPriceBatch({ source_chain: 'BTC', rounds: [] })
            .then(() => null, err => err);
    } finally {
        await closeHub(hub);
    }
}

function queueDb(row) {
    return {
        getPendingHubPushes: sinon.stub().resolves([row]),
        recordHubPushAttempt: sinon.stub().resolves(),
        markHubPushDelivered: sinon.stub().resolves()
    };
}

async function driveQueue(reply) {
    const hub = await startHub(reply);
    const indexerDb = queueDb({
        id: 1,
        push_type: 'price_batch',
        payload: JSON.stringify({ source_chain: 'BTC', rounds: [] }),
        attempts: 0,
        last_attempted_at: null
    });
    const queue = new HubPushQueue({ hubClient: new HubClient(hub.url, ''), indexerDb },
        { failedRetentionSec: 0 });
    try {
        await queue.drain();
        return { indexerDb, queue };
    } finally {
        await closeHub(hub);
    }
}

describe('hub transport rejects JSON HTTP failures @regression @tier1', function () {
    it('rejects a JSON 503 as retryable transport failure', async function () {
        const err = await clientError(jsonReply(503, { message: 'Service Unavailable' }));
        assert.ok(err);
        assert.strictEqual(err.httpStatus, 503);
        assert.strictEqual(err.rateLimited, undefined);
        assert.strictEqual(err.rpcCode, undefined);
        assert.match(err.message, /HTTP 503/);
    });

    it('classifies an envelope-less JSON 429 from its headers', async function () {
        const err = await clientError(jsonReply(429, { message: 'Too Many Requests' }, {
            'Retry-After': '30',
            'RateLimit-Limit': '100'
        }));
        assert.ok(err);
        assert.strictEqual(err.rateLimited, true);
        assert.strictEqual(err.httpStatus, 429);
        assert.strictEqual(err.retryAfterMs, 30000);
        assert.strictEqual(err.hubRateLimit, 100);
        assert.match(err.message, /JSON body without a JSON-RPC error/);
    });

    it('keeps a JSON-RPC error authoritative even on HTTP 400', async function () {
        const hub = await startHub(jsonReply(400, {
            jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' }
        }));
        try {
            const err = await new HubClient(hub.url, '').call('pushpricebatch', {})
                .then(() => null, rejection => rejection);
            assert.ok(err);
            assert.strictEqual(err.httpStatus, 400);
            assert.strictEqual(err.rpcCode, -32602);
        } finally {
            await closeHub(hub);
        }
    });
});

describe('hub transport requires JSON success acknowledgements @regression @tier1', function () {
    it('accepts result responses and rejects missing acknowledgements', async function () {
        let hub = await startHub((req, res) => jsonReply(200,
            { jsonrpc: '2.0', id: req.id, result: { accepted: true } })(req, res));
        try {
            const result = await new HubClient(hub.url, '').pushPriceBatch({});
            assert.deepStrictEqual(result, { accepted: true });
        } finally {
            await closeHub(hub);
        }

        hub = await startHub((req, res) => jsonReply(200,
            { jsonrpc: '2.0', id: req.id })(req, res));
        try {
            const err = await new HubClient(hub.url, '').call('pushpricebatch', {})
                .then(() => null, rejection => rejection);
            assert.match(err.message, /neither result nor error/);
        } finally {
            await closeHub(hub);
        }

        hub = await startHub(jsonReply(200, { message: 'ok' }));
        try {
            const err = await new HubClient(hub.url, '').call('pushpricebatch', {})
                .then(() => null, rejection => rejection);
            assert.match(err.message, /neither result nor error/);
        } finally {
            await closeHub(hub);
        }
    });
});

describe('HubPushQueue preserves rows across JSON HTTP failures @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('keeps the durable row and records an attempt after a JSON 503', async function () {
        sinon.stub(console, 'warn');
        const { indexerDb } = await driveQueue(jsonReply(503, { message: 'Service Unavailable' }));
        assert.strictEqual(indexerDb.markHubPushDelivered.callCount, 0);
        assert.strictEqual(indexerDb.recordHubPushAttempt.callCount, 1);
    });

    it('keeps the durable row without charging an attempt after a JSON 429', async function () {
        sinon.stub(console, 'warn');
        const { indexerDb, queue } = await driveQueue(jsonReply(429,
            { message: 'Too Many Requests' }, { 'Retry-After': '30' }));
        assert.strictEqual(indexerDb.markHubPushDelivered.callCount, 0);
        assert.strictEqual(indexerDb.recordHubPushAttempt.callCount, 0);
        assert.ok(queue._throttledUntilMs > Date.now());
    });
});
