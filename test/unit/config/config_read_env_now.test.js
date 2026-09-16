// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// Unit coverage for src/config.js's readEnvNow(): the call-time environment
// accessor. CONFIG_ENV is captured and frozen when config.js loads, so a module
// that destructures it can never see a later write; readEnvNow is the read for
// the values that must be re-taken per call (the regtest COINPay override
// getConfig resolves, and the hub config poll interval XChainIndexer re-reads).
// Each case therefore writes the environment AFTER config.js is already loaded.

const assert = require('assert');
const config = require('../../../src/config.js');

const PROBE = 'XCHAIN_READ_ENV_NOW_PROBE';
const COINPAY = 'XCHAIN_COINPAY_EXPIRATION_S';

// Restore one variable to what it was before a case touched it.
function restore(key, saved) {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
}

describe('config.readEnvNow @regression', function () {

    afterEach(function () {
        delete process.env[PROBE];
    });

    it('returns a value set after config.js was loaded', function () {
        process.env[PROBE] = 'first';
        assert.strictEqual(config.readEnvNow(PROBE), 'first');
    });

    it('returns the NEW value on a second call, so nothing is cached at load', function () {
        process.env[PROBE] = 'first';
        assert.strictEqual(config.readEnvNow(PROBE), 'first');
        process.env[PROBE] = 'second';
        assert.strictEqual(config.readEnvNow(PROBE), 'second',
            'a load-time snapshot would still answer "first" here');
    });

    it('returns undefined for a variable that is unset or has been deleted', function () {
        assert.strictEqual(config.readEnvNow(PROBE), undefined);
        process.env[PROBE] = 'set';
        delete process.env[PROBE];
        assert.strictEqual(config.readEnvNow(PROBE), undefined);
    });

});

// Second block, same title: the two cases below drive real configuration keys
// rather than the probe variable, and each restores what it touched.
describe('config.readEnvNow @regression', function () {

    it('reads HUB_CONFIG_POLL_INTERVAL_MS live, without re-requiring config.js', function () {
        // The read XChainIndexer needs: the poll interval is changed in-process
        // (by an operator or a test) and the next read must see it.
        const saved = process.env.HUB_CONFIG_POLL_INTERVAL_MS;
        try {
            process.env.HUB_CONFIG_POLL_INTERVAL_MS = '1000';
            assert.strictEqual(config.readEnvNow('HUB_CONFIG_POLL_INTERVAL_MS'), '1000');
            process.env.HUB_CONFIG_POLL_INTERVAL_MS = '2500';
            assert.strictEqual(config.readEnvNow('HUB_CONFIG_POLL_INTERVAL_MS'), '2500');
        } finally {
            restore('HUB_CONFIG_POLL_INTERVAL_MS', saved);
        }
    });

    it('carries the regtest COINPay override into getConfig per call', function () {
        // getConfig resolves XCHAIN_COINPAY_EXPIRATION_S through readEnvNow, so two
        // calls in one process see two different windows. This is the behaviour the
        // accessor exists to keep: the frozen CONFIG_ENV snapshot cannot do it.
        const savedCoin = process.env.INDEXER_COIN;
        const savedNetwork = process.env.INDEXER_NETWORK;
        const savedWindow = process.env[COINPAY];
        try {
            process.env[COINPAY] = '120';
            assert.strictEqual(config.getConfig('BTC', 'regtest').COINPAY_EXPIRATION, 120);
            process.env[COINPAY] = '300';
            assert.strictEqual(config.getConfig('BTC', 'regtest').COINPAY_EXPIRATION, 300,
                'the second call must re-read the override, not reuse the first');
            delete process.env[COINPAY];
            assert.strictEqual(config.getConfig('BTC', 'regtest').COINPAY_EXPIRATION, 7200,
                'with the override gone the frozen protocol constant wins again');
        } finally {
            restore(COINPAY, savedWindow);
            restore('INDEXER_COIN', savedCoin);
            restore('INDEXER_NETWORK', savedNetwork);
        }
    });
});
