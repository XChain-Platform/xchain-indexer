/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The indirect idioms the sibling reference map has to see.
 *
 * WHY THIS EXISTS. The map is the safety net the feature-directory restructure
 * steers by, and on 2026-09-13 it was measured blind to the shape the sibling
 * suites actually use: the checkout in a variable, the file joined onto it. A
 * map that under-reports its own blast radius reads exactly like a map with
 * nothing left to find, so the only thing that tells them apart is a suite that
 * drives each idiom against a known answer.
 *
 * Every case here is a fixture string rather than a file in the tree, because
 * the tree moves during the restructure and an assertion pinned to whatever
 * xchain-sync happens to say today would be measuring the peer lane, not the
 * matcher. The two live cases at the end read real files whose IDIOM is stable
 * even while their paths move.
 *
 * This suite is outside test/ on purpose: every npm test script globs from
 * test/, and the pass pins those scripts' collected titles. Run it directly:
 *
 *   npx mocha --no-config --timeout 30000 bin/test/sibling-reference-map.test.js
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const refs = require('../sibling-reference-map.js');

const PLATFORM_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Every src/ path a fixture resolves to, sorted and de-duplicated. */
function paths(text, opts) {
    return Array.from(new Set(refs.scanIndirectIdioms(text, opts || {}).found.map((f) => f.path))).sort();
}

/** The dynamic sites a fixture leaves for a human, by their expression text. */
function dynamics(text, opts) {
    return refs.scanIndirectIdioms(text, opts || {}).dynamic.map((d) => d.expression);
}

// The platform's twin-copier script, by name only: which directory of the tree
// around this checkout holds the tooling is the caller's business (SCOPE in the
// tool header), so the suite looks it up the same two ways the sweep does.
const TWIN_COPIER = 'reconcile-twins.sh';

/**
 * The twin-copier script's path, or null when this checkout stands alone, which
 * is every consumer outside the platform tree.
 *
 * @returns {string|null}
 */
function findTwinCopier() {
    for (const dir of refs.platformToolingDirs()) {
        const named = path.join(PLATFORM_ROOT, dir, TWIN_COPIER);
        if (fs.existsSync(named)) return named;
    }
    let entries;
    try { entries = fs.readdirSync(PLATFORM_ROOT, { withFileTypes: true }); } catch (e) { return null; }
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('xchain-')) continue;
        const probe = path.join(PLATFORM_ROOT, entry.name, 'bin', TWIN_COPIER);
        if (fs.existsSync(probe)) return probe;
    }
    return null;
}

/** A throwaway tree with one sibling repo and one tooling directory beside it. */
function makeFixtureRoot() {
    const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sibling-map-'));
    const sibling = path.join(root, 'xchain-fixture', 'test');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'load.js'),
        "const u = require('../../xchain-indexer/src/utility.js');\n");
    const tooling = path.join(root, 'tooling', 'bin');
    fs.mkdirSync(tooling, { recursive: true });
    fs.writeFileSync(path.join(tooling, TWIN_COPIER),
        '#!/usr/bin/env bash\nIDX="$HOME/xchain-indexer"\ncp "$IDX/src/rollback.js" .\n');
    return root;
}

