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
 * WHAT COUNTS AS A REFERENCE. Six shapes, reported as each site's `form`,
 * because a rename tool has to find every one of them:
 *
 *   text       any literal run of `xchain-indexer/src/<path>` in any text file:
 *              a relative require, a comment, a shell script, a markdown runbook.
 *   join       a path built segment by segment, the shape
 *              path.join(root, 'xchain-indexer', 'src', 'foo.js'). When every
 *              segment after `src` is a literal the path is resolved; when one is
 *              a variable the site is reported under `dynamicReferences` instead,
 *              because a rename must be checked there by a human.
 *   root-var   the checkout held in a variable and the file joined onto it:
 *              `const R = path.resolve(__dirname, '../../xchain-indexer')` then
 *              path.join(R, 'src', 'foo.js'), path.join(R, 'src/foo.js') or
 *              `${R}/src/foo.js`. The root may equally be
 *              process.env.XCHAIN_INDEXER_PATH, a candidate array filtered to its
 *              first live entry, or a variable that points at `<root>/src`.
 *   helper     a closure that takes a repo-relative path and returns a file in
 *              this checkout, `indexerFile('src/rollback.js')`. A call over a
 *              literal array, `indexerFile('src/' + twin)`, is emitted once per
 *              element of that array.
 *   shell-var  the same root-in-a-variable idea in bash, `"$VAR/src/foo.js"`.
 *   shell-arg  the repo name passed as its own word with the path beside it,
 *              `copy_twin xchain-indexer "src/$f"`, resolved against the literal
 *              `for f in ...` list above it. The twin-copier script in the
 *              platform's tooling directories, reconcile-twins.sh, is built
 *              entirely out of this one and is wired into no CI.
 *
 * AND ONE THAT IS NEVER A PATH. src/consensus_rules_digest.js loads its shared
 * gate carriers with `require('./' + mod + '.js')` over a literal list, so no
 * string names the file and a missed move reports the gate ABSENT instead of
 * throwing. Those sites are listed under `dynamicReferences` with the file list
 * they resolve to, form `computed-require`.
 *
 * SCOPE. Sibling repos are the `xchain-*` directories beside this checkout
 * (`--siblings <dir>` overrides the search root), listed in `siblingRepos`. That
 * default scope is everything this repo publishes and everything a pin carries.
 *
 * The surrounding tree may also hold platform tooling that is not a shipped
 * service and still reaches in just as hard: the twin-copier script
 * reconcile-twins.sh alone byte-copies about thirty of this repo's src/ files
 * outward and no CI job runs it, so a sweep that ignores those directories reads
 * safer than the tree is. Sweeping them is OPT-IN, because their paths belong to
 * the tree around this checkout rather than to this repo: pass
 * --include-platform-tooling and name the directories, relative to the siblings
 * root and comma-separated, in SIBLING_MAP_EXTRA_DIRS. Their hits land under the
 * referrer label `platform-tooling` and the directories swept are echoed in
 * `platformToolingSwept`, so a map that used them says so. With the flag off,
 * `platformToolingSwept` is empty and only the `xchain-*` siblings are swept.
 *
 * USAGE
 *   node bin/sibling-reference-map.js            human summary
 *   node bin/sibling-reference-map.js --json     the full map on stdout
 *   node bin/sibling-reference-map.js --siblings /path/to/platform
 *   node bin/sibling-reference-map.js --pin bin/pins/at1-sibling-reference-map.json \
 *        --base-sha <sha> --note "<what tree this saw>"
 *   SIBLING_MAP_EXTRA_DIRS=<dir>,<dir> node bin/sibling-reference-map.js \
 *        --include-platform-tooling --json
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

// Platform tooling that hardcodes indexer paths without being a shipped service.
// It is swept under one label rather than added to the sibling list, so the
// `siblingRepos` array means exactly the `xchain-*` set and nothing else. The
// directories are named by the caller, not by this file: they are paths in the
// tree AROUND this checkout, and a repo carries no inventory of its surroundings.
const PLATFORM_TOOLING_LABEL = 'platform-tooling';
const PLATFORM_TOOLING_ENV  = 'SIBLING_MAP_EXTRA_DIRS';

/**
 * The tooling directories to sweep, relative to the siblings root, from
 * SIBLING_MAP_EXTRA_DIRS (comma-separated). Empty when the caller named none,
 * which is what turns the opt-in sweep into a no-op rather than a guess.
 *
 * @returns {string[]}
 */
