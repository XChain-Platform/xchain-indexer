// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const ws = require('ws');
const sinon = require('sinon');
const observability = require('../../../../src/observability/index.js');
const createHubSelector = require('../../../../src/hub/hub_db_sync/hub_selector.js');
const HubClient = require('../../../../src/hub/hub_client.js');
const HubDbSync = require('../../../../src/hub/hub_db_sync.js');
const { makeDynamicSync, certify, openListHub } = require('./hub_selector_helpers.test.js');

const WebSocketServer = ws.WebSocketServer || ws.Server;

const MAINNET_DEFAULTS = Array.from({ length: 5 }, (_, i) =>
    'http://validator' + String(i + 1).padStart(2, '0') + '.xchain.io:10001');
const TESTNET_DEFAULTS = Array.from({ length: 5 }, (_, i) =>
    'http://validator' + String(i + 1).padStart(2, '0') + '.xchain.io:10002');

function seededSelector(seeds) {
    return createHubSelector('testnet', {
        hubSeedUrls: seeds,
        hubApiUrl: '',
        randomInt: (max) => max - 1
    });
}

function defineDefaultTests() {
    it('expands the built-in validators for each public network', function () {
        let mainnet = createHubSelector('mainnet', { hubSeedUrls: 'default', randomInt: (max) => max - 1 });
        let testnet = createHubSelector('testnet', { hubSeedUrls: 'default', randomInt: (max) => max - 1 });

        assert.deepStrictEqual(mainnet.status().candidates, MAINNET_DEFAULTS);
        assert.deepStrictEqual(testnet.status().candidates, TESTNET_DEFAULTS);
    });

    it('refuses default without a supported public network', function () {
        assert.throws(() => createHubSelector('regtest', { hubSeedUrls: 'default' }),
            /default.*regtest/i);
        assert.throws(() => createHubSelector({ hubSeedUrls: 'default' }),
            /default.*unset/i);
    });

    it('uses crypto.randomInt to avoid always following the first configured seed', function () {
        let calls = 0;
        crypto.randomInt = () => { calls++; return 0; };
        let selector = createHubSelector('testnet', {
            hubSeedUrls: 'http://one.test:10002,http://two.test:10002,http://three.test:10002'
        });

        assert.notStrictEqual(selector.current(), 'http://one.test:10002');
        assert.strictEqual(calls, 2);
    });
}

function defineMergeTests() {
    it('keeps a lone HUB_API_URL pinned even after merge and advance', function () {
        let changes = [];
        let selector = createHubSelector('testnet', {
            hubSeedUrls: '', hubApiUrl: 'https://pinned.test:8443/', randomInt: (max) => max - 1
        });
        selector.onChange((...args) => changes.push(args));

        selector.merge(['http://learned.test:10002']);
        assert.strictEqual(selector.advance('connection failed'), 'https://pinned.test:8443');
        assert.deepStrictEqual(selector.status(), {
            current: 'https://pinned.test:8443',
            candidates: ['https://pinned.test:8443'],
            pinned: true
        });
        assert.deepStrictEqual(changes, []);
    });

    it('refuses malformed and unsafe hub URLs', function () {
        for(let address of ['not a url', 'ftp://hub.test:10002', 'http://user:pass@hub.test',
                            'http://hub.test/path', 'http://hub.test?query=1']){
            assert.throws(() => createHubSelector('testnet', { hubSeedUrls: address }),
                /invalid hub url/i, address);
        }
        assert.throws(() => createHubSelector('testnet', {
            hubSeedUrls: 'http://valid.test:10002',
            hubApiUrl: ''
        }).merge(['http://also-valid.test:10002', 'javascript:alert(1)']), /invalid hub url/i);
    });

    it('deduplicates seeds and merge remains additive without moving the current hub', function () {
        let selector = createHubSelector('testnet', {
            hubSeedUrls: 'http://seed-a.test:10002/, default, http://seed-a.test:10002', randomInt: (max) => max - 1
        });
        let original = selector.status();

        selector.merge([
            'http://validator01.xchain.io:10002/',
            'http://learned.test:10002',
            'http://learned.test:10002/'
        ]);
        let merged = selector.status();

        assert.strictEqual(merged.current, original.current);
        assert.strictEqual(new Set(merged.candidates).size, merged.candidates.length);
        for(let seed of original.candidates) assert.ok(merged.candidates.includes(seed), seed);
        assert.ok(merged.candidates.includes('http://learned.test:10002'));
    });
}

