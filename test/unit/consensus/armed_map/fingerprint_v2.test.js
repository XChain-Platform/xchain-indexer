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

// Armed-map fingerprint v2 for the running process, and the falsification
// cases of the fingerprint v2 design (section 7, P4) driven on a COPY of src/
// in a temporary directory. The copy is the point: each case edits carrier
// files, and the real tree must never be touched, both for sibling suites
// running in the same checkout and because a restore that fails half-way
// would leave a consensus carrier edited.

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const V2_PATH = path.join(REPO, 'src', 'consensus', 'armed_map', 'fingerprint_v2.js');

const v2 = require('../../../../src/consensus/armed_map/fingerprint_v2.js');
const manifest = require('../../../../src/consensus/armed_map/manifest.js');
const { fingerprint } = require('../../../../src/consensus/armed_map/canonical.js');

const HEX64 = /^[0-9a-f]{64}$/;

describe('armed_map/fingerprint_v2: the running process', function () {

    it('is the canonical fingerprint of the manifest rows', function () {
        const out = v2.computeArmedMapFingerprintV2();
        assert.match(out.hex, HEX64, out.reason);
        const expected = fingerprint(manifest.collectRows().rows);
        assert.strictEqual(out.hex, expected.hex);
        assert.strictEqual(out.count, manifest.ENTRIES.length);
        assert.deepStrictEqual(out.rows, expected.rows);
    });

    it('is memoized per process', function () {
        assert.strictEqual(v2.computeArmedMapFingerprintV2(), v2.computeArmedMapFingerprintV2());
    });

    it('publishes UNREADABLE with the reason when a row cannot be collected', function () {
        const cachedModule = require.cache[V2_PATH];
        delete require.cache[V2_PATH];
        manifest.ENTRIES.push(['zz_test.THROWS', () => { throw new Error('carrier failed to load'); }]);
        let out;
        try {
            out = require(V2_PATH).computeArmedMapFingerprintV2();
        } finally {
            manifest.ENTRIES.pop();
            require.cache[V2_PATH] = cachedModule;
        }
        assert.strictEqual(out.hex, v2.UNREADABLE);
        assert.ok(out.reason.includes('zz_test.THROWS'), out.reason);
        assert.strictEqual(out.count, undefined);
    });

    it('is published on the health payload beside v1', async function () {
        const { buildHealthResponse } = require('../../../../src/api/health.js');
        // The smallest indexer the builder accepts, in the shape test/unit/health.test.js uses.
        const indexer = { decoderDb: { circuitState: 'closed' }, indexerDb: { circuitState: 'closed' },
            lastDecoderBlock: 200, lastHubConfigFetchAt: null, stallReason: null, isSynced: () => false };
        const res = await buildHealthResponse({ indexer, indexerRunning: true, indexerError: null,
            lastIndexedBlock: 190, now: 1000000 });
        assert.match(res.armed_map_fingerprint, HEX64);
        assert.strictEqual(res.armed_map_fingerprint_v2, v2.computeArmedMapFingerprintV2().hex);
        assert.strictEqual(res.armed_map_rows, undefined, 'the row count belongs to consensus-identity, not health');
    });

    it('is published by consensus-identity --json beside v1, with its row count', function () {
        const res = spawnSync(process.execPath, [path.join(REPO, 'bin', 'consensus-identity.js'), '--json'],
            { cwd: REPO, encoding: 'utf8' });
        assert.strictEqual(res.status, 0, res.stderr);
        const identity = JSON.parse(res.stdout);
        assert.match(identity.armed_map_fingerprint, HEX64);
        assert.strictEqual(identity.armed_map_fingerprint_v2, v2.computeArmedMapFingerprintV2().hex);
        assert.strictEqual(identity.armed_map_rows, manifest.ENTRIES.length);
        assert.notStrictEqual(identity.armed_map_fingerprint_v2, identity.armed_map_fingerprint);
    });
});

// ---------------------------------------------------------------- temp trees

const trees = [];

// A copy of src/ (and the named extra files) under a fresh temp directory,
// with node_modules linked to this checkout's unless withModules is false.
function makeTree({ withModules = true, extra = [] } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'armed-map-v2-'));
    trees.push(dir);
    fs.cpSync(path.join(REPO, 'src'), path.join(dir, 'src'), { recursive: true });
    for (const rel of extra) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.copyFileSync(path.join(REPO, rel), path.join(dir, rel));
    }
    if (withModules) fs.symlinkSync(fs.realpathSync(path.join(REPO, 'node_modules')), path.join(dir, 'node_modules'));
    return dir;
}

