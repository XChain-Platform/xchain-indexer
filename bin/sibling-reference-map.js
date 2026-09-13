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
 * Every indexer `src/` path that a sibling repo names, and who names it.
 *
 * WHY THIS EXISTS. Moving or renaming a file under src/ is a cross-repo edit
 * whenever another service reaches into this checkout for it, and several do:
 * sibling suites require indexer modules by relative path, build DDL paths by
 * hand, and quote module paths inside assertions. A grep run by hand finds the
 * requires and misses the string literals, so the restructure needs ONE
 * mechanical sweep whose output can be diffed before and after a move. A path
 * that leaves this map without a matching edit in the referring repo is a
 * broken sibling, and that break surfaces at the referrer's next CI run rather
 * than at the commit that caused it.
 *
 * WHAT COUNTS AS A REFERENCE. Two shapes, because a rename tool has to find
 * both:
 *
 *   text   any literal run of `xchain-indexer/src/<path>` in any text file:
 *          a relative require, a comment, a shell script, a markdown runbook.
 *   join   a path built segment by segment, the shape
 *          path.join(root, 'xchain-indexer', 'src', 'foo.js'). When every
 *          segment after `src` is a literal the path is resolved; when one is
 *          a variable the site is reported under `dynamicReferences` instead,
 *          because a rename must be checked there by a human.
 *
 * SCOPE. Sibling repos are the `xchain-*` directories beside this checkout
 * (`--siblings <dir>` overrides the search root). The platform's own `claude/`
 * tooling also hardcodes indexer paths; those are tracked by the restructure
 * spec's cross-repo section, not here, because they are not a shipped service.
 *
 * USAGE
 *   node bin/sibling-reference-map.js            human summary
 *   node bin/sibling-reference-map.js --json     the full map on stdout
 *   node bin/sibling-reference-map.js --siblings /path/to/platform
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const REPO_NAME = 'xchain-indexer';

// Directories that hold no first-party source and would otherwise dominate the
// sweep: an installed dependency tree can carry a vendored copy of this repo.
const SKIP_DIRS = new Set([
    'node_modules', '.git', '.nyc_output', 'coverage', 'dist', 'build', '.cache', '.venv',
]);

// Binary payloads a text scan would only produce noise from. Everything else is
// read as utf8, because a reference can live in a shell script, a Dockerfile, a
// YAML workflow or a markdown runbook just as easily as in a .js file.
const SKIP_EXT = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.pdf', '.zip', '.gz', '.tgz',
    '.bz2', '.xz', '.wasm', '.node', '.so', '.dylib', '.dll', '.woff', '.woff2', '.ttf',
    '.eot', '.mp4', '.mov', '.class', '.jar',
]);

// A file larger than this is a data dump, not code that requires a module.
const MAX_FILE_BYTES = 4 * 1024 * 1024;

// `xchain-indexer/src/<path>`, however it was spelled: a relative require
// (`../../xchain-indexer/src/utility.js`), a prose mention, a shell path.
const TEXT_REFERENCE = /xchain-indexer\/(src\/[A-Za-z0-9_@.\-/]+)/g;

// path.join(..., 'xchain-indexer', 'src', ...): the tail is captured raw and
// parsed for literal segments afterwards.
const JOIN_REFERENCE = /['"`]xchain-indexer['"`]\s*,\s*['"`]src['"`]\s*,([^)\]]*)/g;

// A captured path stops at the first character that cannot be part of one. The
// text regex is deliberately greedy over dots and slashes so `foo.js` survives,
// which means a sentence-ending period or a closing quote can ride along.
function trimPath(raw) {
    let out = raw;
    while (out.length && '.,;:)\'"`]}>*'.includes(out[out.length - 1])) out = out.slice(0, -1);
    return out;
}

/**
 * The path as it exists in the tree, or null when nothing resolves. A require
 * may omit the extension (`require('.../hub_db_sync')`) and may name a
 * directory, so both are tried before the reference is called unresolvable.
 */