describe('bin/sibling-reference-map.js: the resolved-root-variable idiom', () => {
    it('reads a root held in a variable and joined segment by segment', () => {
        const src = [
            "const INDEXER_ROOT = path.resolve(__dirname, '../../../xchain-indexer');",
            "const Slash = require(path.join(INDEXER_ROOT, 'src', 'actions', 'slash.js'));",
            "const eq    = require(path.join(INDEXER_ROOT, 'src', 'equivocation_header.js'));",
        ].join('\n');
        assert.deepStrictEqual(paths(src), ['src/actions/slash.js', 'src/equivocation_header.js']);
    });

    it('reads the same root whatever the variable is called and however deep the walk', () => {
        const src = [
            'const r = path.resolve(__dirname, "../../../../../xchain-indexer");',
            'const u = require(path.join(r, "src", "utility.js"));',
        ].join('\n');
        assert.deepStrictEqual(paths(src), ['src/utility.js'],
            'double quotes and a five-level walk are the same idiom');
    });

    it('reads a tail written as one literal and a tail written as a template', () => {
        const src = [
            "const R = path.resolve(__dirname, '../../xchain-indexer');",
            "const a = require(path.join(R, 'src/config.js'));",
            'const b = fs.readFileSync(`${R}/src/protocol_changes.js`, "utf8");',
            "const c = fs.readFileSync(R + '/src/migrate.js', 'utf8');",
        ].join('\n');
        assert.deepStrictEqual(paths(src),
            ['src/config.js', 'src/migrate.js', 'src/protocol_changes.js']);
    });

    it('follows a root that already points at src/', () => {
        const src = [
            "const CANON_SRC = path.join(__dirname, '../../../xchain-indexer/src');",
            "const canon = fs.readFileSync(path.join(CANON_SRC, 'hub_db_sync.js'), 'utf8');",
        ].join('\n');
        assert.deepStrictEqual(paths(src), ['src/hub_db_sync.js'],
            'the src/ segment lives in the declaration, not in the use');
    });

    it('follows the root out of the environment, with or without a fallback', () => {
        const bare = [
            'const INDEXER_PATH = process.env.XCHAIN_INDEXER_PATH;',
            "const acts = path.join(INDEXER_PATH, 'src/actions.js');",
        ].join('\n');
        assert.deepStrictEqual(paths(bare), ['src/actions.js']);

        const fallback = [
            'const INDEXER_PATH = process.env.XCHAIN_INDEXER_PATH',
            "    || path.resolve(__dirname, '../../../xchain-indexer');",
            "const acts = path.join(INDEXER_PATH, 'src/actions.js');",
        ].join('\n');
        assert.deepStrictEqual(paths(fallback), ['src/actions.js'],
            'the || fallback is the spelling every sdk guard uses');
    });

    it('follows a root selected out of a candidate list', () => {
        const src = [
            'const INDEXER_ROOT = [',
            '    process.env.XCHAIN_INDEXER_PATH,',
            '    process.env.XCHAIN_INDEXER_DIR,',
            "    path.join(__dirname, '..', '..', '..', 'xchain-indexer'),",
            '].filter(Boolean)[0];',
            "const TWIN = path.join(INDEXER_ROOT, 'src', 'addressRefFields.js');",
        ].join('\n');
        assert.deepStrictEqual(paths(src), ['src/addressRefFields.js']);
    });

    it('expands a tail bound to a literal array instead of calling it dynamic', () => {
        const src = [
            "const R = path.resolve(__dirname, '../../xchain-indexer');",
            "for (const f of ['merkle.js', 'stateHash.js']) {",
            "    fs.readFileSync(path.join(R, 'src', f), 'utf8');",
            '}',
        ].join('\n');
        assert.deepStrictEqual(paths(src), ['src/merkle.js', 'src/stateHash.js'],
            'every element of the list is its own repoint on a move');
    });

    it('does not invent a path from a list whose loop has already closed', () => {
        const src = [
            "const R = path.resolve(__dirname, '../../xchain-indexer');",
            "for (const f of ['merkle.js']) { fs.readFileSync(path.join(R, 'src', f), 'utf8'); }",
            "for (const f of fs.readdirSync(dir)) { fs.readFileSync(path.join(R, 'src', 'sql', f), 'utf8'); }",
        ].join('\n');
        assert.deepStrictEqual(paths(src), ['src/merkle.js'],
            'the second loop reads a directory, so binding it to the first list would fabricate files');
        assert.deepStrictEqual(dynamics(src), ["path.join(R, 'src', 'sql', f)"],
            'and it must be handed to a human instead');
    });

    it('does not treat every variable that merely mentions a root as a root', () => {
        const src = [
            "const R = path.resolve(__dirname, '../../xchain-indexer');",
            "const HAVE = fs.existsSync(path.join(R, 'src/actions.js'));",
            "const other = path.join(HAVE, 'src/never_a_file.js');",
        ].join('\n');
        assert.deepStrictEqual(paths(src), ['src/actions.js'],
            'a boolean probe is not a checkout, and joining onto it is not a reference');
    });

    it('ignores a declaration that already names a file, which the text matcher owns', () => {
        const src = "const U = require(path.resolve(__dirname, '../../xchain-indexer/src/utility.js'));";
        assert.strictEqual(refs.rootPrefix("path.resolve(__dirname, '../../xchain-indexer/src/utility.js')"), null);
        assert.deepStrictEqual(paths(src), []);
    });

    it('classifies each spelling of where a root stops', () => {
        assert.strictEqual(refs.rootPrefix("path.resolve(__dirname, '../../xchain-indexer')"), '');
        assert.strictEqual(refs.rootPrefix("path.join(__dirname, '../../xchain-indexer/src')"), 'src');
        assert.strictEqual(refs.rootPrefix("path.join(base, 'xchain-indexer', 'src')"), 'src');
        assert.strictEqual(refs.rootPrefix('process.env.XCHAIN_INDEXER_PATH'), '');
        assert.strictEqual(refs.rootPrefix("path.join(base, 'xchain-hub', 'src')"), null);
        assert.strictEqual(refs.rootPrefix("path.join(base, 'xchain-indexer', 'src', 'sql')"), 'src/sql',
            'a root can stop below src/, and the whole prefix is what the tail hangs off');
    });

    it('keeps the full prefix of a root that stops below src/', () => {
        const src = [
            "const INDEXER_SQL_DIR = path.join(__dirname, '..', '..', '..', 'xchain-indexer', 'src', 'sql');",
            "for (const f of ['blocks.sql', 'credits.sql']) {",
            '    fs.readFileSync(path.join(INDEXER_SQL_DIR, f), "utf8");',
            '}',
        ].join('\n');
        assert.deepStrictEqual(paths(src), ['src/sql/blocks.sql', 'src/sql/credits.sql'],
            'these live at src/sql/, and recording them at src/ would point the repoint at nothing');
    });

    it('expands a template tail over its list instead of recording the template', () => {
        const src = [
            "const INDEXER = path.resolve(ROOT, '../xchain-indexer/src');",
            "const COIN_JS = ['BTC', 'LTC'].map((c) => path.join(INDEXER, 'coins', `${c}.js`));",
        ].join('\n');
        assert.deepStrictEqual(paths(src), ['src/coins/BTC.js', 'src/coins/LTC.js'],
            'a path spelled with an interpolation is two real files, never one called ${c}.js');
    });

    it('never records an interpolated template as a literal segment', () => {
        assert.strictEqual(refs.literalJoinTail(" 'coins', `${c}.js`)"), null);
        assert.strictEqual(refs.literalJoinTail(' `coins`, `BTC.js`)'), 'coins/BTC.js',
            'a backtick with no interpolation is still just a string');
    });
});

