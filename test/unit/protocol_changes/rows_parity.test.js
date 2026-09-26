'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The registry's time-table rows against the rows the transitional manifest
// produces today. The manifest constructs the class with the { config: {},
// util: {} } stub and reads .changes; rows() must carry the same 98 keys with
// the same canonical value for each, or the fingerprint would move when the
// manifest's resolvers are replaced by rows() at W3.

const assert = require('assert');
const { canonicalValue } = require('../../../src/consensus/armed_map/canonical.js');
const manifest = require('../../../src/consensus/armed_map/manifest.js');
const ProtocolChanges = require('../../../src/protocol_changes.js');

const PREFIX = 'protocol_changes.changes.';

function registryChangeRows() {
    return new Map(ProtocolChanges.rows().filter(([k]) => k.startsWith(PREFIX)).map(([k, v]) => [k, canonicalValue(v)]));
}

describe('protocol_changes/rows_parity: rows() equals the transitional manifest @regression @tier1', function () {
    it('carries exactly the 98 time-table keys the manifest lists', function () {
        const keys = [...registryChangeRows().keys()].sort();
        assert.strictEqual(keys.length, 98);
        const table = Object.keys(new ProtocolChanges({ config: {}, util: {} }).changes);
        assert.deepStrictEqual(keys, table.map((n) => PREFIX + n).sort());
    });

    it('every row canonicalises to the value the manifest resolves for that key', function () {
        const collected = manifest.collectRows();
        assert.strictEqual(collected.ok, true, collected.reason);
        const fromManifest = new Map(collected.rows.filter(([k]) => k.startsWith(PREFIX)).map(([k, v]) => [k, canonicalValue(v)]));
        const fromRegistry = registryChangeRows();
        assert.strictEqual(fromManifest.size, 98);
        const differing = [...fromManifest].filter(([k, vcs]) => fromRegistry.get(k) !== vcs).map(([k]) => k);
        assert.deepStrictEqual(differing, [], 'rows whose registry value differs from the manifest value');
    });

    it('every row canonicalises to the value a fresh class build under the stub carries', function () {
        const table = new ProtocolChanges({ config: {}, util: {} }).changes;
        const fromRegistry = registryChangeRows();
        for (const name of Object.keys(table)) {
            assert.strictEqual(fromRegistry.get(PREFIX + name), canonicalValue(table[name]), name);
        }
        assert.strictEqual(Object.keys(table).length, fromRegistry.size);
    });

    it('a registry row is a frozen plain object with the nine parsed fields', function () {
        const row = ProtocolChanges.get(PREFIX + 'CONTRACT_META_REQUIRED');
        assert.ok(Object.isFrozen(row));
        assert.deepStrictEqual(Object.keys(row).sort(), [
            'mainnet_block', 'mainnet_time', 'regtest_block', 'regtest_time', 'testnet_block', 'testnet_time',
            'version_major', 'version_minor', 'version_revision',
        ]);
        assert.strictEqual(row.testnet_time, ProtocolChanges.CONTRACT_META_REQUIRED_TESTNET_TIME);
    });
});