function removeTree(dir) {
    // Unlink the node_modules LINK first, so no recursive delete can ever walk
    // into the real dependency tree it points at.
    const link = path.join(dir, 'node_modules');
    if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
    fs.rmSync(dir, { recursive: true, force: true });
}

const READ_SCRIPT = [
    "const path = require('path');",
    "const out = require(path.resolve('src/consensus/armed_map/fingerprint_v2.js')).computeArmedMapFingerprintV2();",
    "const v1 = require(path.resolve('src/armed_map_fingerprint.js')).computeArmedMapFingerprint().fingerprint;",
    "if (process.argv[1] === 'load-main') require(path.resolve('src/XChainIndexer.js'));",
    'process.stdout.write(JSON.stringify({ hex: out.hex, count: out.count, reason: out.reason, v1 }));',
].join('\n');

function childEnv() {
    const env = Object.assign({}, process.env);
    delete env.NODE_PATH;
    return env;
}

// v2 (and v1) as a fresh process reads them from the tree at dir.
function readTree(dir, arg) {
    const res = spawnSync(process.execPath, ['-e', READ_SCRIPT, arg || ''], { cwd: dir, encoding: 'utf8', env: childEnv() });
    return { status: res.status, stderr: res.stderr, out: res.status === 0 ? JSON.parse(res.stdout) : null };
}

function editFile(dir, rel, from, to) {
    const file = path.join(dir, rel);
    const before = fs.readFileSync(file, 'utf8');
    assert.ok(before.includes(from), rel + ' no longer contains ' + JSON.stringify(from) + '; re-aim this case');
    fs.writeFileSync(file, before.replace(from, to));
}

function allJs(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...allJs(abs));
        else if (e.name.endsWith('.js')) out.push(abs);
    }
    return out;
}

// Moves one module and rewrites every relative require under src/ that named
// it, plus the moved module's own relative requires, the way a real move is
// repointed. Returns how many requirers were rewritten.
function moveModule(dir, fromRel, toRel) {
    const fromAbs = path.join(dir, fromRel);
    const toAbs = path.join(dir, toRel);
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    fs.renameSync(fromAbs, toAbs);
    let rewritten = 0;
    for (const file of allJs(path.join(dir, 'src'))) {
        const oldDir = file === toAbs ? path.dirname(fromAbs) : path.dirname(file);
        const text = fs.readFileSync(file, 'utf8');
        const next = text.replace(/require\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g, (whole, quote, spec) => {
            const target = path.resolve(oldDir, spec);
            const isMoved = target === fromAbs || target + '.js' === fromAbs;
            if (!isMoved && file !== toAbs) return whole;
            let resolved = isMoved ? toAbs : target;
            if (!spec.endsWith('.js') && resolved.endsWith('.js') && isMoved) resolved = resolved.slice(0, -3);
            let rel = path.relative(path.dirname(file), resolved).split(path.sep).join('/');
            if (!rel.startsWith('.')) rel = './' + rel;
            if (isMoved) rewritten += 1;
            return 'require(' + quote + rel + quote + ')';
        });
        if (next !== text) fs.writeFileSync(file, next);
    }
    return rewritten;
}

describe('armed_map/fingerprint_v2: temp-tree falsification of armed values (design section 7, P4)', function () {
    this.timeout(180000);

    let baseline;

    before(function () {
        baseline = v2.computeArmedMapFingerprintV2();
        assert.match(baseline.hex, HEX64, baseline.reason);
    });

    after(function () {
        for (const dir of trees.splice(0)) removeTree(dir);
    });

    it('an unmodified copy reads the same v2 as this process (the harness measures what it claims)', function () {
        const r = readTree(makeTree());
        assert.strictEqual(r.status, 0, r.stderr);
        assert.strictEqual(r.out.hex, baseline.hex);
        assert.strictEqual(r.out.count, baseline.count);
    });

    it('a committed height change moves v2', function () {
        const dir = makeTree();
        editFile(dir, 'src/state_commitment_activation.js', "'BTC:testnet':  145000,", "'BTC:testnet':  145001,");
        const r = readTree(dir);
        assert.strictEqual(r.status, 0, r.stderr);
        assert.match(r.out.hex, HEX64, r.out.reason);
        assert.notStrictEqual(r.out.hex, baseline.hex);
    });

    it('null (not yet pinned) to 9999999999 (unarmed sentinel) moves v2', function () {
        const dir = makeTree();
        editFile(dir, 'src/slash_ledger_consolidation_activation.js', "'BTC:testnet':  null,", "'BTC:testnet':  9999999999,");
        const r = readTree(dir);
        assert.strictEqual(r.status, 0, r.stderr);
        assert.match(r.out.hex, HEX64, r.out.reason);
        assert.notStrictEqual(r.out.hex, baseline.hex);
    });
});

