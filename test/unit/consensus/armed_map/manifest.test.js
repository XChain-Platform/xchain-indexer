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

// The completeness guard for the v2 row manifest. The manifest is an explicit
// list on purpose (membership must not follow the file layout), and a list
// cannot notice what it forgot, so every way a consensus value could sit
// outside it is checked here from the other side: activation-map declarations
// found by scanning src/, every export of every listed module, the v1 carrier
// set, and the ProtocolChanges table. A process on a stale copy of anything
// outside the rows would publish a v2 identical to a correctly-armed peer's.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SRC  = path.join(REPO, 'src');

const manifest = require('../../../../src/consensus/armed_map/manifest.js');
const { canonicalValue } = require('../../../../src/consensus/armed_map/canonical.js');
const { computeArmedMapFingerprint } = require('../../../../src/consensus/armed_map/armed_map_fingerprint.js');
const ProtocolChanges = require('../../../../src/protocol_changes.js');

// The two declaration shapes that make a file a carrier. ACTIVATION_MAP is the
// activation-map rule the platform's code-structure gate grades with, and
// CARRIER_DECL is v1's carrier scan (test/unit/consensus/armed_map/armed_map_fingerprint.test.js:47),
// each given a capture group here so a hit names the declared export.
const ACTIVATION_MAP = /\b([A-Z][A-Z0-9_]*_ACTIVATION)\s*=\s*\{/g;
const CARRIER_DECL = /^\s*(?:const|let|var)\s+([A-Z0-9_]*ACTIVATIONS?[A-Z0-9_]*)\s*=\s*(?:Object\.freeze\()?\{/gm;

function rowKeys() {
    return new Set(manifest.ENTRIES.map((e) => e[0]));
}

// [file relative to src/, declared name] for every declaration in src/.
function scanDeclarations() {
    const found = [];
    (function walk(dir, rel) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === '.git') continue;
            const abs = path.join(dir, e.name);
            const r = rel ? rel + '/' + e.name : e.name;
            if (e.isDirectory()) { walk(abs, r); continue; }
            if (!e.name.endsWith('.js')) continue;
            const text = fs.readFileSync(abs, 'utf8');
            const names = new Set();
            for (const re of [ACTIVATION_MAP, CARRIER_DECL]) {
                for (const m of text.matchAll(re)) names.add(m[1]);
            }
            for (const name of names) found.push([r, name]);
        }
    })(SRC, '');
    return found;
}

