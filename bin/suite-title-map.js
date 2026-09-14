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
 * What every npm test script collects, file by file and title by title.
 *
 * WHY A MAP AND NOT A COUNT. A restructure that renames test files has to prove
 * it changed nothing about what runs, and a passing count proves nothing: a
 * renamed file can drop out of one glob while another file joins it and the
 * total holds. A suite that silently stops being collected reads as green
 * forever. So the invariant is the SET of full test titles per file, per npm
 * script, and a later run is compared against the committed pin through the
 * rename map that the moving commit declares.
 *
 * WHY IT NEEDS NO DATABASE. `mocha --dry-run` loads every spec file and walks
 * the suite tree without invoking a single hook or test body. Titles are
 * declared at load time, so they are all there; nothing connects, nothing
 * writes. That is what makes this pin cheap enough to re-take at every
 * milestone instead of once.
 *
 * EACH SCRIPT RUNS WITH ITS OWN ARGUMENTS, unchanged apart from the reporter
 * and the dry run. That matters more than it looks: the plain `test` script
 * carries no --no-config, so .mocharc.yml's spec list merges with its
 * positional globs, and a run that "tidied" the arguments would pin a
 * different collection than the one CI executes. A --grep stays, because the
 * filtered set is the script's identity.
 *
 * THE SHAPE ON DISK. Titles are stored once in `titleSets`, keyed by a hash of
 * the list, and each script's `files` map points a test file at the set it
 * contributed. Written out flat the pin is six megabytes of text repeated
 * across the scripts whose globs overlap; the indirection is lossless and the
 * comparison below reads it, so nothing has to unpack it by hand.
 *
 * USAGE
 *   node bin/suite-title-map.js                    human summary
 *   node bin/suite-title-map.js --json             the full map on stdout
 *   node bin/suite-title-map.js --out <file>       write the map as JSON
 *   node bin/suite-title-map.js --script test      one script only
 *   node bin/suite-title-map.js --compare <pin>    diff the tree against a pin,
 *                                                  exit 1 on any difference
 *   node bin/suite-title-map.js --compare <pin> --rename-map <file>
 *                                                  the same, with the moving
 *                                                  commit's {old: new} paths
 *                                                  applied to the pin first
 *   node bin/suite-title-map.js --compare <pin> --split-map <file>
 *                                                  the same, with the splitting
 *                                                  commit's {old: [new, ...]}
 *                                                  files graded as one union
 *                                                  (bin/suite_title_map/split_map.js)
 *
 ********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadSplits, compareWithSplits } = require('./suite_title_map/split_map.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const MOCHA_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'mocha');

/**
 * A shell-ish split that keeps quoted globs whole. The scripts are plain
 * `mocha ...` command lines with quoted glob arguments and the occasional
 * leading VAR=value; nothing here has a pipe, a subshell or a redirect, and a
 * script that grows one is reported as unsupported rather than mis-parsed.
 */
function splitCommand(script) {
    const tokens = [];
    let current = '';
    let quote = null;
    let started = false;
    let quoted = false;
    const push = () => { tokens.push({ value: current, quoted }); current = ''; started = false; quoted = false; };
    for (const ch of script) {
        if (quote) {
            if (ch === quote) quote = null;
            else current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; started = true; quoted = true; continue; }
        if (/\s/.test(ch)) {
            if (started || current) push();
            continue;
        }
        current += ch;
    }
    if (started || current) push();
    return tokens;
}

// Shell operators, recognised only on an UNQUOTED token: --grep '@x.*(a|b)'
// carries a pipe inside its pattern and is a perfectly ordinary single command.
const SHELL_OPERATOR = /^(?:&&|\|\||[|;]|[<>]+)$/;

/**
 * What a test script actually is: one mocha command, a chain of other npm
 * scripts, or something this tool will not guess at.
 * @returns {{args: string[], env: object}|{composite: string[]}|{skip: string}}
 */
function mochaArgsFor(script) {
    const tokens = splitCommand(script);
    const operators = tokens.filter((t) => !t.quoted && SHELL_OPERATOR.test(t.value));
    if (operators.length) {
        const members = [];
        for (let i = 0; i < tokens.length - 1; i += 1) {
            if (tokens[i].value !== 'npm') continue;
            // `npm test` is the same member as `npm run test` and has to land in
            // the list under the same name, or the union looks short by a suite.
            if (tokens[i + 1].value === 'run' && tokens[i + 2]) members.push(tokens[i + 2].value);
            else if (tokens[i + 1].value === 'test') members.push('test');
        }
        if (members.length) return { composite: members };
        return { skip: 'shell composition this tool does not expand' };
    }
    // Leading environment assignments (FUZZ_RUNS=1000 mocha ...) are set on the
    // child rather than dropped: a suite may name its title from one.
    const env = {};
    let i = 0;
    while (i < tokens.length && !tokens[i].quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i].value)) {
        const eq = tokens[i].value.indexOf('=');
        env[tokens[i].value.slice(0, eq)] = tokens[i].value.slice(eq + 1);
        i += 1;
    }
    if (!tokens[i] || tokens[i].value !== 'mocha') {
        return { skip: `not a mocha command (runs ${tokens[i] ? tokens[i].value : 'nothing'})` };
    }
    return { args: tokens.slice(i + 1).map((t) => t.value), env };
}