const GUARD = 'test/unit/consensus/armed_map/manifest.test.js';
const V1_TEST = 'test/unit/consensus/armed_map/armed_map_fingerprint.test.js';

// The completeness guard suite, run by mocha against the temp tree at dir.
function runGuard(dir) {
    const mocha = fs.realpathSync(path.join(REPO, 'node_modules', '.bin', 'mocha'));
    return spawnSync(process.execPath, [mocha, '--no-config', '--timeout', '60000', GUARD],
        { cwd: dir, encoding: 'utf8', env: childEnv() });
}

// Green on an unmodified copy, red once `from` becomes `to` in the copy's
// manifest, and v2 moved: a guard that is red on both sides proves nothing.
function deletedEntryCase(baselineHex, from, to) {
    const dir = makeTree({ extra: [GUARD, V1_TEST] });
    const green = runGuard(dir);
    assert.strictEqual(green.status, 0, 'guard must be green on the unmodified copy: ' + green.stdout + green.stderr);
    editFile(dir, 'src/consensus/armed_map/manifest.js', from, to);
    const red = runGuard(dir);
    assert.notStrictEqual(red.status, 0, 'guard stayed green after a manifest entry was deleted');
    const r = readTree(dir);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.notStrictEqual(r.out.hex, baselineHex, 'v2 must move when a row leaves the manifest');
}

describe('armed_map/fingerprint_v2: temp-tree falsification of layout and the completeness guard (design section 7, P4)', function () {
    this.timeout(180000);

    let baseline;

    before(function () {
        baseline = v2.computeArmedMapFingerprintV2();
        assert.match(baseline.hex, HEX64, baseline.reason);
    });

    after(function () {
        for (const dir of trees.splice(0)) removeTree(dir);
    });

    it('a comment, a whitespace reformat and a rename-and-move with requirers repointed leave v2 unchanged', function () {
        const dir = makeTree();
        const plain = readTree(dir);
        assert.strictEqual(plain.status, 0, plain.stderr);
        fs.appendFileSync(path.join(dir, 'src/snapshot_reorg_buffer.js'), '\n// a comment that changes no value\n');
        editFile(dir, 'src/state_commitment_activation.js', "'BTC:testnet':  145000,", "'BTC:testnet'   :\n        145000 ,");
        const requirers = moveModule(dir, 'src/train_activation.js', 'src/activations/rule_set_train.js');
        assert.ok(requirers >= 2, 'expected the manifest and XChainIndexer.js to be repointed, got ' + requirers);
        const r = readTree(dir, 'load-main');
        assert.strictEqual(r.status, 0, 'the moved build must still load: ' + r.stderr);
        assert.strictEqual(r.out.hex, baseline.hex, r.out.reason);
        // v1 hashes names and bytes, so it MUST have moved: proof the edits above were real.
        assert.notStrictEqual(r.out.v1, plain.out.v1);
    });

    it('deleting a whole module entry from the manifest turns the completeness guard red and moves v2', function () {
        deletedEntryCase(baseline.hex, "    ['train_activation', () => require('../../train_activation.js'), ['TRAIN_ACTIVATION']],\n", '');
    });

    it('deleting one export name from a module entry turns the completeness guard red and moves v2', function () {
        deletedEntryCase(baseline.hex, "['EQUIV_HEADER_ACTIVATION', 'ENGINE_TAGS']", "['EQUIV_HEADER_ACTIVATION']");
    });

    it('without node_modules v2 reads UNREADABLE or the process fails, never a plausible hex', function () {
        const dir = makeTree({ withModules: false });
        const res = spawnSync(process.execPath, ['-e', READ_SCRIPT.replace(/^const v1 = .*$/m, 'const v1 = null;')],
            { cwd: dir, encoding: 'utf8', env: childEnv() });
        assert.ok(!HEX64.test(res.stdout) && !/"hex":"[0-9a-f]{64}"/.test(res.stdout),
            'a checkout without node_modules published a hex: ' + res.stdout);
        if (res.status === 0) {
            const out = JSON.parse(res.stdout);
            assert.strictEqual(out.hex, v2.UNREADABLE);
            assert.match(out.reason, /Cannot find module/);
        }
    });
});
