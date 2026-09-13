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

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const XChainIndexer = require('../../src/XChainIndexer.js');
const {
    hubConfigStaleness,
    hubConfigStalenessLimitMs,
    effectiveHubConfigPollIntervalMs,
    DEFAULT_HUB_CONFIG_POLL_INTERVAL_MS
} = XChainIndexer;

// The boundary is env-derived, so pin the ambient value for the default-cadence cases rather
// than inheriting whatever the shell exported.
const AMBIENT_POLL_INTERVAL = process.env.HUB_CONFIG_POLL_INTERVAL_MS;
const HUB_CONFIG_STALENESS_LIMIT_MS = 180000;   // 3 x the 60s default, asserted below

describe('hubConfigStaleness (#2607) @regression', function () {
    beforeEach(function () { delete process.env.HUB_CONFIG_POLL_INTERVAL_MS; });
    after(function () {
        if(AMBIENT_POLL_INTERVAL === undefined) delete process.env.HUB_CONFIG_POLL_INTERVAL_MS;
        else process.env.HUB_CONFIG_POLL_INTERVAL_MS = AMBIENT_POLL_INTERVAL;
    });

    it('derives the staleness limit as 3 poll intervals', function () {
        assert.strictEqual(DEFAULT_HUB_CONFIG_POLL_INTERVAL_MS, 60000);
        assert.strictEqual(hubConfigStalenessLimitMs(), HUB_CONFIG_STALENESS_LIMIT_MS);
    });

    // item 4461: the boundary used to be compiled from the DEFAULT while the poll timer
    // honoured HUB_CONFIG_POLL_INTERVAL_MS, so a 10s poll still reported fresh until 180s.
    it('tracks a HUB_CONFIG_POLL_INTERVAL_MS override (boundary = 3 x effective interval)', function () {
        process.env.HUB_CONFIG_POLL_INTERVAL_MS = '10000';
        assert.strictEqual(effectiveHubConfigPollIntervalMs(), 10000);
        assert.strictEqual(hubConfigStalenessLimitMs(), 30000);
        assert.strictEqual(hubConfigStaleness(1000000 - 30001, 1000000).stale, true);
    });

    // item 4461 (rework): api.js requires XChainIndexer BEFORE calling dotenv.config(), so a
    // value that arrives from `.env` lands after this module is loaded. Reading env at module
    // load would silently revert the documented knob to the 60s default on exactly the
    // deployment shape the README documents, which is why the read stays lazy.
    it('honours an override that arrives after module load (dotenv ordering)', function () {
        assert.strictEqual(effectiveHubConfigPollIntervalMs(), 60000);
        process.env.HUB_CONFIG_POLL_INTERVAL_MS = '600000';   // as if dotenv.config() just ran
        assert.strictEqual(effectiveHubConfigPollIntervalMs(), 600000);
        assert.strictEqual(hubConfigStalenessLimitMs(), 1800000);
    });

    it('null last-fetch: age null, not stale', function () {
        assert.deepStrictEqual(hubConfigStaleness(null, 1000000), { ageSeconds: null, stale: false });
    });

    it('under the limit: not stale, age in whole seconds', function () {
        let now = 1000000;
        let last = now - (HUB_CONFIG_STALENESS_LIMIT_MS - 1000); // 1s under the boundary
        let r = hubConfigStaleness(last, now);
        assert.strictEqual(r.stale, false);
        assert.strictEqual(r.ageSeconds, Math.floor((HUB_CONFIG_STALENESS_LIMIT_MS - 1000) / 1000));
    });

    it('exactly at the limit is not yet stale (boundary is exclusive)', function () {
        let now = 1000000;
        let last = now - HUB_CONFIG_STALENESS_LIMIT_MS;
        assert.strictEqual(hubConfigStaleness(last, now).stale, false);
    });

    it('past the limit: stale flips true', function () {
        let now = 1000000;
        let last = now - (HUB_CONFIG_STALENESS_LIMIT_MS + 1);
        assert.strictEqual(hubConfigStaleness(last, now).stale, true);
    });
});