/** Titles for one script, keyed by repo-relative test file. */
function collect(scriptName, script) {
    const parsed = mochaArgsFor(script);
    if (parsed.skip) return { skipped: parsed.skip };
    // A chain of npm scripts collects exactly the union of its members, each of
    // which is pinned in its own right; restating their titles here would pin
    // the same suites twice and make one rename look like two.
    if (parsed.composite) return { composite: parsed.composite };

    const res = spawnSync(MOCHA_BIN, ['--dry-run', '--reporter', 'json', ...parsed.args], {
        cwd: REPO_ROOT,
        env: { ...process.env, ...parsed.env },
        maxBuffer: 256 * 1024 * 1024,
        encoding: 'utf8',
    });
    if (res.error) return { error: String(res.error.message) };

    let report;
    try {
        // The json reporter writes the report to stdout, but a spec file that
        // logs at load time writes there too; the report is the last JSON
        // object, so parsing starts at the last line that opens one.
        const start = res.stdout.indexOf('{\n  "stats"');
        report = JSON.parse(start === -1 ? res.stdout : res.stdout.slice(start));
    } catch (e) {
        return { error: `unparseable mocha json (exit ${res.status}): ${res.stderr.slice(0, 400)}` };
    }

    const files = {};
    for (const test of (report.tests || []).concat(report.pending || [])) {
        const rel = test.file ? path.relative(REPO_ROOT, test.file) : '(no file)';
        if (!files[rel]) files[rel] = [];
        files[rel].push(test.fullTitle);
    }
    const sorted = {};
    let titles = 0;
    for (const rel of Object.keys(files).sort()) {
        sorted[rel] = files[rel].slice().sort();
        titles += sorted[rel].length;
    }
    return { fileCount: Object.keys(sorted).length, titleCount: titles, files: sorted };
}

function setKey(titles) {
    return crypto.createHash('sha256').update(titles.join('\n')).digest('hex').slice(0, 16);
}

function buildMap(only) {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const names = Object.keys(pkg.scripts || {}).filter((n) => n.startsWith('test')).sort();
    const titleSets = {};
    const scripts = {};
    for (const name of names) {
        if (only && name !== only) continue;
        const result = collect(name, pkg.scripts[name]);
        if (result.files) {
            const files = {};
            for (const rel of Object.keys(result.files)) {
                const key = setKey(result.files[rel]);
                titleSets[key] = result.files[rel];
                files[rel] = key;
            }
            result.files = files;
        }
        scripts[name] = result;
    }
    const sortedSets = {};
    for (const key of Object.keys(titleSets).sort()) sortedSets[key] = titleSets[key];
    return { titleSets: sortedSets, scripts };
}

/** The flat {file: [titles]} view of one script in a map, pin or fresh. */
function expand(map, scriptName) {
    const s = map.scripts[scriptName];
    if (!s || !s.files) return null;
    const out = {};
    for (const rel of Object.keys(s.files).sort()) out[rel] = map.titleSets[s.files[rel]] || [];
    return out;
}

/**
 * Pin against tree, script by script. `renames` is the moving commit's declared
 * {oldPath: newPath}; a pin entry is compared under its new name so a pure move
 * reports no difference while a move that changed a title still does.
 */
