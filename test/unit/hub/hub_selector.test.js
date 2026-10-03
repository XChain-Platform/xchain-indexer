// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const createHubSelector = require('../../../src/hub/hub_db_sync/hub_selector.js');

const MAINNET_DEFAULTS = Array.from({ length: 5 }, (_, i) =>
    'http://validator' + String(i + 1).padStart(2, '0') + '.xchain.io:10001');
const TESTNET_DEFAULTS = Array.from({ length: 5 }, (_, i) =>
    'http://validator' + String(i + 1).padStart(2, '0') + '.xchain.io:10002');

describe('hub selector', function () {
    const originalRandomInt = crypto.randomInt;

    afterEach(function () {
        crypto.randomInt = originalRandomInt;
    });

    it('expands the built-in validators for each public network', function () {
        let mainnet = createHubSelector('mainnet', {
            hubSeedUrls: 'default',
            randomInt: (max) => max - 1
        });
        let testnet = createHubSelector('testnet', {
            hubSeedUrls: 'default',
            randomInt: (max) => max - 1
        });

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
        crypto.randomInt = () => {
            calls++;
            return 0;
        };
        let selector = createHubSelector('testnet', {
            hubSeedUrls: 'http://one.test:10002,http://two.test:10002,http://three.test:10002'
        });

        assert.notStrictEqual(selector.current(), 'http://one.test:10002');
        assert.strictEqual(calls, 2);
    });

    it('keeps a lone HUB_API_URL pinned even after merge and advance', function () {
        let changes = [];
        let selector = createHubSelector('testnet', {
            hubSeedUrls: '',
            hubApiUrl: 'https://pinned.test:8443/',
            randomInt: (max) => max - 1
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
            hubSeedUrls: 'http://seed-a.test:10002/, default, http://seed-a.test:10002',
            randomInt: (max) => max - 1
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

    it('advances in shuffled order, wraps, and notifies only on a move', function () {
        let selector = createHubSelector('testnet', {
            hubSeedUrls: 'http://a.test,http://b.test,http://c.test',
            randomInt: (max) => max - 1
        });
        let events = [];
        let unsubscribe = selector.onChange((next, previous, reason) => {
            events.push({ next, previous, reason });
        });
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
        let selector = createHubSelector('testnet', {
            hubSeedUrls: 'http://only.test:10002',
            hubApiUrl: '',
            randomInt: (max) => max - 1
        });
        let changes = 0;
        selector.onChange(() => changes++);

        assert.strictEqual(selector.advance('alone'), 'http://only.test:10002');
        assert.strictEqual(changes, 0);
        selector.merge(['http://second.test:10002']);
        assert.strictEqual(selector.advance('now movable'), 'http://second.test:10002');
        assert.strictEqual(changes, 1);
    });

    it('reads HUB_SEED_URLS and HUB_API_URL through the supplied accessor', function () {
        let reads = [];
        let values = {
            HUB_SEED_URLS: 'http://from-env.test:10002',
            HUB_API_URL: 'http://ignored-pin.test:10002'
        };
        let selector = createHubSelector({
            network: 'testnet',
            readEnvNow(key) {
                reads.push(key);
                return values[key];
            },
            randomInt: (max) => max - 1
        });

        assert.deepStrictEqual(reads, ['HUB_SEED_URLS', 'HUB_API_URL']);
        assert.strictEqual(selector.current(), 'http://from-env.test:10002');
        assert.strictEqual(selector.status().pinned, false);
    });

    it('does not read environment keys supplied as arguments', function () {
        let selector = createHubSelector('testnet', {
            hubSeedUrls: 'http://argument.test:10002',
            hubApiUrl: '',
            readEnvNow() {
                throw new Error('unexpected environment read');
            },
            randomInt: (max) => max - 1
        });

        assert.strictEqual(selector.current(), 'http://argument.test:10002');
    });
});