function platformToolingDirs(env = process.env) {
    return String(env[PLATFORM_TOOLING_ENV] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

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
        // A backticked segment holding `${...}` is a template, not a literal:
        // path.join(INDEXER, 'coins', `${c}.js`) names three coins, and reading
        // it as one file called "${c}.js" records a path nobody can repoint.
        if (m[1] === '`' && m[2].includes('${')) return null;
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

// ---------------------------------------------------------------------------
// THE INDIRECT IDIOMS
//
// The two matchers above only see a path someone spelled out in one piece. The
// shape the sibling suites actually use keeps the checkout in a variable and
// joins the file onto it, so the repo name and the file name never share a
// string and a text sweep leaves no trace of the reference at all. That blind
// spot was measured on 2026-09-13: about 29 test and tool files across five
// sibling repos plus a bash script covering thirty more, none of them visible
// to the original map, all of them broken the moment a src/ file moves.
//
// Everything below reconstructs the literal file list such a site resolves to.
// A tail that is not literal goes to `dynamicReferences` rather than being
// guessed, because a rename cannot be checked against a guess.
// ---------------------------------------------------------------------------

// Environment variables that hold a checkout of this repo. XCHAIN_INDEXER_SQL_PATH
// is deliberately absent: it points below src/ and every caller walks back up
// from it, so the declaration that reads it also carries the literal fallback
// this list would otherwise have to guess at.
const ENV_ROOT_VARS = ['XCHAIN_INDEXER_PATH', 'XCHAIN_INDEXER_DIR'];

/** True when an identifier is the node path module under some alias. */
function isPathAlias(name) { return /path/i.test(name); }

/**
 * The repo-relative directory an expression points at: `''` for the checkout
 * itself, `'src'`, `'src/sql'`, and so on, or null when the expression is not a
 * directory in this repo at all (it names a FILE, which the text matcher already
 * owns, or it names some other repo).
 *
 * The prefix has to be the whole path rather than a two-valued repo/src flag:
 * xchain-explorer pins `path.join(..., 'xchain-indexer', 'src', 'sql')` and then
 * joins bare table names onto it, so a flag that could only say "src" recorded
 * src/blocks.sql for a file that lives at src/sql/blocks.sql.
 */
function rootPrefix(init) {
    let prefix = null;
    const named = /[A-Za-z0-9_@.\-]+/;
    const re = /xchain-indexer((?:\/[A-Za-z0-9_@.\-]+)*)/g;
    let m;
    while ((m = re.exec(init)) !== null) {
        const segments = (m[1] || '').split('/').filter(Boolean);
        // Separately quoted segments spell the same directory:
        // path.join(base, 'xchain-indexer', 'src', 'sql').
        let rest = init.slice(re.lastIndex);
        let more = /^['"`]\s*,\s*['"`]([A-Za-z0-9_@.\-]+)['"`]/.exec(rest);
        while (more) {
            segments.push(more[1]);
            rest = rest.slice(more[0].length - 1);
            more = /^['"`]\s*,\s*['"`]([A-Za-z0-9_@.\-]+)['"`]/.exec(rest);
        }
        if (segments.some((s) => !named.test(s) || /\.[A-Za-z0-9]+$/.test(s))) return null;
        prefix = segments.join('/');
    }
    if (prefix !== null) return prefix;
    for (const env of ENV_ROOT_VARS) if (init.includes(`process.env.${env}`)) return '';
    return null;
}

/** The `{ ... }` starting at openIndex, brace-counted, capped so a stray brace cannot run away. */
function bodySlice(text, openIndex, limit) {
    let depth = 0;
    const end = Math.min(text.length, openIndex + limit);
    for (let i = openIndex; i < end; i += 1) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') { depth -= 1; if (depth === 0) return text.slice(openIndex, i + 1); }
    }
    return text.slice(openIndex, end);
}

/** The text between the parentheses opening at openIndex, paren-counted. */
function callArg(text, openIndex, limit) {
    let depth = 0;
    const end = Math.min(text.length, openIndex + limit);
    for (let i = openIndex; i < end; i += 1) {
        if (text[i] === '(') depth += 1;
        else if (text[i] === ')') { depth -= 1; if (depth === 0) return text.slice(openIndex + 1, i); }
    }
    return null;
}

/**
 * A root variable derived from one already known: the candidate list filtered
 * to its first live entry, the `.find()` over that list, a plain alias, or a
 * join that walks the root down to its `src/` directory. Anything else that
 * merely mentions a root (an `existsSync` probe, a file path built from it) is
 * not itself a root and must not become one, or every boolean in the file turns
 * into a phantom reference site.
 */
function inheritedPrefix(init, roots) {
    for (const [name, prefix] of roots) {
        if (!new RegExp(`\\b${name}\\b`).test(init)) continue;
        if (new RegExp(`^\\s*${name}\\s*$`).test(init)) return prefix;
        if (new RegExp(`\\b${name}\\s*(?:\\.\\s*(?:find|filter)\\s*\\(|\\[\\s*0\\s*\\])`).test(init)) return prefix;
        const join = new RegExp(`([A-Za-z_$][\\w$]*)\\s*\\.\\s*(?:join|resolve)\\s*\\(\\s*${name}\\s*,([^)]*)\\)`).exec(init);
        if (join && isPathAlias(join[1])) {
            const tail = literalJoinTail(join[2]);
            // Walking the root down to another directory gives another root; a
            // tail whose last segment has an extension names a file, and a file
            // is a reference, not a root to hang more references off.
            if (tail === null || /\.[A-Za-z0-9]+$/.test(tail)) continue;
            return [prefix, tail.replace(/\/$/, '')].filter(Boolean).join('/');
        }
        if (/^\s*\[/.test(init)) return prefix;
    }
    return null;
}

/**
 * Functions that RETURN a root, the `resolveIndexerRoot()` shape. Without these
 * the variable holding their result is invisible and every join onto it is lost.
 */
function collectRootProducers(text) {
    const producers = new Map();
    const re = /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const body = bodySlice(text, m.index + m[0].length - 1, 3000);
        // A BARE identifier, not an expression. `return path.resolve(root, rel)`
        // hands back one file; treating its caller as a root made every
        // `const p = indexerFile('src/x.js')` look like another checkout.
        if (!/\breturn\s+[A-Za-z_$][\w$]*\s*;/.test(body)) continue;
        const prefix = rootPrefix(body);
        if (prefix !== null) producers.set(m[1], prefix);
    }
    return producers;
}

/**
 * Every variable in a file that holds this checkout's root (or its src/
 * directory). The scan repeats until it stops learning names, because a root is
 * routinely derived from another one two or three steps away.
 */
function collectRootVars(text) {
    const roots = new Map();
    const producers = collectRootProducers(text);
    const declare = (name, prefix) => {
        if (!name || prefix === null || prefix === undefined || roots.has(name)) return false;
        roots.set(name, prefix);
        return true;
    };
    const classify = (init) => {
        const direct = rootPrefix(init);
        if (direct !== null) return direct;
        const derived = inheritedPrefix(init, roots);
        if (derived !== null) return derived;
        const call = /^\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(init);
        return call && producers.has(call[1]) ? producers.get(call[1]) : null;
    };
    for (let pass = 0; pass < 4; pass += 1) {
        let learned = false;
        let m;
        const decl = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]{0,400}?);/g;
        while ((m = decl.exec(text)) !== null) {
            if (declare(m[1], classify(m[2]))) learned = true;
        }
        const forOf = /for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+([^)\n]{0,200})\)/g;
        while ((m = forOf.exec(text)) !== null) {
            if (declare(m[1], classify(m[2]))) learned = true;
        }
        const cb = /\b([A-Za-z_$][\w$]*)\s*\.\s*(?:find|filter|map|forEach|some|every)\s*\(\s*(?:async\s+)?\(?\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
        while ((m = cb.exec(text)) !== null) {
            if (roots.has(m[1]) && declare(m[2], roots.get(m[1]))) learned = true;
        }
        if (!learned) break;
    }
    return roots;
}