function compare(pin, fresh, renames, only) {
    const differences = [];
    // A run narrowed to one script compares that script only: every other
    // script in the pin is absent because it was not collected, which is not a
    // finding and would bury the one that is.
    const names = Array.from(new Set(Object.keys(pin.scripts).concat(Object.keys(fresh.scripts))))
        .filter((n) => !only || n === only)
        .sort();
    for (const name of names) {
        const before = expand(pin, name);
        const after = expand(fresh, name);
        if (!before && !after) continue;
        if (!before || !after) {
            differences.push({ script: name, kind: 'script', detail: before ? 'script removed' : 'script added' });
            continue;
        }
        const mapped = {};
        for (const rel of Object.keys(before)) mapped[renames[rel] || rel] = before[rel];
        const files = Array.from(new Set(Object.keys(mapped).concat(Object.keys(after)))).sort();
        for (const rel of files) {
            if (!mapped[rel]) { differences.push({ script: name, kind: 'file_added', file: rel }); continue; }
            if (!after[rel]) { differences.push({ script: name, kind: 'file_dropped', file: rel }); continue; }
            const gone = mapped[rel].filter((t) => !after[rel].includes(t));
            const added = after[rel].filter((t) => !mapped[rel].includes(t));
            for (const t of gone) differences.push({ script: name, kind: 'title_dropped', file: rel, title: t });
            for (const t of added) differences.push({ script: name, kind: 'title_added', file: rel, title: t });
        }
    }
    return differences;
}

function parseArgs(argv) {
    const opts = { json: false };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--json') opts.json = true;
        else if (argv[i] === '--out') { opts.out = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--script') { opts.script = argv[i + 1]; i += 1; }
        else if (argv[i] === '--compare') { opts.compare = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--rename-map') { opts.renameMap = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--split-map') { opts.splitMap = path.resolve(argv[i + 1]); i += 1; }
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
    const map = buildMap(opts.script);

    if (opts.compare) {
        const pin = JSON.parse(fs.readFileSync(opts.compare, 'utf8'));
        const renames = opts.renameMap ? JSON.parse(fs.readFileSync(opts.renameMap, 'utf8')) : {};
        const splits = opts.splitMap ? loadSplits(opts.splitMap) : {};
        const differences = compareWithSplits({ pin, fresh: map, renames, splits, only: opts.script, compare });
        if (!differences.length) {
            console.log(`suite identity holds against ${path.relative(REPO_ROOT, opts.compare)}`
                + `${opts.renameMap ? ' through the declared rename map' : ''}`
                + `${opts.splitMap ? ' through the declared split map' : ''}`);
            return;
        }
        console.log(`${differences.length} difference(s) against ${path.relative(REPO_ROOT, opts.compare)}:`);
        for (const d of differences.slice(0, 200)) {
            console.log(`  [${d.script}] ${d.kind} ${d.file || ''} ${d.title ? `:: ${d.title}` : d.detail || ''}`);
        }
        if (differences.length > 200) console.log(`  ... and ${differences.length - 200} more`);
        process.exitCode = 1;
        return;
    }

    // Escaped to pure ASCII on the way out. The titles are captured verbatim and
    // some of them carry characters the platform's prose rules keep out of
    // committed files; escaping changes the encoding and not one parsed
    // character, so the pin stays exactly what mocha reported.
    const text = `${JSON.stringify(map, null, 2).replace(/[-￿]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;
    if (opts.out) {
        fs.mkdirSync(path.dirname(opts.out), { recursive: true });
        fs.writeFileSync(opts.out, text);
    }
    if (opts.json) {
        process.stdout.write(text);
        return;
    }
    let failed = 0;
    for (const name of Object.keys(map.scripts)) {
        const s = map.scripts[name];
        if (s.skipped) { console.log(`${name.padEnd(26)} skipped: ${s.skipped}`); continue; }
        if (s.composite) { console.log(`${name.padEnd(26)} composite: ${s.composite.join(' + ')}`); continue; }
        if (s.error) { console.log(`${name.padEnd(26)} ERROR: ${s.error}`); failed += 1; continue; }
        console.log(`${name.padEnd(26)} ${String(s.fileCount).padStart(4)} files  `
            + `${String(s.titleCount).padStart(5)} titles`);
    }
    if (opts.out) console.log(`\nwritten to ${path.relative(REPO_ROOT, opts.out)}`);
    if (failed) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { buildMap, collect, mochaArgsFor, splitCommand, compare, expand };
