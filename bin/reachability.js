#!/usr/bin/env node
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
 * Can anything still reach this file? Asked of every src/*.js, across the
 * platform rather than inside this repo alone.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A REPO-LOCAL QUESTION. A restructure that
 * deletes a file because no runtime path inside the repo reaches it will delete
 * a module another service requires by relative path out of this checkout, and
 * nothing here fails: the break lands in the sibling's CI, later, attributed to
 * the sibling. Several indexer modules are exactly that shape. A file with no
 * caller in this repo is therefore a CANDIDATE for deletion, and the sibling
 * sweep is what turns a candidate into a verdict.
 *
 * THE FOUR REACHES, kept apart because they carry different weight:
 *
 *   runtime   the require closure of what the service actually starts:
 *             the Dockerfile CMD, and every `node <file>` an npm script runs.
 *             A file outside this closure cannot execute in production.
 *   tooling   the closure of bin/, scripts/ and tools/: operator commands,
 *             verifiers, benchmarks. Real callers, not production ones.
 *   test      the closure of test/. A file reached only from here exists to
 *             be tested and nothing else, which CODE-STYLE calls a signal that
 *             the file is dead rather than a reason to keep it.
 *   siblings  any other repo naming the path, from bin/sibling-reference-map.js
 *             so the two tools can never disagree about what a reference is.
 *
 * A file outside all four is unreferenced across the platform and is the only
 * shape this pass deletes outright.
 *
 * DYNAMIC EDGES. A static walk cannot see a require built at runtime, so every
 * such edge is declared in DYNAMIC_EDGES below with the site that builds it.
 * The walk reports how many it applied, so a new computed require that nobody
 * declared shows up as a file that suddenly reads unreachable.
 *
 * USAGE
 *   node bin/reachability.js                    human summary plus the candidates
 *   node bin/reachability.js --json             the full per-file verdict
 *   node bin/reachability.js --siblings <dir>   sweep root for the sibling half
 *   node bin/reachability.js --no-siblings      repo-local reaches only, fast
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { buildReferenceMap } = require('./sibling-reference-map.js');

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Requires this repo builds at runtime, which no static walk can follow.
 * Each entry names the site that builds the path and what it resolves to, so a
 * reader can check the claim instead of trusting the table.
 */
const DYNAMIC_EDGES = [
    {
        from: 'src/consensus_rules_digest.js',
        // loadGateValues requires './<module>.js' for every SHARED_GATES row, so
        // the gate carriers are held by the digest and not by any literal. The
        // list is read from the module rather than restated, because a restated
        // copy is a second registry that drifts.
        toList: () => {
            const { SHARED_GATES } = require('../src/consensus_rules_digest.js');
            return SHARED_GATES.map(([mod]) => `src/${mod}.js`);
        },
        why: 'the consensus-rules digest requires every SHARED_GATES module by computed path',
    },
];

const SOURCE_EXT = ['.js'];

/** Tracked files only: an untracked scratch copy under src/ is not the tree. */
function trackedFiles() {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
    return out.toString('utf8').split('\0').filter(Boolean);
}

/** Node's own resolution for a relative require, restricted to this repo. */
function resolveRequire(fromRel, spec) {
    if (!spec.startsWith('.')) return null;
    const base = path.posix.join(path.posix.dirname(fromRel), spec);
    const candidates = [base];
    for (const ext of SOURCE_EXT) candidates.push(base + ext);
    for (const ext of SOURCE_EXT) candidates.push(path.posix.join(base, `index${ext}`));
    for (const c of candidates) {
        const abs = path.join(REPO_ROOT, c);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile() && c.endsWith('.js')) return c;
    }
    return null;
}