describe('bin/sibling-reference-map.js: the helper-closure idiom', () => {
    const HELPER = [
        'function indexerFile(rel){',
        '    const pathMod = require("path");',
        '    const root = process.env.XCHAIN_INDEXER_SQL_PATH',
        '        ? pathMod.resolve(process.env.XCHAIN_INDEXER_SQL_PATH, "..", "..")',
        '        : pathMod.resolve(__dirname, "..", "..", "..", "xchain-indexer");',
        '    return pathMod.resolve(root, rel);',
        '}',
    ].join('\n');

    it('resolves a literal call through the closure', () => {
        const src = `${HELPER}\nconst p = indexerFile('src/rollback.js');`;
        assert.deepStrictEqual(paths(src), ['src/rollback.js']);
    });

    it('emits one path per element of the array a call loops over', () => {
        const src = [
            HELPER,
            "for(const twin of ['merkle.js', 'stateHash.js', 'tableLifecycle.js']){",
            "    const p = indexerFile('src/' + twin);",
            '}',
        ].join('\n');
        assert.deepStrictEqual(paths(src),
            ['src/merkle.js', 'src/stateHash.js', 'src/tableLifecycle.js'],
            'the loop is ten repoints on a move, not one note for a human');
    });

    it('reads one column out of a loop over rows of literals', () => {
        const src = [
            HELPER,
            'for(const [twin, indexerRel] of [',
            "    ['merkle.js',           'src/consensus/merkle.js'],",
            '    // the hub sources moved as a group',
            "    ['tableLifecycle.js',   'src/hub/tableLifecycle.js'],",
            ']){',
            '    const p = indexerFile(indexerRel);',
            '}',
        ].join('\n');
        assert.deepStrictEqual(paths(src),
            ['src/consensus/merkle.js', 'src/hub/tableLifecycle.js'],
            'a comment between rows must not truncate the list');
    });

    it('carries a call whose argument is a single-assignment constant', () => {
        const src = [
            HELPER,
            "const rel = 'src/archive_rollback_author_scope_activation.js';",
            'const p = indexerFile(rel);',
        ].join('\n');
        assert.deepStrictEqual(paths(src), ['src/archive_rollback_author_scope_activation.js']);
    });

    it('hands an unresolvable argument to a human rather than guessing', () => {
        const src = `${HELPER}\nconst p = indexerFile(whateverThisIs);`;
        assert.deepStrictEqual(paths(src), []);
        assert.deepStrictEqual(dynamics(src), ['whateverThisIs']);
    });

    it('does not mistake a sibling-presence guard for a path helper', () => {
        const guard = [
            'function requireSibling(ctx, absPath){',
            '    if(require("fs").existsSync(absPath)) return true;',
            '    throw new Error("guard cannot run: check out xchain-indexer or set XCHAIN_INDEXER_SQL_PATH");',
            '}',
            "const ok = requireSibling(this, 'src/rollback.js');",
        ].join('\n');
        assert.deepStrictEqual(paths(guard), [],
            'it names the repo in an error string and builds no path at all');
    });
});

