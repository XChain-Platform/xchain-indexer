// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');
const http = require('http');
const createHubSelector = require('./hub_db_sync/hub_selector.js');
const HubDbSync = require('./hub_db_sync.js');

async function openHub(source) {
    let requests = [];
    let server = http.createServer((req, res) => {
        requests.push(req.url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ source }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        url: 'http://127.0.0.1:' + server.address().port,
        requests,
        close: () => new Promise((resolve) => server.close(resolve))
    };
}

describe('hub DB mirror source', function () {
    it('reads only HUB_API_URL when three push seeds are configured', async function () {
        let pinned = await openHub('pinned');
        let seeds = await Promise.all(['seed-a', 'seed-b', 'seed-c'].map(openHub));
        try {
            let selector = createHubSelector('testnet', {
                hubApiUrl: pinned.url,
                hubSeedUrls: seeds.map((seed) => seed.url).join(','),
                randomInt: () => 0
            });
            let sync = new HubDbSync({ doQuery: async () => [] }, { selector });

            assert.deepStrictEqual(new Set(selector.status().candidates),
                new Set(seeds.map((seed) => seed.url)));
            assert.strictEqual(selector.status().pinned, false);
            assert.ok(seeds.some((seed) => seed.url === selector.current()));

            assert.deepStrictEqual(await sync.httpGet('/hub-db/snapshot/oracle_prices'),
                { source: 'pinned' });
            selector.advance('test move');
            assert.deepStrictEqual(await sync.httpGet('/hub-db/snapshot/price_snapshots'),
                { source: 'pinned' });

            assert.deepStrictEqual(pinned.requests, [
                '/hub-db/snapshot/oracle_prices',
                '/hub-db/snapshot/price_snapshots'
            ]);
            for(let seed of seeds) assert.deepStrictEqual(seed.requests, []);
        } finally {
            await pinned.close();
            await Promise.all(seeds.map((seed) => seed.close()));
        }
    });
});