const REQUIRE_LITERAL = /require\(\s*(['"])([^'"]+)\1\s*\)/g;

/** Every repo-local file `rel` requires by a literal path, plus its declared dynamic edges. */
function edgesFrom(rel, fileSet) {
    const abs = path.join(REPO_ROOT, rel);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { return []; }
    const out = new Set();
    REQUIRE_LITERAL.lastIndex = 0;
    let m;
    while ((m = REQUIRE_LITERAL.exec(text)) !== null) {
        const target = resolveRequire(rel, m[2]);
        if (target && fileSet.has(target)) out.add(target);
    }
    for (const edge of DYNAMIC_EDGES) {
        if (edge.from !== rel) continue;
        // A declared edge that no longer resolves is louder as a thrown error
        // than as a file that quietly starts reading unreachable.
        for (const target of edge.toList()) if (fileSet.has(target)) out.add(target);
    }
    return Array.from(out);
}

/**
 * Who requires each file, counting only non-test callers. Reachability alone
 * calls a module dead when its one caller is itself unreached, which is the
 * wrong verdict whenever that caller is being kept (a tool about to be promoted
 * into bin/, for instance). The reverse edge is what separates the two.
 */
function reverseEdges(fileSet) {
    const back = {};
    for (const rel of fileSet) {
        if (rel.startsWith('test/')) continue;
        for (const target of edgesFrom(rel, fileSet)) {
            if (!back[target]) back[target] = [];
            back[target].push(rel);
        }
    }
    for (const key of Object.keys(back)) back[key] = Array.from(new Set(back[key])).sort();
    return back;
}

/** Transitive closure of `entries` over the require graph. */
function closure(entries, fileSet) {
    const seen = new Set();
    const stack = entries.filter((e) => fileSet.has(e));
    while (stack.length) {
        const cur = stack.pop();
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const next of edgesFrom(cur, fileSet)) if (!seen.has(next)) stack.push(next);
    }
    return seen;
}

/**
 * What the service starts. Two sources, both read rather than assumed: the
 * Dockerfile's exec-form CMD or ENTRYPOINT, and every `node <file>` in an npm
 * script (`npm run migrate` is as much a production path as the API server).
 */
function runtimeEntries(fileSet) {
    const entries = new Set();

    const dockerfile = path.join(REPO_ROOT, 'Dockerfile');
    if (fs.existsSync(dockerfile)) {
        for (const line of fs.readFileSync(dockerfile, 'utf8').split('\n')) {
            if (!/^\s*(CMD|ENTRYPOINT)\b/.test(line)) continue;
            for (const m of line.matchAll(/["']([^"']+\.js)["']/g)) {
                const rel = m[1].replace(/^\.\//, '');
                if (fileSet.has(rel)) entries.add(rel);
            }
        }
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    for (const [name, script] of Object.entries(pkg.scripts || {})) {
        if (name.startsWith('test') || name === 'ci' || name === 'coverage') continue;
        // Token walk rather than one regex: the argument between `node` and the
        // script can be a flag (`--no-node-snapshot`) or nothing at all, and a
        // pattern loose enough for both is loose enough to capture half a path.
        const tokens = script.split(/\s+/);
        for (let i = 0; i < tokens.length; i += 1) {
            if (tokens[i] !== 'node') continue;
            for (let j = i + 1; j < tokens.length; j += 1) {
                if (tokens[j].startsWith('-')) continue;
                if (tokens[j].endsWith('.js')) {
                    const rel = tokens[j].replace(/^\.\//, '');
                    if (fileSet.has(rel)) entries.add(rel);
                }
                break;
            }
        }
    }
    return Array.from(entries).sort();
}

/**
 * Sibling repos carrying a file at the SAME repo-relative path. A vendored twin
 * is a reference no text sweep can see: the sibling requires its own copy, and
 * the two are kept equal by a sync script, so deleting or moving the original
 * silently orphans a live file in another service. `byteIdentical` separates a
 * maintained twin from two files that merely share a name.
 */
function twinCopies(sources, siblingsRoot) {
    const out = {};
    let repos = [];
    try {
        repos = fs.readdirSync(siblingsRoot, { withFileTypes: true })
            .filter((e) => e.name.startsWith('xchain-') && e.name !== 'xchain-indexer')
            .map((e) => e.name)
            .sort();
    } catch (e) {
        return out;
    }
    for (const rel of sources) {
        const mine = path.join(REPO_ROOT, rel);
        let mineText = null;
        try { mineText = fs.readFileSync(mine, 'utf8'); } catch (e) { mineText = null; }
        const found = [];
        for (const repo of repos) {
            const other = path.join(siblingsRoot, repo, rel);
            let otherText;
            try { otherText = fs.readFileSync(other, 'utf8'); } catch (e) { continue; }
            found.push({ path: `${repo}/${rel}`, byteIdentical: mineText !== null && otherText === mineText });
        }
        if (found.length) out[rel] = found;
    }
    return out;
}

/** Every .js directly under a directory tree, as entry points in their own right. */
function entriesUnder(prefixes, fileSet) {
    return Array.from(fileSet).filter((f) => prefixes.some((p) => f.startsWith(p)) && f.endsWith('.js')).sort();
}

/**
 * The verdict for every src/*.js.
 * @returns {{summary: object, files: object}}
 */
function analyse(opts) {
    const all = trackedFiles();
    const fileSet = new Set(all.filter((f) => f.endsWith('.js')));
    const sources = Array.from(fileSet).filter((f) => f.startsWith('src/')).sort();

    const runtimeEntryList = runtimeEntries(fileSet);
    const toolingEntryList = entriesUnder(['bin/', 'scripts/', 'tools/'], fileSet);
    const testEntryList = entriesUnder(['test/'], fileSet);

    const runtime = closure(runtimeEntryList, fileSet);
    const tooling = closure(toolingEntryList, fileSet);
    const tested = closure(testEntryList, fileSet);

    let siblings = { paths: {}, siblingRepos: [], distinctPathCount: 0 };
    let twins = {};
    if (opts.siblings !== false) {
        siblings = buildReferenceMap(opts.siblingsRoot);
        twins = twinCopies(sources, opts.siblingsRoot);
    }

    const back = reverseEdges(fileSet);

    const files = {};
    for (const rel of sources) {
        const sibling = siblings.paths[rel];
        const reachableFromIndexerRuntime = runtime.has(rel);
        const reachableFromTooling = tooling.has(rel);
        const reachableFromTests = tested.has(rel);
        files[rel] = {
            reachableFromIndexerRuntime,
            reachableFromTooling,
            reachableFromTests,
            referencedBySiblings: sibling ? sibling.referrers.map((r) => `${r.file}:${r.line} (${r.kind})`) : [],
            siblingLoadCount: sibling ? sibling.referrers.filter((r) => r.kind !== 'text').length : 0,
            twinCopies: twins[rel] || [],
            requiredByInRepo: back[rel] || [],
            testOnly: !reachableFromIndexerRuntime && !reachableFromTooling && reachableFromTests,
            // Tests are deliberately not a reason to keep a file: CODE-STYLE
            // reads a suite over an otherwise unreachable module as evidence the
            // module is dead, and the suite is deleted with it. Everything else
            // that can hold a file counts.
            unreferencedAcrossPlatform: !reachableFromIndexerRuntime && !reachableFromTooling
                && !sibling && !twins[rel] && !(back[rel] || []).length,
        };
    }

    const notRuntime = sources.filter((f) => !files[f].reachableFromIndexerRuntime);
    return {
        summary: {
            sourceFiles: sources.length,
            runtimeEntryPoints: runtimeEntryList,
            toolingEntryPoints: toolingEntryList.length,
            testEntryPoints: testEntryList.length,
            dynamicEdgesDeclared: DYNAMIC_EDGES.length,
            reachableFromIndexerRuntime: sources.length - notRuntime.length,
            notReachableFromIndexerRuntime: notRuntime.length,
            testOnly: sources.filter((f) => files[f].testOnly).length,
            unreferencedAcrossPlatform: sources.filter((f) => files[f].unreferencedAcrossPlatform).length,
            siblingRepos: siblings.siblingRepos,
        },
        candidates: notRuntime,
        files,
    };
}

function parseArgs(argv) {
    const opts = { json: false, siblings: true, siblingsRoot: path.resolve(REPO_ROOT, '..') };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--json') opts.json = true;
        else if (argv[i] === '--no-siblings') opts.siblings = false;
        else if (argv[i] === '--siblings') { opts.siblingsRoot = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--help' || argv[i] === '-h') opts.help = true;
    }
    return opts;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        return;
    }
    const report = analyse(opts);
    if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
    }
    const s = report.summary;
    console.log(`src/*.js tracked:                    ${s.sourceFiles}`);
    console.log(`runtime entry points:                ${s.runtimeEntryPoints.join(', ')}`);
    console.log(`tooling entry points:                ${s.toolingEntryPoints}`);
    console.log(`test entry points:                   ${s.testEntryPoints}`);
    console.log(`declared dynamic edges:              ${s.dynamicEdgesDeclared}`);
    console.log(`reachable from indexer runtime:      ${s.reachableFromIndexerRuntime}`);
    console.log(`NOT reachable from indexer runtime:  ${s.notReachableFromIndexerRuntime}`);
    console.log(`test-only:                           ${s.testOnly}`);
    console.log(`unreferenced across the platform:    ${s.unreferencedAcrossPlatform}`);
    console.log('');
    if (!report.candidates.length) return;
    console.log('files no runtime path in this repo reaches, and what else holds them:');
    for (const rel of report.candidates) {
        const f = report.files[rel];
        const holds = [];
        if (f.reachableFromTooling) holds.push('bin/scripts');
        if (f.reachableFromTests) holds.push('tests');
        if (f.referencedBySiblings.length) {
            holds.push(`siblings x${f.referencedBySiblings.length} (${f.siblingLoadCount} load)`);
        }
        if (f.twinCopies.length) {
            holds.push(`twin in ${f.twinCopies.map((t) => t.path.split('/')[0]).join('+')}`);
        }
        if (f.requiredByInRepo.length) holds.push(`required by ${f.requiredByInRepo.join(', ')}`);
        console.log(`  ${rel.padEnd(48)} ${holds.length ? holds.join(', ') : 'NOTHING: unreferenced across the platform'}`);
    }
}

if (require.main === module) main();

module.exports = { analyse, closure, runtimeEntries, resolveRequire, DYNAMIC_EDGES };