describe('bin/sibling-reference-map.js: the bash idioms', () => {
    it('reads a checkout held in a shell variable', () => {
        const src = [
            '#!/usr/bin/env bash',
            'IDX="$ROOT/xchain-indexer"',
            'cp "$IDX/src/merkle.js" "$OUT/merkle.js"',
            'node -e "require(\'$IDX/src/stateHash.js\')"',
        ].join('\n');
        assert.deepStrictEqual(paths(src, { shell: true }), ['src/merkle.js', 'src/stateHash.js'],
            'quoted and bare, braced or not, it is the same reference');
    });

    it('reads the repo name passed as its own word with the path beside it', () => {
        const src = [
            '#!/usr/bin/env bash',
            'copy_twin xchain-indexer src/tableLifecycle.js xchain-sync src/tableLifecycle.js',
        ].join('\n');
        assert.deepStrictEqual(paths(src, { shell: true }), ['src/tableLifecycle.js']);
    });

    it('expands that word form over the literal list its loop names', () => {
        const src = [
            '#!/usr/bin/env bash',
            'for f in stateHash.js merkle.js \\',
            '         state_subtree_activation.js; do',
            '    copy_twin xchain-indexer "src/$f" xchain-sync "src/$f"',
            'done',
        ].join('\n');
        assert.deepStrictEqual(paths(src, { shell: true }),
            ['src/merkle.js', 'src/stateHash.js', 'src/state_subtree_activation.js'],
            'a line continuation is part of the same list');
    });

    it('does not bind a loop variable that is out of scope by then', () => {
        const src = [
            '#!/usr/bin/env bash',
            'for f in stateHash.js; do',
            '    copy_twin xchain-indexer "src/$f" xchain-sync "src/$f"',
            'done',
            'copy_twin xchain-indexer "src/$g" xchain-sync "src/$g"',
        ].join('\n');
        assert.deepStrictEqual(paths(src, { shell: true }), ['src/stateHash.js']);
        assert.deepStrictEqual(dynamics(src, { shell: true }), ['src/$g'],
            'an unbound expansion is a human check, never a guess');
    });

    it('does not claim another repo\'s root as this one', () => {
        const src = [
            '#!/usr/bin/env bash',
            'HUB_ROOT="$ROOT/xchain-hub"',
            'SRC_DIR="$HUB_ROOT/src/observability"',
        ].join('\n');
        assert.deepStrictEqual(paths(src, { shell: true }), []);
    });

    it('picks the bash matchers by extension or by shebang', () => {
        assert.strictEqual(refs.isShellFile('bin/reconcile-twins.sh', ''), true);
        assert.strictEqual(refs.isShellFile('bin/reconcile-twins', '#!/usr/bin/env bash\n'), true);
        assert.strictEqual(refs.isShellFile('test/x.test.js', "'use strict';\n"), false);
    });
});