describe('armed_map/manifest: completeness guard', function () {

    it('keeps the carrier declaration scan identical to the one v1 enforces', function () {
        const v1 = fs.readFileSync(path.join(REPO, 'test', 'unit', 'consensus', 'armed_map', 'armed_map_fingerprint.test.js'), 'utf8');
        const m = v1.match(/const CARRIER_DECL = \/(.+)\/m;/);
        assert.ok(m, 'v1 carrier scan not found; re-cite CARRIER_DECL here');
        assert.strictEqual(CARRIER_DECL.source.replace('([A-Z0-9_]*ACTIVATIONS?[A-Z0-9_]*)',
            '[A-Z0-9_]*ACTIVATIONS?[A-Z0-9_]*'), m[1]);
    });

    it('every activation-map declaration under src/ is a manifest row', function () {
        const found = scanDeclarations();
        const files = new Set(found.map((f) => f[0]));
        // An empty or near-empty scan would pass while proving nothing.
        assert.ok(files.size > 5, 'the declaration scan found ' + files.size +
            ' files, too few to be a real scan; fix the scan, not this bound');
        const keys = rowKeys();
        const uncovered = found.map(([f, name]) => f.replace(/\.js$/, '') + '.' + name).filter((k) => !keys.has(k));
        assert.deepStrictEqual(uncovered, [], 'declared in src/ but not a v2 row, so a stale copy is ' +
            'invisible to the fleet sweep: ' + uncovered.join(', ') + ' (export it and list it in ' +
            'src/consensus/armed_map/manifest.js)');
    });

    it('every non-function export of every listed module is a row', function () {
        const keys = rowKeys();
        const missing = [];
        for (const [stem, load] of manifest.MODULES) {
            const exported = load();
            for (const name of Object.keys(exported)) {
                if (typeof exported[name] === 'function') continue;
                if (!keys.has(stem + '.' + name)) missing.push(stem + '.' + name);
            }
        }
        assert.deepStrictEqual(missing, [], 'exported data outside the v2 rows: ' + missing.join(', '));
    });

    it('every v1 carrier file is a listed module, so v2 covers at least what v1 did', function () {
        const stems = new Set(manifest.MODULES.map((m) => m[0]));
        const v1Files = Object.keys(computeArmedMapFingerprint().files);
        assert.ok(v1Files.length > 5, 'v1 carrier set is implausibly small: ' + v1Files.length);
        const missing = v1Files.map((f) => f.replace(/\.js$/, '')).filter((s) => !stems.has(s));
        assert.deepStrictEqual(missing, [], 'v1 carriers outside the v2 manifest: ' + missing.join(', '));
    });

    it('lists exactly the ProtocolChanges table, no more and no fewer', function () {
        const table = Object.keys(new ProtocolChanges({ config: {}, util: {} }).changes).sort();
        assert.deepStrictEqual(manifest.PROTOCOL_CHANGE_NAMES.slice().sort(), table);
    });

    it('never lists a key twice and never enumerates the file system', function () {
        assert.strictEqual(rowKeys().size, manifest.ENTRIES.length);
        for (const file of ['manifest.js', 'fingerprint_v2.js', 'canonical.js']) {
            const text = fs.readFileSync(path.join(SRC, 'consensus', 'armed_map', file), 'utf8');
            // A call or an fs require, not the word: the manifest header names readdirSync
            // in prose to say it is never called.
            assert.ok(!/\breaddirSync\s*\(|require\(\s*['"](?:node:)?fs['"]\s*\)/.test(text),
                file + ' must not read the file system');
        }
    });
});

describe('armed_map/manifest: collectRows', function () {

    it('resolves every entry to a serialisable value, in manifest order', function () {
        const out = manifest.collectRows();
        assert.strictEqual(out.ok, true, out.reason);
        assert.strictEqual(out.rows.length, manifest.ENTRIES.length);
        assert.deepStrictEqual(out.rows.map((r) => r[0]), manifest.ENTRIES.map((e) => e[0]));
        for (const [, value] of out.rows) canonicalValue(value);
    });

    it('carries the three row families the design names', function () {
        const keys = [...rowKeys()];
        assert.strictEqual(keys.filter((k) => k.startsWith('protocol_changes.changes.')).length,
            manifest.PROTOCOL_CHANGE_NAMES.length);
        assert.ok(keys.includes('state_commitment_activation.STATE_COMMITMENT_ACTIVATION'));
        assert.ok(keys.includes('stateHash.DEACTIVATION_TABLES'));
        assert.ok(keys.includes('protocol/constants.XBRIDGE_MAX_PER_BLOCK'));
    });

    function withExtraEntry(entry, fn) {
        manifest.ENTRIES.push(entry);
        try { return fn(); } finally { manifest.ENTRIES.pop(); }
    }

    it('turns a resolver that throws into ok:false naming the key', function () {
        const out = withExtraEntry(['zz_test.THROWS', () => { throw new Error('carrier failed to load'); }],
            () => manifest.collectRows());
        assert.strictEqual(out.ok, false);
        assert.ok(out.reason.startsWith('zz_test.THROWS: '), out.reason);
        assert.strictEqual(out.rows, undefined, 'a failed collection must carry no rows to hash');
    });

    it('turns a refused value into ok:false naming the key', function () {
        const out = withExtraEntry(['zz_test.MAP', () => new Map()], () => manifest.collectRows());
        assert.strictEqual(out.ok, false);
        assert.ok(out.reason.startsWith('zz_test.MAP: '), out.reason);
        assert.strictEqual(manifest.collectRows().ok, true, 'the extra entry must be gone again');
    });
});

describe('armed_map/manifest: ProtocolChanges table is config-independent', function () {

    const CONFIGS = [
        { config: {}, util: {} },
        { config: { NETWORK: 'mainnet' }, util: {} },
        { config: { NETWORK: 'testnet', COIN: 'LTC' }, util: { anything: true } },
        { config: { NETWORK: 'regtest', COIN: 'DOGE', DB_NAME: 'x', HUB_URL: 'http://127.0.0.1:1' },
          util: { getCurrentTime: () => 0 }, decoderDb: {}, indexerDb: {} },
    ];

    it('builds a byte-identical table under every config and util', function () {
        const readings = CONFIGS.map((indexer) => {
            const pc = new ProtocolChanges(indexer);
            // The constructor did read the config: without this the equality below
            // could pass because nothing varied, not because nothing depends on it.
            assert.strictEqual(pc.network, indexer.config.NETWORK);
            return canonicalValue(pc.changes);
        });
        for (const r of readings.slice(1)) assert.strictEqual(r, readings[0]);
    });

    it('builds the same table the manifest rows carry', function () {
        const table = new ProtocolChanges(CONFIGS[2]).changes;
        const rows = new Map(manifest.collectRows().rows);
        for (const name of Object.keys(table)) {
            assert.strictEqual(canonicalValue(rows.get('protocol_changes.changes.' + name)),
                canonicalValue(table[name]), name);
        }
    });
});
