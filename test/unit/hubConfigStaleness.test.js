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
    HUB_CONFIG_STALENESS_LIMIT_MS,
    DEFAULT_HUB_CONFIG_POLL_INTERVAL_MS
} = XChainIndexer;

describe('hubConfigStaleness (#2607) @regression', function () {
    it('derives the staleness limit as 3 poll intervals', function () {
        assert.strictEqual(DEFAULT_HUB_CONFIG_POLL_INTERVAL_MS, 60000);
        assert.strictEqual(HUB_CONFIG_STALENESS_LIMIT_MS, 180000);
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
