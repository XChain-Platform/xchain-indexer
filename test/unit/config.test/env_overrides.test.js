// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The config env overrides under the hub overlay suite: parseIntMin0 for
// BLOCK_CHECK_INTERVAL and BLOCK_PROCESS_TIMEOUT, and the one-sided COINPAY_EXPIRATION
// override.
// Part of the hub config overlay suite; see ../config.test.js.

const assert = require('assert');
const { restoreOverlay } = require('./helpers/overlay_indexer.js');

const KEY = 'XCHAIN_COINPAY_EXPIRATION_S';

function loadOn(network, value) {
    process.env.INDEXER_COIN = 'BTC';
    process.env.INDEXER_NETWORK = network;
    if(value === undefined) delete process.env[KEY]; else process.env[KEY] = value;
    delete require.cache[require.resolve('../../../src/config.js')];
    return require('../../../src/config.js').getConfig();
}

// These cases are the only ones in this file that load config for a network
// OTHER than regtest, so they restore INDEXER_NETWORK as well as the key.
// Leaving 'mainnet' behind would silently re-point every later loader.
let savedNetwork;

describe('XChainIndexer hub config overlay', function () {
    afterEach(restoreOverlay);

    // ─── parseIntMin0: non-negative integer env parsing ──────────────────
    describe('parseIntMin0 (BLOCK_CHECK_INTERVAL / BLOCK_PROCESS_TIMEOUT)', function () {

        function loadWith(env) {
            process.env.INDEXER_COIN = 'BTC';
            process.env.INDEXER_NETWORK = 'regtest';
            for(const [k, v] of Object.entries(env)){
                if(v === undefined) delete process.env[k]; else process.env[k] = v;
            }
            delete require.cache[require.resolve('../../../src/config.js')];
            return require('../../../src/config.js').getConfig();
        }

        afterEach(function () {
            delete process.env.BLOCK_CHECK_INTERVAL;
            delete process.env.BLOCK_PROCESS_TIMEOUT;
        });

        it('uses the configured value when a valid non-negative integer is set', function () {
            assert.strictEqual(loadWith({ BLOCK_CHECK_INTERVAL: '12345' }).BLOCK_CHECK_INTERVAL, 12345);
        });

        it('preserves an explicit 0 (not treated as falsy)', function () {
            assert.strictEqual(loadWith({ BLOCK_CHECK_INTERVAL: '0' }).BLOCK_CHECK_INTERVAL, 0);
        });

        it('falls back to the default for a negative value', function () {
            assert.strictEqual(loadWith({ BLOCK_CHECK_INTERVAL: '-5' }).BLOCK_CHECK_INTERVAL, 5000);
        });

        it('falls back to the default for a non-numeric value', function () {
            assert.strictEqual(loadWith({ BLOCK_PROCESS_TIMEOUT: 'abc' }).BLOCK_PROCESS_TIMEOUT, 300000);
        });

        it('falls back to the default when unset', function () {
            assert.strictEqual(loadWith({ BLOCK_CHECK_INTERVAL: undefined }).BLOCK_CHECK_INTERVAL, 5000);
        });
    });
});

describe('XChainIndexer hub config overlay', function () {
    afterEach(restoreOverlay);

    // COINPAY_EXPIRATION is a consensus input: it is added to a match's BLOCK_TIME
    // and stored as the obligation deadline, so a per-node value expires the same
    // escrow at a different block and forks the ledger. The override is therefore
    // one-sided (regtest honours it, everywhere else ignores it loudly), and it is
    // strict on regtest because a NaN deadline compares false against every block
    // time and would leave every obligation pending forever.
    describe('resolveCoinpayExpiration (COINPAY_EXPIRATION)', function () {
        const FROZEN = 7200;

        // Capture the one-sided warning without letting it clutter the run.
        function loadCapturingWarning(network, value) {
            const real = console.log;
            let warned = false;
            console.log = (...args) => { if(String(args[0]).includes('IGNORED')) warned = true; };
            try { return { config: loadOn(network, value), warned }; }
            finally { console.log = real; }
        }
        beforeEach(function () { savedNetwork = process.env.INDEXER_NETWORK; });
        afterEach(function () {
            delete process.env[KEY];
            if(savedNetwork === undefined) delete process.env.INDEXER_NETWORK;
            else process.env.INDEXER_NETWORK = savedNetwork;
        });

        it('uses the frozen protocol constant when unset', function () {
            assert.strictEqual(loadOn('regtest', undefined).COINPAY_EXPIRATION, FROZEN);
            assert.strictEqual(loadOn('mainnet', undefined).COINPAY_EXPIRATION, FROZEN);
        });

        it('treats an empty value as unset rather than as a parse failure', function () {
            assert.strictEqual(loadOn('regtest', '').COINPAY_EXPIRATION, FROZEN);
        });

        it('honours a positive integer on regtest', function () {
            assert.strictEqual(loadOn('regtest', '300').COINPAY_EXPIRATION, 300);
        });

        it('IGNORES the override on mainnet and on testnet, and says so', function () {
            for(const network of ['mainnet', 'testnet']){
                const { config, warned } = loadCapturingWarning(network, '300');
                assert.strictEqual(config.COINPAY_EXPIRATION, FROZEN, network + ' must keep the frozen window');
                assert.ok(warned, network + ' must warn that a set override was ignored');
            }
        });

        it('stays quiet off regtest when the override merely restates the frozen value', function () {
            const { config, warned } = loadCapturingWarning('mainnet', String(FROZEN));
            assert.strictEqual(config.COINPAY_EXPIRATION, FROZEN);
            assert.strictEqual(warned, false, 'a matching override is not a misconfiguration');
        });
    });
});

describe('XChainIndexer hub config overlay', function () {
    afterEach(restoreOverlay);

    describe('resolveCoinpayExpiration (COINPAY_EXPIRATION)', function () {
        beforeEach(function () { savedNetwork = process.env.INDEXER_NETWORK; });
        afterEach(function () {
            delete process.env[KEY];
            if(savedNetwork === undefined) delete process.env.INDEXER_NETWORK;
            else process.env.INDEXER_NETWORK = savedNetwork;
        });

        it('THROWS on regtest for a value that is not a positive integer', function () {
            for(const bad of ['0', '-5', '3.5', 'abc', ' ']){
                assert.throws(() => loadOn('regtest', bad), /COINPay expiration must be/,
                    'expected "' + bad + '" to be refused at startup');
            }
        });
    });
});