/** A repo-relative path is only ours when it lands under src/ and walks nowhere. */
function underSrc(rel) {
    return /^src\/[^\s]+$/.test(rel) && !rel.split('/').includes('..');
}

/**
 * The literal path or paths a `path.join(<root>, ...)` tail resolves to. A tail
 * whose last segment is a loop variable over a literal array resolves to one
 * path per element: the explorer's hub-mirror guard and the xchain-sync twin
 * loop are both written that way, and a move has to repoint every element, so
 * collapsing them to a single "dynamic, ask a human" line would hide the bulk
 * of the blast radius behind one note.
 */
function resolveJoinTail(rawTail, lists, index) {
    const literal = literalJoinTail(rawTail);
    if (literal !== null) return [literal];
    const stop = rawTail.search(/[)\]]/);
    const segments = splitTopLevel(stop === -1 ? rawTail : rawTail.slice(0, stop)).map((s) => s.trim());
    if (!segments.length) return null;
    const last = segments.pop();
    // Either the bare loop variable, or a template built around it:
    // path.join(INDEXER, 'coins', `${c}.js`) over ['BTC', 'LTC', 'DOGE'].
    let ident = /^[A-Za-z_$][\w$]*$/.test(last) ? last : null;
    let pre = '';
    let post = '';
    if (!ident) {
        const tpl = /^`([^`$]*)\$\{\s*([A-Za-z_$][\w$]*)\s*\}([^`$]*)`$/.exec(last);
        if (!tpl) return null;
        pre = tpl[1];
        ident = tpl[2];
        post = tpl[3];
    }
    const prefix = [];
    for (const segment of segments) {
        const lit = /^(['"`])([^'"`]*)\1$/.exec(segment);
        if (!lit) return null;
        prefix.push(lit[2]);
    }
    const items = nearestList(lists, ident, index);
    if (!items) return null;
    return items.map((item) => prefix.concat(pre + item + post).join('/'));
}

/** The repo-relative path a tail names when joined onto a root at `prefix`. */
function relFromTail(prefix, tail) {
    return prefix ? `${prefix}/${tail}` : tail;
}

/**
 * Every indexer src/ path a root variable is joined with, in all three
 * spellings the tree uses: path.join(R, 'src', 'x.js'), path.join(R, 'src/x.js')
 * and `${R}/src/x.js`.
 */
function rootVarReferences(text, roots, lists, skipRanges) {
    const found = [];
    const dynamic = [];
    // A helper closure joins its own parameter onto the root; that site is the
    // helper's definition, and every call of it is already reported through the
    // helper channel. Reporting it again as an unresolvable join would put a
    // phantom "ask a human" line beside every one of them.
    const suppressed = (index) => (skipRanges || []).some((r) => index >= r.start && index < r.end);
    for (const [name, suffix] of roots) {
        let m;
        const joined = new RegExp(`([A-Za-z_$][\\w$]*)\\s*\\.\\s*(?:join|resolve)\\s*\\(\\s*${name}\\s*,([^)]*)\\)`, 'g');
        while ((m = joined.exec(text)) !== null) {
            if (!isPathAlias(m[1])) continue;
            const tails = resolveJoinTail(m[2], lists || [], m.index);
            if (tails === null) {
                if (!suppressed(m.index)) {
                    dynamic.push({ index: m.index, form: 'root-var', root: name, expression: m[0].trim().slice(0, 120) });
                }
                continue;
            }
            for (const tail of tails) {
                const rel = trimPath(relFromTail(suffix, tail));
                if (underSrc(rel)) found.push({ index: m.index, path: rel, form: 'root-var', root: name });
            }
        }
        const templated = new RegExp(`\\$\\{\\s*${name}\\s*\\}/([A-Za-z0-9_@.\\-/]+)`, 'g');
        while ((m = templated.exec(text)) !== null) {
            const rel = trimPath(relFromTail(suffix, m[1]));
            if (underSrc(rel)) found.push({ index: m.index, path: rel, form: 'root-var', root: name });
        }
        const concat = new RegExp(`\\b${name}\\s*\\+\\s*['"\`]/?([A-Za-z0-9_@.\\-/]+)`, 'g');
        while ((m = concat.exec(text)) !== null) {
            const rel = trimPath(relFromTail(suffix, m[1]));
            if (underSrc(rel)) found.push({ index: m.index, path: rel, form: 'root-var', root: name });
        }
    }
    return { found, dynamic };
}

/**
 * Closures that take a repo-relative path and hand back a file inside this
 * checkout, the `indexerFile('src/rollback.js')` idiom. Recognised by a body
 * that joins its own first parameter onto an indexer root, which is narrow
 * enough to leave the sibling-presence guards beside them alone.
 */
function collectHelpers(text, roots, outRanges) {
    const helpers = new Map();
    const re = /(?:function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*)?\(([^)]*)\)\s*(?:=>)?)\s*\{/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const name = m[1] || m[3];
        const param = (m[2] || m[4] || '').split(',')[0].trim().replace(/[^\w$].*$/, '');
        if (!name || !param) continue;
        const open = m.index + m[0].length - 1;
        const body = bodySlice(text, open, 2000);
        const call = new RegExp(`([A-Za-z_$][\\w$]*)\\s*\\.\\s*(?:join|resolve)\\s*\\(\\s*([A-Za-z_$][\\w$]*)[^)]*\\b${param}\\b`).exec(body);
        if (!call || !isPathAlias(call[1])) continue;
        const prefix = roots.has(call[2]) ? roots.get(call[2]) : rootPrefix(body);
        if (prefix === null) continue;
        helpers.set(name, prefix);
        if (outRanges) outRanges.push({ start: open, end: open + body.length });
    }
    return helpers;
}

