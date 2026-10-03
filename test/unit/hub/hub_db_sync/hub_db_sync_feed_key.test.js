// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const { execFileSync } = require('child_process');
const http = require('http');
const ws = require('ws');

const HubDbSync = require('../../../../src/hub/hub_db_sync.js');
const { CONFIG_ENV } = require('../../../../src/config.js');

const WebSocketServer = ws.WebSocketServer || ws.Server;

let originalFeedKey;
let originalApiKey;
let hub;
let sync;

function restoreEnv(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

function startHub() {
    return new Promise((resolve) => {
        const seen = { snapshotKey: null, subscribeKey: null };
        const server = http.createServer((req, res) => {
            seen.snapshotKey = req.headers['x-api-key'];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ rows: [] }));
        });
        const socketServer = new WebSocketServer({ server });
        socketServer.on('connection', (socket, req) => {
            seen.subscribeKey = req.headers.authorization;
            socket.send(JSON.stringify({ type: 'ready' }));
        });
        server.listen(0, '127.0.0.1', () => resolve({
            seen,
            server,
            socketServer,
            url: 'http://127.0.0.1:' + server.address().port
        }));
    });
}

async function closeHub() {
    if (sync) {
        sync.stop();
        sync = null;
    }
    if (!hub) return;
    for (const socket of hub.socketServer.clients) socket.terminate();
    await new Promise((resolve) => hub.socketServer.close(resolve));
    hub.server.closeAllConnections && hub.server.closeAllConnections();
    await new Promise((resolve) => hub.server.close(resolve));
    hub = null;
}

async function collectHeaders() {
    hub = await startHub();
    sync = new HubDbSync({ doQuery: async () => [] }, { hubUrl: hub.url });
    sync.running = true;
    await sync.connectWebSocket();
    await sync.httpGet('/hub-db/snapshot/oracle_prices');
    return {
        apiKey: sync.apiKey,
        feedApiKey: sync.feedApiKey,
        snapshotKey: hub.seen.snapshotKey,
        subscribeKey: hub.seen.subscribeKey
    };
}

describe('HubDbSync feed authentication', function () {
    beforeEach(function () {
        originalFeedKey = process.env.HUB_FEED_API_KEY;
        originalApiKey = process.env.HUB_API_KEY;
        delete process.env.HUB_FEED_API_KEY;
        delete process.env.HUB_API_KEY;
    });

    afterEach(async function () {
        await closeHub();
        restoreEnv('HUB_FEED_API_KEY', originalFeedKey);
        restoreEnv('HUB_API_KEY', originalApiKey);
    });

    it('declares HUB_FEED_API_KEY in the indexer configuration environment', function () {
        assert.ok(Object.prototype.hasOwnProperty.call(CONFIG_ENV, 'HUB_FEED_API_KEY'));
    });

    it('presents HUB_FEED_API_KEY to mirror requests while retaining HUB_API_KEY', async function () {
        process.env.HUB_FEED_API_KEY = 'feed-key';
        process.env.HUB_API_KEY = 'bulk-key';

        const seen = await collectHeaders();

        assert.strictEqual(seen.apiKey, 'bulk-key');
        assert.strictEqual(seen.feedApiKey, 'feed-key');
        assert.strictEqual(seen.subscribeKey, 'Bearer feed-key');
        assert.strictEqual(seen.snapshotKey, 'feed-key');
    });

    it('leaves push and reorg credentials on their dedicated environment keys', function () {
        const script = [
            "const HubClient = require('./src/hub/hub_client.js');",
            "const client = new HubClient('http://hub.example.com');",
            'process.stdout.write(JSON.stringify({ apiKey: client.apiKey, reorgApiKey: client.reorgApiKey }));'
        ].join('');
        const output = execFileSync(process.execPath, ['-e', script], {
            cwd: process.cwd(),
            encoding: 'utf8',
            env: Object.assign({}, process.env, {
                HUB_API_KEY: 'bulk-key',
                HUB_FEED_API_KEY: 'feed-key',
                HUB_REORG_API_KEY: 'reorg-key'
            })
        });

        assert.deepStrictEqual(JSON.parse(output), {
            apiKey: 'bulk-key',
            reorgApiKey: 'reorg-key'
        });
    });

    it('falls back to HUB_API_KEY for subscriptions and snapshots', async function () {
        process.env.HUB_API_KEY = 'bulk-key';

        const seen = await collectHeaders();

        assert.strictEqual(seen.apiKey, 'bulk-key');
        assert.strictEqual(seen.feedApiKey, '');
        assert.strictEqual(seen.subscribeKey, 'Bearer bulk-key');
        assert.strictEqual(seen.snapshotKey, 'bulk-key');
    });
});