function resolveInRepo(rel) {
    const candidates = [rel, `${rel}.js`, path.posix.join(rel, 'index.js')];
    for (const c of candidates) {
        const abs = path.join(REPO_ROOT, c);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return c;
    }
    return null;
}

/** Every literal segment of a path.join tail, or null when one is an expression. */
function literalJoinTail(rawTail) {
    const segments = [];
    // The call's own closing bracket ends the argument list; anything past it
    // belongs to the enclosing expression and is not a path segment.
    const stop = rawTail.search(/[)\]]/);
    const tail = stop === -1 ? rawTail : rawTail.slice(0, stop);
    // Consume `'a', 'b', ...` until the tail stops being literal segments.
    const re = /\s*(?:(['"`])([^'"`]*)\1|([^,]+))\s*(,|$)/g;
    let m;
    while ((m = re.exec(tail)) !== null) {
        if (m[3] !== undefined) {
            const token = m[3].trim();
            if (token === '') break;
            return null;
        }
        segments.push(m[2]);
        if (m[4] !== ',') break;
    }
    return segments.length ? segments.join('/') : null;
}

/** Byte offset to 1-based line number, for a file already in memory. */
function lineAt(text, index) {
    let line = 1;
    for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
    return line;
}

/** The whole source line a match sits on, which tells a load from a mention. */
function lineTextAt(text, index) {
    const start = text.lastIndexOf('\n', index) + 1;
    const end = text.indexOf('\n', index);
    return text.slice(start, end === -1 ? text.length : end);
}

/**
 * A load or a mention. A load breaks the referring repo the moment the path
 * moves; a mention only misleads the next reader, so the two carry different
 * urgency and the map has to separate them.
 */
function referenceKind(line) {
    return /\brequire\s*\(|\bimport\s*\(|\bfrom\s+['"`]/.test(line) ? 'require' : 'text';
}

function walkFiles(dir, out) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return out;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        // A symlinked directory inside a repo points at another checkout that
        // this sweep visits under its own name (xchain-e2e-test/xchain-hub is
        // ../xchain-hub), so following it would count every hit twice. The
        // sibling roots themselves may still be symlinks: readdir resolves
        // those, and this walk starts below them.
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            walkFiles(full, out);
            continue;
        }
        if (!entry.isFile()) continue;
        if (SKIP_EXT.has(path.extname(entry.name).toLowerCase())) continue;
        out.push(full);
    }
    return out;
}

/**
 * The sibling repos to sweep: `xchain-*` directories beside this checkout,
 * minus this checkout itself, sorted so the output is stable.
 */
function siblingRepos(root) {
    const self = fs.realpathSync(REPO_ROOT);
    const names = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.name.startsWith('xchain-')) continue;
        // By name as well as by real path: a lane worktree resolves somewhere
        // else entirely, so a sweep aimed at the platform root would otherwise
        // count the indexer's own checkout as one of its siblings.
        if (entry.name === REPO_NAME) continue;
        const full = path.join(root, entry.name);
        let real;
        try { real = fs.realpathSync(full); } catch (e) { continue; }
        if (real === self) continue;
        if (!fs.statSync(full).isDirectory()) continue;
        names.push(entry.name);
    }
    return names.sort();
}

/**
 * The map itself.
 * @returns {{siblingRepos: string[], paths: object, dynamicReferences: object[],
 *            distinctPathCount: number, referenceCount: number}}
 */