/**
 * The literal string elements of `const NAME = [ ... ]`. When `tupleIndex` is
 * given the array holds rows rather than names (SHARED_GATES is
 * `[[module, [constants]], ...]`) and that column is taken from each row.
 */
function arrayLiteralItems(source, name, tupleIndex) {
    // A real list is commented row by row (SHARED_GATES explains why each gate is
    // there). Leaving the comments in makes the row after one fail to parse as a
    // literal, which silently truncates the list and under-reports the move.
    const text = stripComments(source);
    const decl = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\[`).exec(text);
    if (!decl) return null;
    const body = balancedArrayBody(text, text.indexOf('[', decl.index));
    return body === null ? null : itemsFromArrayBody(body, tupleIndex);
}

/** The contents of the `[ ... ]` opening at openIndex, brackets balanced and strings respected. */
function balancedArrayBody(text, openIndex) {
    let depth = 0;
    let quote = null;
    for (let i = openIndex; i < text.length; i += 1) {
        const c = text[i];
        if (quote) { if (c === quote && text[i - 1] !== '\\') quote = null; continue; }
        if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
        if (c === '[') depth += 1;
        else if (c === ']') { depth -= 1; if (depth === 0) return text.slice(openIndex + 1, i); }
    }
    return null;
}

/**
 * The literal strings in an array body. `tupleIndex` reads one column out of an
 * array of rows, which is how both SHARED_GATES and the post-move xchain-sync
 * twin loop are written: `[['merkle.js', 'src/consensus/merkle.js'], ...]`.
 */
function itemsFromArrayBody(body, tupleIndex) {
    const rows = splitTopLevel(stripComments(body));
    const items = [];
    for (const row of rows) {
        const cell = tupleIndex === undefined
            ? row
            : (splitTopLevel(row.replace(/^\s*\[/, '').replace(/\]\s*$/, ''))[tupleIndex] || '');
        const lit = /^\s*(['"`])([^'"`]*)\1\s*$/.exec(cell);
        if (lit) items.push(lit[2]);
    }
    return items.length ? items : null;
}

/**
 * The same text with javascript comments blanked to spaces, byte offsets and
 * line numbers preserved so a match found here still points at the real line.
 * Quote state is tracked, so a `//` inside a string literal survives.
 */