describe('bin/sibling-reference-map.js: the computed require', () => {
    it('lists the modules a computed require loads over a literal table', () => {
        const src = [
            'const SHARED_GATES = [',
            "    ['anchor_reward_activation', ['ANCHOR_REWARD_ACTIVATION']],",
            '    // unratified on both networks, and still part of the preimage',
            "    ['attest_zero_conf_activation', ['ATTEST_ZERO_CONF_ACTIVATION']],",
            '];',
            'for (const [mod, names] of SHARED_GATES) {',
            "    try { m = require('./' + mod + '.js'); } catch (e) { m = null; }",
            '}',
        ].join('\n');
        const sites = refs.computedRequireSites(src, 'src');
        assert.strictEqual(sites.length, 1, 'the computed require is one site');
        assert.deepStrictEqual(sites[0].listCandidates,
            ['src/anchor_reward_activation.js', 'src/attest_zero_conf_activation.js'],
            'the carrier list is what a move has to be checked against');
    });

    it('reports the site with an empty list when nothing names the modules', () => {
        const src = "const m = require('./' + fromSomewhereElse + '.js');";
        const sites = refs.computedRequireSites(src, 'src');
        assert.strictEqual(sites.length, 1);
        assert.deepStrictEqual(sites[0].listCandidates, [],
            'the hazard is reported even when the list cannot be recovered');
    });

    it('resolves the list relative to the requiring file, not to the repo root', () => {
        const src = [
            "const MIXINS = ['sends.js', 'stakes.js'];",
            'for (const mod of MIXINS) {',
            "    const m = require('./' + mod);",
            '}',
        ].join('\n');
        assert.deepStrictEqual(refs.computedRequireSites(src, 'src/db')[0].listCandidates,
            ['src/db/sends.js', 'src/db/stakes.js']);
    });
});

