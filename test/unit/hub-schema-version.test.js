// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// Unit coverage for src/hub-schema-version.js: the hub-mirror schema-version
// constant the indexer stamps into (and version-gates) every WS/REST payload,
// so a hub that adds a consensus-relevant column before this indexer migrates
// cannot silently fork the ledger. Its contract (one positive-integer export,
// nothing else) is pinned; it MUST stay in lockstep with the hub's copy.

const assert = require('assert');
const mod = require('../../src/hub-schema-version.js');

describe('hub-schema-version', function () {
    it('exports exactly HUB_SCHEMA_VERSION and nothing else', function () {
        assert.deepStrictEqual(Object.keys(mod).sort(), ['HUB_SCHEMA_VERSION']);
    });

    it('HUB_SCHEMA_VERSION is a positive safe integer', function () {
        const v = mod.HUB_SCHEMA_VERSION;
        assert.strictEqual(typeof v, 'number');
        assert.ok(Number.isSafeInteger(v), 'must be a safe integer for exact wire equality checks');
        assert.ok(v >= 1, 'schema versions start at 1; 0/negative would disable the gate');
    });

    it('is a stable primitive across re-require (frozen constant, no lazy init)', function () {
        assert.notStrictEqual(typeof mod.HUB_SCHEMA_VERSION, 'object');
        delete require.cache[require.resolve('../../src/hub-schema-version.js')];
        const again = require('../../src/hub-schema-version.js');
        assert.strictEqual(again.HUB_SCHEMA_VERSION, mod.HUB_SCHEMA_VERSION);
    });
});
