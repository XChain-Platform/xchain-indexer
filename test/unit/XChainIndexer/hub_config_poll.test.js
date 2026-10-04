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
const {
    DEFAULT_HUB_CONFIG_POLL_INTERVAL_MS,
    effectiveHubConfigPollIntervalMs,
    hubConfigStalenessLimitMs,
    hubConfigStaleness
} = require('../../../src/XChainIndexer/hub_config_poll.js');

const ENV_KEY = 'HUB_CONFIG_POLL_INTERVAL_MS';
let savedInterval;

describe('hub config poll helpers', function () {
    beforeEach(function () {
        savedInterval = process.env[ENV_KEY];
        delete process.env[ENV_KEY];
    });

    afterEach(function () {
        if(savedInterval === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = savedInterval;
    });

    it('uses a 60000 ms default interval', function () {
        assert.strictEqual(DEFAULT_HUB_CONFIG_POLL_INTERVAL_MS, 60000);
    });

    it('uses the default interval and staleness limit when unset', function () {
        assert.strictEqual(effectiveHubConfigPollIntervalMs(), 60000);
        assert.strictEqual(hubConfigStalenessLimitMs(), 180000);
    });

    it('derives the staleness limit from an interval override', function () {
        process.env[ENV_KEY] = '1000';
        assert.strictEqual(effectiveHubConfigPollIntervalMs(), 1000);
        assert.strictEqual(hubConfigStalenessLimitMs(), 3000);
    });

    it('uses the default for a non-numeric interval', function () {
        process.env[ENV_KEY] = 'abc';
        assert.strictEqual(effectiveHubConfigPollIntervalMs(), 60000);
    });

    it('uses the default for a zero interval', function () {
        process.env[ENV_KEY] = '0';
        assert.strictEqual(effectiveHubConfigPollIntervalMs(), 60000);
    });

    it('reports an unknown fetch time as fresh with no age', function () {
        assert.deepStrictEqual(hubConfigStaleness(null, 1000), {
            ageSeconds: null,
            stale: false
        });
    });

    it('becomes stale only after the exclusive limit', function () {
        process.env[ENV_KEY] = '1000';
        assert.deepStrictEqual(hubConfigStaleness(0, 3000), {
            ageSeconds: 3,
            stale: false
        });
        assert.deepStrictEqual(hubConfigStaleness(0, 3001), {
            ageSeconds: 3,
            stale: true
        });
    });
});