function stripComments(text) {
    let out = '';
    let quote = null;
    for (let i = 0; i < text.length; i += 1) {
        const c = text[i];
        if (quote) {
            out += c;
            if (c === '\\') { out += text[i + 1] || ''; i += 1; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') { quote = c; out += c; continue; }
        if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') { out += ' '; i += 1; }
            out += '\n';
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            const stop = end === -1 ? text.length : end + 2;
            for (let j = i; j < stop; j += 1) out += text[j] === '\n' ? '\n' : ' ';
            i = stop - 1;
            continue;
        }
        out += c;
    }
    return out;
}

/** Split on commas that are not inside brackets, braces, parens or a string. */
function splitTopLevel(body) {
    const out = [];
    let depth = 0;
    let quote = null;
    let start = 0;
    for (let i = 0; i < body.length; i += 1) {
        const c = body[i];
        if (quote) { if (c === quote && body[i - 1] !== '\\') quote = null; continue; }
        if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
        if ('[{('.includes(c)) depth += 1;
        else if (']})'.includes(c)) depth -= 1;
        else if (c === ',' && depth === 0) { out.push(body.slice(start, i)); start = i + 1; }
    }
    out.push(body.slice(start));
    return out.filter((s) => s.trim() !== '');
}

/**
 * Every loop in a file whose variable ranges over a literal list, javascript and
 * bash alike, with the byte offset of the loop header so a use site can bind to
 * the nearest one above it rather than to every list in the file.
 */
function collectLoopLists(text) {
    const lists = [];
    let m;
    // Where a loop variable stops meaning anything. Without this a use site
    // binds to the nearest list ABOVE it wherever that list happens to be, so a
    // `for (const f of SQL_FILES)` reading a directory would be attributed to
    // some earlier literal `f` loop and the map would invent files nobody names.
    const scopeEnd = (from) => {
        const brace = text.indexOf('{', from);
        if (brace !== -1 && brace - from <= 200) return brace + bodySlice(text, brace, 200000).length;
        return Math.min(text.length, from + 300);
    };
    const push = (index, from, name, items) => {
        if (items && items.length) lists.push({ index, end: scopeEnd(from), name, items });
    };
    const inline = /for\s*\(\s*(?:const|let|var)\s+(?:\[([^\]]*)\]|([A-Za-z_$][\w$]*))\s+of\s+\[/g;
    while ((m = inline.exec(text)) !== null) {
        const body = balancedArrayBody(text, inline.lastIndex - 1);
        if (body === null) continue;
        const after = inline.lastIndex + body.length + 1;
        if (m[1] !== undefined) {
            const cols = m[1].split(',').map((s) => s.trim());
            for (let col = 0; col < cols.length; col += 1) {
                if (!/^[A-Za-z_$][\w$]*$/.test(cols[col])) continue;
                push(m.index, after, cols[col], itemsFromArrayBody(body, col));
            }
        } else {
            push(m.index, after, m[2], itemsFromArrayBody(body));
        }
        inline.lastIndex = after;
    }
    const named = /for\s*\(\s*(?:const|let|var)\s+(?:\[([^\]]*)\]|([A-Za-z_$][\w$]*))\s+of\s+([A-Za-z_$][\w$]*)\s*\)/g;
    while ((m = named.exec(text)) !== null) {
        if (m[1] !== undefined) {
            const cols = m[1].split(',').map((s) => s.trim());
            for (let col = 0; col < cols.length; col += 1) {
                if (!/^[A-Za-z_$][\w$]*$/.test(cols[col])) continue;
                push(m.index, named.lastIndex, cols[col], arrayLiteralItems(text, m[3], col));
            }
            continue;
        }
        push(m.index, named.lastIndex, m[2], arrayLiteralItems(text, m[3]));
    }
    // NAMES.forEach(function(f){ ... }) is the same loop written as a callback,
    // and the explorer's twin guard reaches into this repo from inside one.
    const each = /\b([A-Za-z_$][\w$]*)\s*\.\s*(?:forEach|map)\s*\(\s*(?:async\s+)?(?:function\s*)?\(?\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
    while ((m = each.exec(text)) !== null) {
        push(m.index, each.lastIndex, m[2], arrayLiteralItems(text, m[1]));
    }
    // The list written where it is used: ['BTC', 'LTC', 'DOGE'].map((c) => ...).
    const eachInline = /\[/g;
    while ((m = eachInline.exec(text)) !== null) {
        const body = balancedArrayBody(text, m.index);
        if (body === null) continue;
        const after = m.index + body.length + 2;
        const call = /^\s*\.\s*(?:forEach|map)\s*\(\s*(?:async\s+)?(?:function\s*)?\(?\s*([A-Za-z_$][\w$]*)\s*[,)]/.exec(text.slice(after, after + 80));
        if (!call) continue;
        push(m.index, after + call[0].length, call[1], itemsFromArrayBody(body));
    }
    const shell = /\bfor\s+([A-Za-z_][\w]*)\s+in\s+([\s\S]{0,500}?)(?:;\s*|\n\s*)do\b/g;
    while ((m = shell.exec(text)) !== null) {
        const items = m[2].replace(/\\\s*\n/g, ' ').split(/\s+/)
            .filter((t) => t && /^[A-Za-z0-9_@.\-/]+$/.test(t));
        if (!items.length) continue;
        const done = text.indexOf('\ndone', shell.lastIndex);
        lists.push({
            index: m.index,
            end: done === -1 ? Math.min(text.length, shell.lastIndex + 600) : done,
            name: m[1],
            items,
        });
    }
    return lists;
}

/**
 * The list a loop variable ranges over at this offset: the innermost loop whose
 * body contains it, never a list from a scope that has already closed.
 */
function nearestList(lists, name, index) {
    let best = null;
    for (const entry of lists) {
        if (entry.name !== name || entry.index > index || index >= entry.end) continue;
        if (!best || entry.index > best.index) best = entry;
    }
    return best ? best.items : null;
}

/** Single-assignment string constants, so `const rel = 'src/x.js'` survives one hop. */
function collectStringConsts(text) {
    const seen = new Map();
    const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`\n]*)\2\s*;/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (seen.has(m[1]) && seen.get(m[1]) !== m[3]) seen.set(m[1], null);
        else if (!seen.has(m[1])) seen.set(m[1], m[3]);
    }
    return seen;
}

/**
 * Every call of a helper closure, resolved to the file or files it reads. A
 * `helper('src/' + twin)` over a literal array is emitted once per element,
 * because that is exactly the set a move has to repoint; a tail nothing names
 * goes to the dynamic channel instead.
 */
function helperReferences(text, helpers, lists, strings) {
    const found = [];
    const dynamic = [];
    const push = (index, rel, helper) => {
        const clean = trimPath(rel);
        if (underSrc(clean)) found.push({ index, path: clean, form: 'helper', helper });
    };
    for (const [name, suffix] of helpers) {
        const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
        let m;
        while ((m = re.exec(text)) !== null) {
            // `function indexerFile(rel){` reads as a call of itself. Its
            // parameter is not a path, and counting it would put one phantom
            // "ask a human" line under every helper in the platform.
            if (/\bfunction\s+$/.test(text.slice(Math.max(0, m.index - 24), m.index))) continue;
            const arg = callArg(text, m.index + m[0].length - 1, 400);
            if (arg === null) continue;
            const expr = arg.trim();
            const literal = /^(['"`])([^'"`]*)\1$/.exec(expr);
            if (literal) { push(m.index, relFromTail(suffix, literal[2]), name); continue; }
            const prefixed = /^(['"`])([^'"`]*)\1\s*\+\s*([A-Za-z_$][\w$]*)$/.exec(expr);
            if (prefixed) {
                const items = nearestList(lists, prefixed[3], m.index);
                if (items) {
                    for (const item of items) push(m.index, relFromTail(suffix, prefixed[2] + item), name);
                } else {
                    dynamic.push({ index: m.index, form: 'helper', helper: name, expression: expr.slice(0, 120) });
                }
                continue;
            }
            const ident = /^[A-Za-z_$][\w$]*$/.exec(expr);
            if (ident) {
                // A loop variable first: the post-move twin loops pass the whole
                // indexer-side path per row rather than deriving it from a
                // basename, so the literal list IS the reference set.
                const items = nearestList(lists, expr, m.index);
                if (items) {
                    for (const item of items) push(m.index, relFromTail(suffix, item), name);
                    continue;
                }
                const value = strings.get(expr);
                if (value) push(m.index, relFromTail(suffix, value), name);
                else dynamic.push({ index: m.index, form: 'helper', helper: name, expression: expr.slice(0, 120) });
                continue;
            }
            const joined = /^([A-Za-z_$][\w$]*)\s*\.\s*(?:join|resolve)\s*\(([\s\S]*)\)$/.exec(expr);
            if (joined && isPathAlias(joined[1])) {
                const tails = resolveJoinTail(joined[2], lists, m.index);
                if (tails !== null) {
                    for (const tail of tails) push(m.index, relFromTail(suffix, tail), name);
                    continue;
                }
            }
            dynamic.push({ index: m.index, form: 'helper', helper: name, expression: expr.slice(0, 120) });
        }
    }
    return { found, dynamic };
}

/**
 * The bash side of the same blind spot. Two shapes, both in the platform's
 * twin-copier script reconcile-twins.sh: a variable holding the checkout and then
 * "$VAR/src/<file>", and the repo name passed as its own word followed by the
 * relative path, `copy_twin xchain-indexer "src/$f"`, where the file comes from
 * a literal `for f in ...` list. That script is wired into no CI at all, so a
 * move it does not follow fails silently at the next hand run.
 */
function shellReferences(text, lists) {
    const found = [];
    const dynamic = [];
    let m;
    const roots = new Map();
    const assign = /^[ \t]*(?:local\s+|export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(["']?)([^"'\n]*)\2/gm;
    while ((m = assign.exec(text)) !== null) {
        const prefix = rootPrefix(m[3]);
        if (prefix !== null && !roots.has(m[1])) roots.set(m[1], prefix);
    }
    for (const [name, suffix] of roots) {
        const use = new RegExp(`\\$\\{?${name}\\}?/([A-Za-z0-9_@.\\-/]+)`, 'g');
        while ((m = use.exec(text)) !== null) {
            const rel = trimPath(relFromTail(suffix, m[1]));
            if (underSrc(rel)) found.push({ index: m.index, path: rel, form: 'shell-var', root: name });
        }
    }
    const positional = /xchain-indexer[ \t]+["']?(src\/[^"'\s;)]+)/g;
    while ((m = positional.exec(text)) !== null) {
        const raw = m[1];
        const interpolated = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(raw);
        if (!interpolated) {
            const rel = trimPath(raw);
            if (underSrc(rel)) found.push({ index: m.index, path: rel, form: 'shell-arg' });
            continue;
        }
        const items = nearestList(lists, interpolated[1], m.index);
        if (!items) {
            dynamic.push({ index: m.index, form: 'shell-arg', expression: raw.slice(0, 120) });
            continue;
        }
        for (const item of items) {
            const rel = trimPath(raw.replace(interpolated[0], item));
            if (underSrc(rel)) found.push({ index: m.index, path: rel, form: 'shell-arg', loopVar: interpolated[1] });
        }
    }
    return { found, dynamic };
}

/**
 * `require('./' + mod + '.js')` over a literal list, which is how
 * src/consensus_rules_digest.js loads its seventeen shared gate carriers. No
 * string names the loaded file, so neither matcher above nor a grep can see the
 * edge, and the digest reports a gate it fails to load as ABSENT instead of
 * throwing: a move that misses one of these is silent all the way to a rules
 * mismatch on the fleet.
 */
function computedRequireSites(text, dirRel) {
    const lists = collectLoopLists(text);
    const out = [];
    const re = /require\s*\(\s*(['"`])(\.\.?\/[^'"`]*)\1\s*\+\s*([A-Za-z_$][\w$]*)\s*(?:\+\s*(['"`])([^'"`]*)\4)?/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const items = nearestList(lists, m[3], m.index) || [];
        const candidates = items
            .map((item) => path.posix.normalize(path.posix.join(dirRel, `${m[2]}${item}${m[5] || ''}`)))
            .filter((p) => p.startsWith('src/'));
        out.push({
            index: m.index,
            form: 'computed-require',
            expression: m[0].trim().slice(0, 120),
            listVariable: m[3],
            listCandidates: candidates,
        });
    }
    return out;
}

/**
 * The indirect idioms over one file's text, offsets only; the caller owns line
 * numbers and the repo-relative name. Kept as one entry point so a fixture
 * string can drive exactly what the sweep drives.
 */
function scanIndirectIdioms(text, opts) {
    const options = opts || {};
    const lists = collectLoopLists(text);
    const found = [];
    const dynamic = [];
    if (options.shell) {
        const shell = shellReferences(text, lists);
        found.push(...shell.found);
        dynamic.push(...shell.dynamic);
    } else {
        const roots = collectRootVars(text);
        const helperRanges = [];
        const helpers = collectHelpers(text, roots, helperRanges);
        const rootHits = rootVarReferences(text, roots, lists, helperRanges);
        found.push(...rootHits.found);
        dynamic.push(...rootHits.dynamic);
        const helperHits = helperReferences(text, helpers, lists, collectStringConsts(text));
        found.push(...helperHits.found);
        dynamic.push(...helperHits.dynamic);
    }
    return { found, dynamic };
}

/** A shell script by extension or by shebang, which is what picks the bash matchers. */
function isShellFile(file, text) {
    if (path.extname(file).toLowerCase() === '.sh') return true;
    return /^#!.*\b(?:ba|z|k)?sh\b/.test(text.slice(0, 120));
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
        // By name as well as by real path: a git worktree resolves somewhere
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
 * The map itself. `opts.includePlatformTooling` adds the opt-in sweep of the
 * directories SIBLING_MAP_EXTRA_DIRS names (see SCOPE in the header); with it off
 * the map covers the `xchain-*` siblings and this repo's own computed requires.
 *
 * @param {string} root the directory the sibling checkouts sit in
 * @param {{includePlatformTooling?: boolean, extraDirs?: string[]}} [opts]
 * @returns {{siblingRepos: string[], paths: object, dynamicReferences: object[],
 *            distinctPathCount: number, referenceCount: number}}
 */
function buildReferenceMap(root, opts = {}) {
    const repos = siblingRepos(root);
    const paths = new Map();
    const dynamic = [];

    // One site can be spelled so that two matchers see it (a comment beside a
    // join that quotes the same path). The literal matchers run first and own
    // the site; an indirect matcher that lands on the same file, line and path
    // is the same reference seen twice, not a second one.
    const seen = new Set();

    const record = (rel, ref) => {
        const key = resolveInRepo(rel) || rel;
        const fingerprint = `${ref.file}|${ref.line}|${key}`;
        if (ref.form !== 'text' && ref.form !== 'join' && seen.has(fingerprint)) return;
        seen.add(fingerprint);
        if (!paths.has(key)) paths.set(key, { exists: resolveInRepo(rel) !== null, referrers: [] });
        paths.get(key).referrers.push(ref);
    };

    const scanOne = (file, repo, scanRoot) => {
        {
            let stat;
            try { stat = fs.statSync(file); } catch (e) { return; }
            if (stat.size > MAX_FILE_BYTES) return;
            let text;
            try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
            // The env-variable form never spells the repo name, so the cheap
            // pre-filter has to admit it too or the whole idiom stays invisible.
            if (!text.includes(REPO_NAME) && !text.includes('XCHAIN_INDEXER')) return;
            const rel = `${repo}/${path.relative(scanRoot, file)}`;

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
                    form: 'text',
                    raw: captured,
                });
            }

            JOIN_REFERENCE.lastIndex = 0;
            while ((m = JOIN_REFERENCE.exec(text)) !== null) {
                const tail = literalJoinTail(m[1]);
                const line = lineAt(text, m.index);
                if (tail === null) {
                    dynamic.push({ repo, file: rel, line, form: 'join', expression: m[1].trim().slice(0, 120) });
                    continue;
                }
                record(`src/${tail}`, { repo, file: rel, line, kind: 'join', form: 'join', raw: `src/${tail}` });
            }

            const indirect = scanIndirectIdioms(text, { shell: isShellFile(file, text) });
            for (const hit of indirect.found) {
                record(hit.path, {
                    repo,
                    file: rel,
                    line: lineAt(text, hit.index),
                    kind: referenceKind(lineTextAt(text, hit.index)),
                    form: hit.form,
                    raw: hit.path,
                    via: hit.root || hit.helper || hit.loopVar,
                });
            }
            for (const hit of indirect.dynamic) {
                dynamic.push({
                    repo,
                    file: rel,
                    line: lineAt(text, hit.index),
                    form: hit.form,
                    expression: hit.expression,
                    via: hit.root || hit.helper,
                });
            }
        }
    };

    for (const repo of repos) {
        const repoRoot = path.join(root, repo);
        for (const file of walkFiles(repoRoot, [])) scanOne(file, repo, repoRoot);
    }

    // The platform's own tooling: not a shipped service, but it reaches into this
    // repo just as hard, since the twin-copier script alone byte-copies about thirty
    // src/ files outward through the bash idioms above and no CI job runs it. OPT-IN
    // (see SCOPE in the header), because the directories live in the tree around this
    // checkout: the caller that wants them names them, and the default map is the
    // `xchain-*` siblings only. Swept under one label so `siblingRepos` still means
    // exactly the sibling checkouts a downstream reader already knows.
    const toolingSwept = [];
    const extraDirs = opts.includePlatformTooling
        ? (opts.extraDirs || platformToolingDirs())
        : [];
    for (const dir of extraDirs) {
        const abs = path.join(root, dir);
        if (!fs.existsSync(abs)) continue;
        toolingSwept.push(dir);
        for (const file of walkFiles(abs, [])) scanOne(file, PLATFORM_TOOLING_LABEL, root);
    }

    // This repo's own computed requires. They name no sibling, but they are the
    // other half of what a move has to be checked against, and nothing else in
    // the toolchain reports them.
    for (const file of walkFiles(path.join(REPO_ROOT, 'src'), [])) {
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
        const relFile = path.relative(REPO_ROOT, file);
        for (const hit of computedRequireSites(text, path.posix.dirname(relFile))) {
            dynamic.push({
                repo: REPO_NAME,
                file: `${REPO_NAME}/${relFile}`,
                line: lineAt(text, hit.index),
                form: hit.form,
                expression: hit.expression,
                via: hit.listVariable,
                listCandidates: hit.listCandidates,
            });
        }
    }

    const sortedPaths = {};
    let referenceCount = 0;
    const byKind = { require: 0, join: 0, text: 0 };
    // Which matcher found a site, kept beside the load/mention split rather than
    // folded into it: the two answer different questions, and a downstream reader
    // that only knows about `kind` must keep reading the same numbers it did.
    const byForm = { text: 0, join: 0, 'root-var': 0, helper: 0, 'shell-var': 0, 'shell-arg': 0 };
    for (const key of Array.from(paths.keys()).sort()) {
        const entry = paths.get(key);
        entry.referrers.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
        referenceCount += entry.referrers.length;
        for (const ref of entry.referrers) {
            byKind[ref.kind] += 1;
            byForm[ref.form] = (byForm[ref.form] || 0) + 1;
        }
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
        platformToolingSwept: toolingSwept,
        distinctPathCount: Object.keys(sortedPaths).length,
        // The subset that resolves to a file in the tree. The rest are
        // directory prefixes (`src/sql/`) and stale paths, which still matter
        // on a move but are not files anyone can repoint one-for-one.
        existingPathCount: Object.values(sortedPaths).filter((p) => p.exists).length,
        referenceCount,
        referenceCountByKind: byKind,
        referenceCountByForm: byForm,
        dynamicReferenceCount: dynamic.length,
        dynamicReferenceCountByForm: dynamic.reduce((acc, d) => {
            acc[d.form || 'join'] = (acc[d.form || 'join'] || 0) + 1;
            return acc;
        }, {}),
        paths: sortedPaths,
        dynamicReferences: dynamic,
    };
}

function parseArgs(argv) {
    const opts = { json: false, siblings: path.resolve(REPO_ROOT, '..'), includePlatformTooling: false };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--json') opts.json = true;
        else if (argv[i] === '--include-platform-tooling') opts.includePlatformTooling = true;
        else if (argv[i] === '--siblings') { opts.siblings = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--pin') { opts.pin = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--base-sha') { opts.baseSha = argv[i + 1]; i += 1; }
        else if (argv[i] === '--note') { opts.note = argv[i + 1]; i += 1; }
        else if (argv[i] === '--help' || argv[i] === '-h') opts.help = true;
    }
    return opts;
}

/**
 * The src/ inventory of a commit, read without touching the working tree.
 *
 * WHY THE PIN CARRIES IT. `exists` in a pin is only ever true of the tree the
 * pin was taken from, so a pin taken after a move has begun cannot tell a
 * reference that was always stale from one the move just broke. The commit's own
 * file list can, and it is the same answer whenever it is read.
 */
function srcInventoryAt(sha) {
    if (!sha) return null;
    try {
        const out = require('child_process').execFileSync(
            'git', ['ls-tree', '-r', '--name-only', sha, 'src'],
            { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
        );
        return out.split('\n').filter(Boolean).sort();
    } catch (e) {
        return null;
    }
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        return;
    }
    if (opts.includePlatformTooling && !platformToolingDirs().length) {
        console.error(`--include-platform-tooling with no ${PLATFORM_TOOLING_ENV}: `
            + 'name the directories to sweep, relative to the siblings root and comma-separated.');
        process.exitCode = 2;
        return;
    }
    const map = buildReferenceMap(opts.siblings, { includePlatformTooling: opts.includePlatformTooling });
    if (opts.pin) {
        const pinned = Object.assign({
            pinMetadata: {
                tool: 'bin/sibling-reference-map.js',
                capturedAt: new Date().toISOString(),
                indexerSha: opts.baseSha || null,
                // Relative to this checkout, never as the operator spelled it: an
                // absolute path names somebody's machine and pins to no tree at all.
                siblingsRoot: path.relative(REPO_ROOT, opts.siblings) || '.',
                note: opts.note || null,
                indexerSrcFilesAtBaseSha: srcInventoryAt(opts.baseSha),
            },
        }, map);
        fs.writeFileSync(opts.pin, `${JSON.stringify(pinned, null, 2)}\n`);
        console.log(`pin written: ${opts.pin}`);
        console.log(`  ${pinned.distinctPathCount} distinct paths, ${pinned.existingPathCount} resolving, `
            + `${pinned.referenceCount} reference sites`);
        return;
    }
    if (opts.json) {
        console.log(JSON.stringify(map, null, 2));
        return;
    }
    console.log(`sibling repos swept: ${map.siblingRepos.length} (${map.siblingRepos.join(', ')})`);
    console.log(`platform tooling swept: ${map.platformToolingSwept.length
        ? map.platformToolingSwept.join(', ')
        : `none (opt in with --include-platform-tooling and ${PLATFORM_TOOLING_ENV})`}`);
    console.log(`distinct indexer src/ paths referenced: ${map.distinctPathCount} `
        + `(${map.existingPathCount} resolve to a file in the tree)`);
    console.log(`total reference sites: ${map.referenceCount} `
        + `(require ${map.referenceCountByKind.require}, `
        + `join ${map.referenceCountByKind.join}, mention ${map.referenceCountByKind.text})`);
    console.log('reference sites by form: '
        + Object.keys(map.referenceCountByForm).map((f) => `${f} ${map.referenceCountByForm[f]}`).join(', '));
    console.log(`unresolvable path references: ${Object.values(map.paths).filter((p) => !p.exists).length}`);
    console.log(`dynamic references (a human checks these on a rename): ${map.dynamicReferenceCount} `
        + `(${Object.keys(map.dynamicReferenceCountByForm)
            .map((f) => `${f} ${map.dynamicReferenceCountByForm[f]}`).join(', ')})`);
    console.log('');
    const perRepo = {};
    for (const entry of Object.values(map.paths)) {
        for (const ref of entry.referrers) perRepo[ref.repo] = (perRepo[ref.repo] || 0) + 1;
    }
    console.log('reference sites per repo:');
    for (const repo of Object.keys(perRepo).sort()) console.log(`  ${repo.padEnd(24)} ${perRepo[repo]}`);
}

if (require.main === module) main();

module.exports = {
    buildReferenceMap,
    siblingRepos,
    platformToolingDirs,
    PLATFORM_TOOLING_LABEL,
    PLATFORM_TOOLING_ENV,
    resolveInRepo,
    literalJoinTail,
    trimPath,
    // The indirect matchers, exported so a fixture string drives exactly what
    // the sweep drives rather than a re-implementation of it.
    rootPrefix,
    collectRootVars,
    rootVarReferences,
    collectHelpers,
    helperReferences,
    collectLoopLists,
    collectStringConsts,
    arrayLiteralItems,
    shellReferences,
    computedRequireSites,
    scanIndirectIdioms,
    isShellFile,
};