describe('bin/sibling-reference-map.js: the idioms in the real tree', function () {
    this.timeout(30000);

    it('sees the platform twin-copier script, which no CI job runs', function () {
        const file = findTwinCopier();
        // Absent means a checkout standing on its own, without the platform
        // tooling beside it. Skipped and visible, never silently green.
        if (!file) return this.skip();
        const text = fs.readFileSync(file, 'utf8');
        assert.strictEqual(refs.isShellFile(file, text), true);
        const found = refs.scanIndirectIdioms(text, { shell: true }).found;
        assert.ok(found.length >= 20,
            `the script byte-copies about thirty src/ files outward, saw ${found.length}`);
        assert.ok(found.every((f) => f.path.startsWith('src/')),
            'every hit is a path inside this repo');
        // The literal `xchain-indexer/src/...` spelling appears in the script
        // exactly twice, in one sed mask. Without the word form, a text sweep of
        // this file reports two references where there are more than twenty, so
        // this is the measurement that says the new matcher is load-bearing here.
        const literal = (text.match(/xchain-indexer\/src\//g) || []).length;
        assert.ok(found.length > literal * 5,
            `the word form carries the file: ${found.length} indirect against ${literal} literal`);
    });

    it('sees the sdk parity guard that reaches in through an env-var root', () => {
        const file = path.join(PLATFORM_ROOT, 'xchain-sdk', 'test', 'unit', 'address_ref_fields.test.js');
        const found = refs.scanIndirectIdioms(fs.readFileSync(file, 'utf8'), { shell: false }).found;
        assert.strictEqual(found.length, 1, 'the guard pins exactly one indexer file');
        assert.ok(/^src\/.*addressRefFields\.js$/.test(found[0].path),
            `the twin it pins, wherever the restructure has put it: ${found[0].path}`);
        assert.strictEqual(found[0].form, 'root-var');
    });
});

describe('bin/sibling-reference-map.js: the opt-in platform-tooling sweep', function () {
    this.timeout(30000);

    let root;
    before(() => { root = makeFixtureRoot(); });
    after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

    it('sweeps the xchain-* siblings only, by default', () => {
        // The directory list is SET here on purpose: what holds the default map to
        // the siblings is the flag, so a test with nothing named would pass just as
        // well against a tool that had lost the flag entirely.
        const saved = process.env[refs.PLATFORM_TOOLING_ENV];
        process.env[refs.PLATFORM_TOOLING_ENV] = 'tooling/bin';
        let map;
        try {
            map = refs.buildReferenceMap(root);
        } finally {
            if (saved === undefined) delete process.env[refs.PLATFORM_TOOLING_ENV];
            else process.env[refs.PLATFORM_TOOLING_ENV] = saved;
        }
        assert.deepStrictEqual(map.siblingRepos, ['xchain-fixture'],
            'the default scope is the sibling checkouts');
        assert.deepStrictEqual(map.platformToolingSwept, [],
            'a default map declares that it swept no tooling directory');
        const referrers = Object.values(map.paths).flatMap((p) => p.referrers);
        assert.ok(referrers.length >= 1, 'the sibling reference is still found');
        assert.ok(referrers.every((r) => r.repo === 'xchain-fixture'),
            `no tooling path reaches a default map: ${JSON.stringify(referrers.map((r) => r.file))}`);
    });

    it('sweeps a named tooling directory when the caller opts in', () => {
        const map = refs.buildReferenceMap(root, {
            includePlatformTooling: true,
            extraDirs: ['tooling/bin'],
        });
        assert.deepStrictEqual(map.platformToolingSwept, ['tooling/bin'],
            'the map names the directory it swept');
        const rollback = map.paths['src/rollback.js'];
        assert.ok(rollback, 'the twin-copier idiom in the tooling directory is read');
        const ref = rollback.referrers.find((r) => r.repo === refs.PLATFORM_TOOLING_LABEL);
        assert.ok(ref, `the hit carries the tooling label: ${JSON.stringify(rollback.referrers)}`);
        assert.strictEqual(ref.form, 'shell-var');
        assert.ok(ref.file.endsWith(`tooling/bin/${TWIN_COPIER}`), `the file it came from: ${ref.file}`);
        assert.ok(!map.siblingRepos.includes(refs.PLATFORM_TOOLING_LABEL),
            'the tooling label is never one of the sibling repos');
    });

    it('reads the directory list out of the environment when the caller names none', () => {
        const saved = process.env[refs.PLATFORM_TOOLING_ENV];
        process.env[refs.PLATFORM_TOOLING_ENV] = ' tooling/bin , ';
        try {
            assert.deepStrictEqual(refs.platformToolingDirs(), ['tooling/bin'],
                'blank entries and padding are dropped');
            const map = refs.buildReferenceMap(root, { includePlatformTooling: true });
            assert.deepStrictEqual(map.platformToolingSwept, ['tooling/bin']);
        } finally {
            if (saved === undefined) delete process.env[refs.PLATFORM_TOOLING_ENV];
            else process.env[refs.PLATFORM_TOOLING_ENV] = saved;
        }
        assert.deepStrictEqual(refs.platformToolingDirs({}), [],
            'an unset variable names no directory, so the sweep stays a no-op');
    });
});