function defineAdvanceTests() {
    it('advances in shuffled order, wraps, and notifies only on a move', function () {
        let selector = createHubSelector('testnet', {
            hubSeedUrls: 'http://a.test,http://b.test,http://c.test',
            randomInt: (max) => max - 1
        });
        let events = [];
        let unsubscribe = selector.onChange((next, previous, reason) => events.push({ next, previous, reason }));
        let order = selector.status().candidates;

        assert.strictEqual(selector.advance('first'), order[1]);
        assert.strictEqual(selector.advance('second'), order[2]);
        assert.strictEqual(selector.advance('wrap'), order[0]);
        unsubscribe();
        selector.advance('unobserved');

        assert.deepStrictEqual(events.map((event) => event.reason), ['first', 'second', 'wrap']);
        assert.deepStrictEqual(events[0], { next: order[1], previous: order[0], reason: 'first' });
    });

    it('does not advance a dynamic selector until it has multiple candidates', function () {
        let selector = seededSelector('http://only.test:10002');
        let changes = 0;
        selector.onChange(() => changes++);

        assert.strictEqual(selector.advance('alone'), 'http://only.test:10002');
        assert.strictEqual(changes, 0);
        selector.merge(['http://second.test:10002']);
        assert.strictEqual(selector.advance('now movable'), 'http://second.test:10002');
        assert.strictEqual(changes, 1);
    });
}

function defineEnvTests() {
    it('reads HUB_SEED_URLS and HUB_API_URL through the supplied accessor', function () {
        let reads = [];
        let values = { HUB_SEED_URLS: 'http://from-env.test:10002', HUB_API_URL: 'http://ignored-pin.test:10002' };
        let selector = createHubSelector({
            network: 'testnet',
            readEnvNow(key) { reads.push(key); return values[key]; },
            randomInt: (max) => max - 1
        });

        assert.deepStrictEqual(reads, ['HUB_SEED_URLS', 'HUB_API_URL']);
        assert.strictEqual(selector.current(), 'http://from-env.test:10002');
        assert.strictEqual(selector.status().pinned, false);
    });

    it('does not read environment keys supplied as arguments', function () {
        let selector = createHubSelector('testnet', {
            hubSeedUrls: 'http://argument.test:10002', hubApiUrl: '',
            readEnvNow() { throw new Error('unexpected environment read'); },
            randomInt: (max) => max - 1
        });

        assert.strictEqual(selector.current(), 'http://argument.test:10002');
    });
}

function defineClientTests() {
    it('enables a hub client from a selector candidate when only seeds are configured', function () {
        let selector = seededSelector('http://seed.test:10002');
        let client = new HubClient('', 'key', '', '');

        client.setAddressSource(() => selector.current());

        assert.strictEqual(client.hubUrl, '');
        assert.strictEqual(client.enabled, true);
        assert.strictEqual(client.configEnabled, false);
    });

    it('keeps the config address fixed while the selected feed address moves', function () {
        let selector = seededSelector('http://feed-a.test:10002,http://feed-b.test:10002');
        let client = new HubClient('', 'feed-key', 'http://config.test:10000', 'config-key');
        client.setAddressSource(() => selector.current());

        selector.advance('test move');

        assert.strictEqual(client.configUrl, 'http://config.test:10000');
        assert.notStrictEqual(selector.current(), client.configUrl);
    });
}

