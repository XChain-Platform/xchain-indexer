// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const { once } = require('events');
const sinon = require('sinon');
const ws = require('ws');

const HubDbSync = require('../../../../../../src/hub/hub_db_sync.js');

const WebSocketServer = ws.WebSocketServer || ws.Server;

async function makeCloseCodeHarness() {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');

    let instanceId = null;
    let serverSocket = null;
    let lastCloseCode = null;
    let restored = false;

    server.on('connection', (socket) => {
        serverSocket = socket;
        socket.once('close', () => {
            if (serverSocket === socket) serverSocket = null;
        });
        socket.send(JSON.stringify({ type: 'ready', hub_instance_id: instanceId }));
    });

    const address = server.address();
    const hubDb = { doQuery: sinon.stub().resolves([]) };
    const sync = new HubDbSync(hubDb, {
        hubUrl: 'http://127.0.0.1:' + address.port,
        watermarkIntervalMs: 300000
    });
    const scheduleReconnect = sinon.stub(sync, 'scheduleReconnect');
    sync.running = true;

    const harness = {
        sync,
        async connect({ instanceId: nextInstanceId }) {
            instanceId = nextInstanceId;
            await sync.connectWebSocket();
        },
        seedPositions(map) {
            sync._drainPositions = Object.assign(Object.create(null), map);
        },
        async closeFromHub(code) {
            const clientSocket = sync.ws;
            if (!clientSocket || !serverSocket) throw new Error('No connected socket to close');

            await new Promise((resolve) => {
                clientSocket.once('close', (seenCode) => {
                    lastCloseCode = seenCode;
                    resolve();
                });
                if (code === null) serverSocket.terminate();
                else serverSocket.close(code);
            });
        },
        positions() {
            return Object.assign({}, sync._drainPositions);
        },
        async restore() {
            if (restored) return;
            restored = true;
            sync.stop();
            scheduleReconnect.restore();
            for (const socket of server.clients) socket.terminate();
            await new Promise((resolve, reject) => {
                server.close((err) => err ? reject(err) : resolve());
            });
        }
    };

    Object.defineProperties(harness, {
        lastCloseCode: {
            enumerable: true,
            get: () => lastCloseCode
        },
        reconnectCalls: {
            enumerable: true,
            get: () => scheduleReconnect.callCount
        }
    });

    return harness;
}

module.exports = { makeCloseCodeHarness };
