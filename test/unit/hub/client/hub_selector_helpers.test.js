// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const http = require('http');
const createHubSelector = require('../../../../src/hub/hub_db_sync/hub_selector.js');
const HubDbSync = require('../../../../src/hub/hub_db_sync.js');

function makeDynamicSync(seed, options) {
    let selector = createHubSelector('testnet', {
        hubSeedUrls: seed || 'http://seed.test:10002',
        hubApiUrl: '',
        randomInt: (max) => max - 1
    });
    let sync = new HubDbSync({ doQuery: async () => [] }, Object.assign({ selector }, options));
    return { selector, sync };
}

async function certify(sync, epoch, mark) {
    sync._wsEpoch = epoch;
    sync.captureConnectionAddress();
    sync.certifyFullDrain([mark || 100], epoch);
    await sync._hubListRefreshPromise;
}

async function openListHub(result) {
    let requests = [];
    let server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            requests.push({ headers: req.headers, body: JSON.parse(body) });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        url: 'http://127.0.0.1:' + server.address().port,
        requests,
        close: () => new Promise((resolve) => server.close(resolve))
    };
}

module.exports = { makeDynamicSync, certify, openListHub };
