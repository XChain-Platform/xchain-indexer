/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * The armed-map manifest's completeness guard (W3 shape) and collectRows().
 *
 * MEMBERSHIP IS THE REGISTRY. Since the carriers became shims, every table
 * the process applies is a registry row, and the manifest is rows() plus the
 * eleven VM mirror rows. What this guard has to catch is the one way a table
 * can escape that: a map literal declared somewhere under src/ instead of in
 * a registry part file. So the scan that used to check "declared, therefore
 * listed" now fails on ANY declaration outside src/protocol_changes/, and the
 * count it expects is zero.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SRC  = path.join(REPO, 'src');
const PARTS = path.join(SRC, 'protocol_changes');

const manifest = require('../../../../src/consensus/armed_map/manifest.js');
const { canonicalValue } = require('../../../../src/consensus/armed_map/canonical.js');
const ProtocolChanges = require('../../../../src/protocol_changes.js');
const { GATE_MODULE_PATHS, REPLACED_STEMS } = require('../../../helpers/gate_modules.js');

// The two declaration shapes that made a file a carrier. ACTIVATION_MAP is the
// activation-map rule the platform's code-structure gate grades with, and
// CARRIER_DECL is the scan fingerprint v1 enforced, each given a capture group
// here so a hit names the declared export.
const ACTIVATION_MAP = /\b([A-Z][A-Z0-9_]*_ACTIVATION)\s*=\s*\{/g;
const CARRIER_DECL = /^\s*(?:const|let|var)\s+([A-Z0-9_]*ACTIVATIONS?[A-Z0-9_]*)\s*=\s*(?:Object\.freeze\()?\{/gm;

function rowKeys() {
    return new Set(manifest.ENTRIES.map((e) => e[0]));
}

// [file relative to src/, declared name] for every declaration under src/.
function scanDeclarations(root) {
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
    })(root, '');
    return found;
}

// The modules the registry replaced: every *_activation.js still at the top of
// src/ (the W5 twins), the logic-bearing modules W4 moved to their feature
// directories (keyed by the registry stem they kept), and the seven fixed
// carriers, read as the running process resolves them.
const FIXED = ['protocol/constants.js', 'stateHash.js', 'attestation/providerMinStakeHistory.js',
    'stake_weighted_quorum.js', 'equivocation_header.js', 'snapshot_reorg_buffer.js'];
function shimModules() {
    const top = fs.readdirSync(SRC).filter((f) => f.endsWith('_activation.js')).sort()
        .map((rel) => [rel.replace(/\.js$/, ''), rel]);
    const moved = Object.entries(GATE_MODULE_PATHS);
    return top.concat(moved, FIXED.map((rel) => [rel.replace(/\.js$/, ''), rel]))
        .map(([stem, rel]) => [stem, require(path.join(SRC, rel))]);
}

describe('armed_map/manifest: completeness guard', function () {

    it('no activation map or carrier is declared anywhere under src/ outside the registry part files', function () {
        const found = scanDeclarations(SRC);
        const outside = found.filter(([f]) => !f.startsWith('protocol_changes/'));
        assert.deepStrictEqual(outside.map(([f, n]) => f + ':' + n), [],
            'a table declared outside src/protocol_changes/ is applied by nobody and hashed by nobody; ' +
            'it belongs in a registry part file as an addGate() row');
        // The part files write rows as addGate() calls, so the scan must find
        // nothing there either: a match would be a literal that escaped the rule.
        assert.deepStrictEqual(found.map(([f, n]) => f + ':' + n), []);
    });

    it('the scan still finds a declaration when one exists (it is not vacuous)', function () {
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'armed-map-scan-'));
        try {
            fs.writeFileSync(path.join(dir, 'x_activation.js'), 'const X_ACTIVATION = { mainnet: 1 };\nmodule.exports = { X_ACTIVATION };\n');
            fs.writeFileSync(path.join(dir, 'y.js'), 'const MIN_STAKE_ACTIVATIONS = Object.freeze({ mainnet: {} });\n');
            assert.deepStrictEqual(scanDeclarations(dir).sort(), [['x_activation.js', 'X_ACTIVATION'], ['y.js', 'MIN_STAKE_ACTIVATIONS']]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('every non-function export of every shim module is a row, and every row but the time table, the VM mirror and the W4-replaced predicates is exported by one', function () {
        const keys = rowKeys();
        const missing = [];
        const exported = new Set();
        for (const [stem, mod] of shimModules()) {
            for (const name of Object.keys(mod)) {
                if (typeof mod[name] === 'function') continue;
                exported.add(stem + '.' + name);
                if (!keys.has(stem + '.' + name)) missing.push(stem + '.' + name);
            }
        }
        assert.deepStrictEqual(missing, [], 'exported data outside the v2 rows: ' + missing.join(', '));
        // A row nobody exports is read only through activeAt() by its literal
        // key: that is exactly the W4 census, one row per replaced shim, and a
        // new row that no module and no census names still reds here.
        const unexported = [...keys].filter((k) => !k.startsWith('protocol_changes.') && !k.startsWith('xchain-vm.') && !exported.has(k));
        const replaced = [...keys].filter((k) => REPLACED_STEMS.includes(k.slice(0, k.lastIndexOf('.'))));
        assert.strictEqual(replaced.length, REPLACED_STEMS.length, 'one registry row per replaced shim');
        assert.deepStrictEqual(unexported, replaced, 'rows no shim exports, beyond the W4-replaced set: ' +
            unexported.filter((k) => !replaced.includes(k)).join(', '));
    });

});

describe('armed_map/manifest: the row list', function () {

    it('carries the registry rows first, in registry order, then the eleven VM mirror rows', function () {
        const registryKeys = ProtocolChanges.rows().map(([k]) => k);
        const keys = manifest.ENTRIES.map((e) => e[0]);
        assert.deepStrictEqual(keys.slice(0, registryKeys.length), registryKeys);
        assert.deepStrictEqual(keys.slice(registryKeys.length), manifest.VM_EXPORT_NAMES.map((n) => 'xchain-vm.' + n));
        assert.strictEqual(manifest.VM_EXPORT_NAMES.length, 11);
    });

    it('carries exactly the ProtocolChanges table as protocol_changes.changes.* rows', function () {
        const table = Object.keys(new ProtocolChanges({ config: {}, util: {} }).changes).sort();
        const rows = [...rowKeys()].filter((k) => k.startsWith('protocol_changes.changes.')).map((k) => k.slice('protocol_changes.changes.'.length)).sort();
        assert.deepStrictEqual(rows, table);
        assert.strictEqual(table.length, 97);
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
        const text = fs.readFileSync(path.join(SRC, 'consensus', 'armed_map', 'manifest.js'), 'utf8');
        assert.ok(!/require\(['"]\.\.\/\.\.\/[a-z_]+_activation\.js['"]\)/.test(text), 'the manifest lists no module any more');
    });
});

describe('armed_map/manifest: collectRows', function () {

    it('resolves every entry to a serialisable value, in manifest order', function () {
        const res = manifest.collectRows();
        assert.strictEqual(res.ok, true, res.reason);
        assert.deepStrictEqual(res.rows.map((r) => r[0]), manifest.ENTRIES.map((e) => e[0]));
        for (const [, value] of res.rows) canonicalValue(value);
        assert.strictEqual(res.rows.length, 301);
    });

    it('carries the three row families the design names', function () {
        const keys = rowKeys();
        assert.ok(keys.has('state_commitment_activation.STATE_COMMITMENT_ACTIVATION'), 'an activation map');
        assert.ok(keys.has('protocol/constants.XBRIDGE_MAX_PER_BLOCK'), 'a fixed-carrier constant');
        assert.ok(keys.has('stateHash.DEACTIVATION_TABLES'), 'a fixed-carrier array');
        assert.ok(keys.has('protocol_changes.changes.SEND'), 'a ProtocolChanges row');
        assert.ok(keys.has('protocol_changes.CONSENSUS_VERSION'), 'the registry\'s own constant');
        assert.ok(keys.has('mirror_admission_activation.CHAIN_CODE_RE'), 'a RegExp row');
    });

    it('appends the eleven VM mirror rows with the VM values', function () {
        const vm = require('xchain-vm');
        const res = manifest.collectRows();
        assert.strictEqual(res.ok, true, res.reason);
        const byKey = new Map(res.rows);
        for (const name of manifest.VM_EXPORT_NAMES) {
            assert.ok(byKey.has('xchain-vm.' + name), name);
            assert.strictEqual(canonicalValue(byKey.get('xchain-vm.' + name)), canonicalValue(vm[name]), name);
        }
    });

    it('turns a resolver that throws into ok:false naming the key', function () {
        const saved = manifest.ENTRIES[3];
        manifest.ENTRIES[3] = [saved[0], () => { throw new Error('boom'); }];
        try {
            const res = manifest.collectRows();
            assert.strictEqual(res.ok, false);
            assert.ok(res.reason.startsWith(saved[0] + ': boom'), res.reason);
        } finally {
            manifest.ENTRIES[3] = saved;
        }
    });

    it('turns a refused value into ok:false naming the key', function () {
        const saved = manifest.ENTRIES[5];
        manifest.ENTRIES[5] = [saved[0], () => ({ mainnet: () => 1 })];
        try {
            const res = manifest.collectRows();
            assert.strictEqual(res.ok, false);
            assert.ok(res.reason.startsWith(saved[0] + ': '), res.reason);
        } finally {
            manifest.ENTRIES[5] = saved;
        }
    });
});

describe('armed_map/manifest: the registry part files', function () {
    it('every row part file writes addGate() calls at column zero and holds at most 400 lines', function () {
        const parts = fs.readdirSync(PARTS).filter((f) => /^(shared_rows_\d+|gates_\d+|gates_flag_times)\.js$/.test(f)).sort();
        assert.ok(parts.length >= 8, parts.join(','));
        for (const f of parts) {
            const text = fs.readFileSync(path.join(PARTS, f), 'utf8');
            assert.ok(text.split('\n').length <= 401, f + ' is over 400 lines');
            assert.ok(/^addGate\('/m.test(text), f + ' registers nothing');
            assert.ok(!/^[ \t]+addGate\(/m.test(text), f + ' indents an addGate call');
        }
    });
});