function defineDrainTests() {
    it('aborts an in-flight mirror drain when the selector changes', async function () {
        let selector = seededSelector('http://hub-a.test:10002,http://hub-b.test:10002');
        let sync = new HubDbSync({ doQuery: async () => [] }, { selector });
        assert.strictEqual(sync.enabled, true);
        sync.captureConnectionAddress();
        let originalAddress = sync.hubUrl;
        let retryScheduled = false;
        sync.running = true;
        sync.scheduleBootstrapRetry = () => { retryScheduled = true; };
        sync.drainEveryTable = async () => {
            selector.advance('test move');
            return { allDrained: true, marks: [100] };
        };

        await sync.bootstrapAll();

        assert.notStrictEqual(selector.current(), originalAddress);
        assert.strictEqual(sync.hubUrl, originalAddress);
        assert.strictEqual(sync._bootstrapDrained, false);
        assert.strictEqual(retryScheduled, true);
        assert.deepStrictEqual(sync.mirrorStatus().candidates, selector.status().candidates);
        assert.strictEqual(sync.mirrorStatus().followedAddress, originalAddress);
    });

    it('stops paging a table when the selector changes during a request', async function () {
        let selector = seededSelector('http://hub-a.test:10002,http://hub-b.test:10002');
        let sync = new HubDbSync({ doQuery: async () => [] }, { selector });
        let applied = 0;
        sync.httpGet = async () => {
            selector.advance('request moved');
            return { rows: [{ id: 1 }], watermark: 100 };
        };
        sync.applyRow = async () => { applied++; };
        let drain = {
            table: 'oracle_prices', lastId: 0, connectionEpoch: sync._wsEpoch,
            selectorRevision: sync._selectorRevision,
            applied: 0, applyErrors: 0, pending: [], pagesFetched: 0,
            fetched: 0, lastPageCount: 0, watermark: null
        };

        assert.strictEqual(await sync.pageTableDrain(drain), false);
        assert.strictEqual(applied, 0);
        assert.strictEqual(drain.pagesFetched, 0);
    });
}

function defineLearnTests() {
    it('learns hubs after a certified drain without replacing seeds', async function () {
        let hub = await openListHub({ hubs: [{ api_url: 'http://learned.test:10002' }] });
        try {
            let { selector, sync } = makeDynamicSync(hub.url, { feedApiKey: 'feed-key' });
            await certify(sync, 0);
            assert.strictEqual(hub.requests[0].body.method, 'gethubs');
            assert.deepStrictEqual(hub.requests[0].body.params, {});
            assert.strictEqual(hub.requests[0].headers['x-api-key'], 'feed-key');
            assert.strictEqual(selector.current(), hub.url);
            assert.deepStrictEqual(new Set(selector.status().candidates),
                new Set([hub.url, 'http://learned.test:10002']));
        } finally {
            await hub.close();
        }
    });

    it('refreshes once per connection and never from repeated certification', async function () {
        let { sync } = makeDynamicSync();
        let fetchHubList = sinon.stub(sync, 'fetchHubList').resolves({ hubs: [
            { api_url: 'http://learned.test:10002' }
        ] });
        await certify(sync, 0);
        sync.certifyFullDrain([101], sync._wsEpoch);
        await sync._hubListRefreshPromise;
        assert.strictEqual(fetchHubList.callCount, 1);
        await certify(sync, 1, 102);
        assert.strictEqual(fetchHubList.callCount, 2);
    });
}