function buildReferenceMap(root) {
    const repos = siblingRepos(root);
    const paths = new Map();
    const dynamic = [];

    const record = (rel, ref) => {
        const key = resolveInRepo(rel) || rel;
        if (!paths.has(key)) paths.set(key, { exists: resolveInRepo(rel) !== null, referrers: [] });
        paths.get(key).referrers.push(ref);
    };

    for (const repo of repos) {
        const repoRoot = path.join(root, repo);
        for (const file of walkFiles(repoRoot, [])) {
            let stat;
            try { stat = fs.statSync(file); } catch (e) { continue; }
            if (stat.size > MAX_FILE_BYTES) continue;
            let text;
            try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
            if (!text.includes(REPO_NAME)) continue;
            const rel = `${repo}/${path.relative(repoRoot, file)}`;

            TEXT_REFERENCE.lastIndex = 0;
            let m;
            while ((m = TEXT_REFERENCE.exec(text)) !== null) {
                const captured = trimPath(m[1]);
                if (captured === 'src' || captured === 'src/') continue;
                record(captured, {
                    repo,
                    file: rel,
                    line: lineAt(text, m.index),
                    kind: referenceKind(lineTextAt(text, m.index)),
                    raw: captured,
                });
            }

            JOIN_REFERENCE.lastIndex = 0;
            while ((m = JOIN_REFERENCE.exec(text)) !== null) {
                const tail = literalJoinTail(m[1]);
                const line = lineAt(text, m.index);
                if (tail === null) {
                    dynamic.push({ repo, file: rel, line, expression: m[1].trim().slice(0, 120) });
                    continue;
                }
                record(`src/${tail}`, { repo, file: rel, line, kind: 'join', raw: `src/${tail}` });
            }
        }
    }

    const sortedPaths = {};
    let referenceCount = 0;
    const byKind = { require: 0, join: 0, text: 0 };
    for (const key of Array.from(paths.keys()).sort()) {
        const entry = paths.get(key);
        entry.referrers.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
        referenceCount += entry.referrers.length;
        for (const ref of entry.referrers) byKind[ref.kind] += 1;
        sortedPaths[key] = {
            exists: entry.exists,
            referenceCount: entry.referrers.length,
            referringRepos: Array.from(new Set(entry.referrers.map((r) => r.repo))).sort(),
            referrers: entry.referrers,
        };
    }
    dynamic.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));

    return {
        siblingRepos: repos,
        distinctPathCount: Object.keys(sortedPaths).length,
        // The subset that resolves to a file in the tree. The rest are
        // directory prefixes (`src/sql/`) and stale paths, which still matter
        // on a move but are not files anyone can repoint one-for-one.
        existingPathCount: Object.values(sortedPaths).filter((p) => p.exists).length,
        referenceCount,
        referenceCountByKind: byKind,
        dynamicReferenceCount: dynamic.length,
        paths: sortedPaths,
        dynamicReferences: dynamic,
    };
}

function parseArgs(argv) {
    const opts = { json: false, siblings: path.resolve(REPO_ROOT, '..') };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--json') opts.json = true;
        else if (argv[i] === '--siblings') { opts.siblings = path.resolve(argv[i + 1]); i += 1; }
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
    const map = buildReferenceMap(opts.siblings);
    if (opts.json) {
        console.log(JSON.stringify(map, null, 2));
        return;
    }
    console.log(`sibling repos swept: ${map.siblingRepos.length} (${map.siblingRepos.join(', ')})`);
    console.log(`distinct indexer src/ paths referenced: ${map.distinctPathCount} `
        + `(${map.existingPathCount} resolve to a file in the tree)`);
    console.log(`total reference sites: ${map.referenceCount} `
        + `(require ${map.referenceCountByKind.require}, `
        + `join ${map.referenceCountByKind.join}, mention ${map.referenceCountByKind.text})`);
    console.log(`unresolvable path references: ${Object.values(map.paths).filter((p) => !p.exists).length}`);
    console.log(`dynamic joined references (a human checks these on a rename): ${map.dynamicReferenceCount}`);
    console.log('');
    const perRepo = {};
    for (const entry of Object.values(map.paths)) {
        for (const ref of entry.referrers) perRepo[ref.repo] = (perRepo[ref.repo] || 0) + 1;
    }
    console.log('reference sites per repo:');
    for (const repo of Object.keys(perRepo).sort()) console.log(`  ${repo.padEnd(24)} ${perRepo[repo]}`);
}

if (require.main === module) main();

module.exports = { buildReferenceMap, siblingRepos, resolveInRepo, literalJoinTail, trimPath };