function defineLearnEdgeTests() {
    it('keeps candidates unchanged and logs once for empty and unsupported lists', async function () {
        let { selector, sync } = makeDynamicSync();
        let initial = selector.status().candidates;
        let fetchHubList = sinon.stub(sync, 'fetchHubList');
        fetchHubList.onCall(0).resolves({ hubs: [] });
        fetchHubList.onCall(1).resolves({ hubs: [] });
        fetchHubList.onCall(2).rejects(Object.assign(new Error('unsupported'), { rpcCode: -32601 }));
        fetchHubList.onCall(3).rejects(Object.assign(new Error('unsupported'), { rpcCode: -32601 }));
        let warn = sinon.stub(observability.getLogger(), 'warn');

        try {
            for(let epoch = 0; epoch < 4; epoch++) await certify(sync, epoch, 100 + epoch);
            assert.deepStrictEqual(selector.status().candidates, initial);
            assert.strictEqual(warn.callCount, 2);
            assert.match(warn.firstCall.args[0], /no usable addresses/);
            assert.match(warn.secondCall.args[0], /does not support/);
        } finally {
            warn.restore();
        }
    });

    it('does not learn hub lists in pinned mode', function () {
        let selector = createHubSelector('testnet', { hubSeedUrls: '', hubApiUrl: 'http://pinned.test:10002' });
        let sync = new HubDbSync({ doQuery: async () => [] }, { selector });
        let fetchHubList = sinon.stub(sync, 'fetchHubList');
        assert.strictEqual(sync.certifyFullDrain([100], sync._wsEpoch), true);
        assert.strictEqual(fetchHubList.called, false);
        assert.strictEqual(sync._hubListRefreshPromise, null);
    });
}

async function openHub(label, holdResponse) {
    let release;
    let arrived;
    let responseGate = holdResponse ? new Promise((resolve) => { release = resolve; }) : Promise.resolve();
    let requestArrived = new Promise((resolve) => { arrived = resolve; });
    let server = http.createServer(async (req, res) => {
        arrived();
        await responseGate;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ source: label }));
    });
    let socketServer = new WebSocketServer({ server });
    socketServer.on('connection', (socket) => socket.send(JSON.stringify({ type: 'ready' })));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        url: 'http://127.0.0.1:' + server.address().port,
        server, socketServer, requestArrived,
        release: release || (() => {})
    };
}

async function closeHub(hub) {
    for(let socket of hub.socketServer.clients) socket.terminate();
    await new Promise((resolve) => hub.socketServer.close(resolve));
    await new Promise((resolve) => hub.server.close(resolve));
}

async function reconnectWebSocket(sync) {
    let closed = new Promise((resolve) => sync.ws.once('close', resolve));
    sync.running = false;
    sync.ws.close();
    await closed;
    sync.running = true;
    await sync.connectWebSocket();
}

async function runEpochScenario(first, second, state) {
    let selector = seededSelector(first.url + ',' + second.url);
    let sync = state.sync = new HubDbSync({ doQuery: async () => [] }, { selector });
    sync.running = true;

    await sync.connectWebSocket();
    assert.strictEqual(sync.hubUrl, first.url);
    let oldEpochRequest = sync.httpGet('/hub-db/snapshot/oracle_prices');
    await first.requestArrived;

    selector.advance('move during request');
    assert.strictEqual(sync.hubUrl, first.url);
    first.release();
    assert.deepStrictEqual(await oldEpochRequest, { source: 'first' });

    await reconnectWebSocket(sync);
    assert.strictEqual(sync.hubUrl, second.url);
    assert.deepStrictEqual(await sync.httpGet('/hub-db/snapshot/oracle_prices'), { source: 'second' });
}

function defineEpochTests() {
    it('keeps requests on the captured address until the next connection epoch', async function () {
        this.timeout(10000);
        let first = await openHub('first', true);
        let second = await openHub('second', false);
        let state = {};
        try {
            await runEpochScenario(first, second, state);
        } finally {
            if(state.sync) state.sync.stop();
            first.release();
            await closeHub(first);
            await closeHub(second);
        }
    });
}

describe('hub selector', function () {
    const originalRandomInt = crypto.randomInt;

    afterEach(function () {
        crypto.randomInt = originalRandomInt;
    });
    defineDefaultTests();
    defineMergeTests();
    defineAdvanceTests();
    defineEnvTests();
    defineClientTests();
    defineDrainTests();
    defineEpochTests();
    defineLearnTests();
    defineLearnEdgeTests();
});
