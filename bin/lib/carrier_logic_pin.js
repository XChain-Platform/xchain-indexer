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
 * The carrier logic pin: one hash per consensus-logic module, keyed by a
 * stable module id rather than a path, so a restructure can move, reformat or
 * re-comment a carrier without moving the pin while any change to what the
 * code DOES moves it.
 *
 * WHY A TOKEN HASH AND NOT A BYTE HASH. The armed-map fingerprint hashes bytes,
 * so a comment restoration or a rename reads as a consensus change and the
 * fleet has to be re-verified for nothing. Hashing the acorn TOKEN stream drops
 * comments and whitespace for free, and replacing the string argument of every
 * `require(...)` with a placeholder lets a module be re-pointed at a moved
 * sibling without a re-pin. Function bodies, helpers, operators, constants and
 * map literals all survive as tokens, so any of them moving moves the hash.
 * The whole file is pinned rather than the exports, because the algorithms
 * that matter (stateHash.js above all) live in non-exported helpers.
 *
 * WHY THREE BYTE-IDENTICAL COPIES. This module and its operations half,
 * carrier_logic_pin_ops.js, are twins in xchain-indexer, xchain-sync and
 * xchain-hub, and the membership rule for each repo lives in the ops half
 * keyed by the repo's package name so the bytes stay identical: a hash taken
 * by one copy is comparable to a hash taken by another, which is what the
 * twin check below relies on. Pin `acorn` at ONE exact version in all three
 * for the same reason: a tokenizer difference would read as a twin mismatch.
 *
 * HOW A DELIBERATE LOGIC CHANGE RE-PINS. Only through `--write --id <id>
 * --reason "<ledger id or spec row>"`, which rewrites that one entry and
 * appends a `repins` record. The unit test refuses a pin whose entries moved
 * without such a record, so a bare regenerate is not a way past the guard.
 *
 * HOW A MODULE LEAVES OR MOVES WITHOUT A LOGIC CHANGE. A deleted carrier is
 * RETIRED (`--retire`): the entry goes and a record with `to: null` says so.
 * A renamed or relocated carrier is MOVED (`--move`): the id is stable (a
 * module keeps the id it was first pinned under, never one derived from its
 * new path), only the `path` field changes, and the move is refused unless
 * the file at the new path still hashes to the pinned value, so a move can
 * never smuggle a logic change. Both leave a `repins` record the unit test
 * demands, exactly as a re-pin does.
 *
 * MEMBERSHIP (which files are carriers) is read from the tree AND the pin by
 * the ops half; a member the pin does not hold is reported as NEW here.
 *
 * USAGE (from the repo root)
 *   node bin/lib/carrier_logic_pin.js                 check every entry
 *   node bin/lib/carrier_logic_pin.js --json          the digest, entries and unpinned members
 *   node bin/lib/carrier_logic_pin.js --write --id <id> --reason "<text>"
 *   node bin/lib/carrier_logic_pin.js --add --id <id> --path <p> --reason "<text>"
 *   node bin/lib/carrier_logic_pin.js --retire --id <id> --reason "<text>"
 *   node bin/lib/carrier_logic_pin.js --move --id <id> --path <newPath> [--reason "<text>"]
 *   node bin/lib/carrier_logic_pin.js --init --reason "<text>" [--twins <json>]
 *   node bin/lib/carrier_logic_pin.js --init --json   list the members (a dry run, no write)
 *   node bin/lib/carrier_logic_pin.js --root <dir>    check another checkout
 *
 * Exit 0 when every entry holds and every member is pinned, 1 when one moved,
 * one is unpinned, or a --move found different logic at the new path, 2 on a
 * refused write.
 *
 ********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const acorn  = require('acorn');

const PIN_REL    = 'bin/pins/carrier-logic.json';
const MODULE_REL = 'bin/lib/carrier_logic_pin.js';
const OPS_REL    = 'bin/lib/carrier_logic_pin_ops.js';
const REPO_ROOT  = path.resolve(__dirname, '..', '..');

// The repos that carry a copy of this module; each copy's twins are the others.
const MODULE_TWINS = ['xchain-indexer', 'xchain-sync', 'xchain-hub'];
// The files that must read byte-identical in every twin repo.
const MODULE_TWIN_FILES = [MODULE_REL, OPS_REL];

const TOKENIZER_OPTS = { ecmaVersion: 2022, sourceType: 'script', allowHashBang: true };

/** One token as one line: the label, then the value where the type has one. */
function tokenLine(tok, priorTwo) {
    let value = tok.value;
    if (tok.type.label === 'string' && priorTwo[0] === 'name:require' && priorTwo[1] === '(:') {
        // A require path is where a module lives, not what it does.
        value = '<path>';
    } else if (tok.type.label === 'regexp') {
        value = `${value.pattern}/${value.flags}`;
    } else if (typeof value === 'bigint') {
        value = `${value}n`;
    }
    return `${tok.type.label}:${value === undefined ? '' : String(value)}`;
}

/**
 * sha256 over the token stream of `source`, comments and whitespace gone and
 * every require path replaced by `<path>`.
 * @param {string} source JavaScript
 * @returns {string} lowercase hex
 */
function tokenHash(source) {
    const hash = crypto.createHash('sha256');
    const priorTwo = ['', ''];
    let first = true;
    for (const tok of acorn.tokenizer(source, TOKENIZER_OPTS)) {
        const line = tokenLine(tok, priorTwo);
        hash.update(first ? line : `\n${line}`);
        first = false;
        priorTwo[0] = priorTwo[1];
        priorTwo[1] = line;
    }
    return hash.digest('hex');
}

/**
 * The id of a module: its path relative to src/ without the extension, so the
 * key is the stem the fingerprint rows already use and survives a move
 * between src/ and a feature directory.
 * @param {string} relPath repo-relative, either separator
 * @returns {string}
 */
function moduleId(relPath) {
    const posix = relPath.split(path.sep).join('/').replace(/^\.\//, '');
    const stem = posix.startsWith('src/') ? posix.slice(4) : posix;
    return stem.replace(/\.js$/, '');
}

/**
 * Where each twin's checkout may be pointed from the environment. Three
 * literal reads rather than one computed name, so the env-var doc scanner
 * sees each variable and the documentation gate can hold it.
 */
const SIBLING_DIR_ENV = {
    'xchain-indexer': () => process.env.XCHAIN_INDEXER_DIR,
    'xchain-sync':    () => process.env.XCHAIN_SYNC_DIR,
    'xchain-hub':     () => process.env.XCHAIN_HUB_DIR,
};

/** The sibling checkout for `repoName`: its XCHAIN_<NAME>_DIR when set, else the directory beside this one. */
function siblingDir(repoName, dir) {
    const env = SIBLING_DIR_ENV[repoName] ? SIBLING_DIR_ENV[repoName]() : undefined;
    return env || path.join(dir || REPO_ROOT, '..', repoName);
}

/** The package name of the checkout at `dir`, which selects its membership rule. */
function repoName(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name;
}

function readPin(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, PIN_REL), 'utf8'));
}

/** Entries sorted by id, two-space JSON, trailing newline: one spelling so a diff is a change. */
function writePin(dir, pin) {
    const entries = {};
    for (const id of Object.keys(pin.entries).sort()) entries[id] = pin.entries[id];
    const out = { version: pin.version || 1, entries, repins: pin.repins || [] };
    const dest = path.join(dir, PIN_REL);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`);
    return out;
}

/** The token hash of the file at `rel` under `dir`, or null when it is not there. */
function hashFile(dir, rel) {
    const abs = path.join(dir, ...rel.split('/'));
    if (!fs.existsSync(abs)) return null;
    return tokenHash(fs.readFileSync(abs, 'utf8'));
}

/**
 * Every entry against the tree under `dir`.
 * @returns {Object<string, {path: string, expected: string, actual: string|null, ok: boolean}>}
 */
function measure(dir, pin) {
    const out = {};
    for (const id of Object.keys(pin.entries).sort()) {
        const entry = pin.entries[id];
        const actual = hashFile(dir, entry.path);
        out[id] = { path: entry.path, expected: entry.hash, actual, ok: actual === entry.hash };
    }
    return out;
}

/** `carrier_logic_digest`: sha256 over the sorted `id=hash` lines. */
function digest(pin) {
    const hash = crypto.createHash('sha256');
    for (const id of Object.keys(pin.entries).sort()) hash.update(`${id}=${pin.entries[id].hash}\n`);
    return hash.digest('hex');
}

/** The pin as last committed, or null when git says it was not there. */
function committedPin(dir) {
    try {
        const text = execFileSync('git', ['show', `HEAD:${PIN_REL}`], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
        return JSON.parse(text.toString('utf8'));
    } catch (e) {
        return null;
    }
}

// The membership rules and the pin operations, layered over the primitives
// above (see the ops twin's header for why it takes them as an argument).
const ops = require('./carrier_logic_pin_ops')({ TOKENIZER_OPTS, PIN_REL, hashFile, moduleId, repoName, readPin, writePin });

function parseArgs(argv) {
    const opts = { root: REPO_ROOT };
    const valued = { '--id': 'id', '--path': 'path', '--reason': 'reason', '--twins': 'twins', '--root': 'root' };
    const flags = { '--json': 'json', '--write': 'write', '--add': 'add', '--init': 'init', '--retire': 'retire', '--move': 'move' };
    for (let i = 0; i < argv.length; i += 1) {
        if (valued[argv[i]]) { opts[valued[argv[i]]] = argv[i + 1]; i += 1; }
        else if (flags[argv[i]]) opts[flags[argv[i]]] = true;
        else if (argv[i] === '--help' || argv[i] === '-h') opts.help = true;
        else throw new Error(`unknown argument: ${argv[i]}`);
    }
    if (opts.root) opts.root = path.resolve(opts.root);
    return opts;
}

function main(argv) {
    const opts = parseArgs(argv);
    if (opts.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        return 0;
    }
    const writes = ['write', 'add', 'init', 'retire', 'move'].filter((k) => opts[k]);
    if (writes.length > 1) throw new Error(`one operation at a time: --${writes.join(' --')}`);
    if (opts.init && opts.json) return ops.listMembers(opts);
    if (writes.length) return ops.runWrite(opts);

    const pin = readPin(opts.root);
    const measured = measure(opts.root, pin);
    const hex = digest(pin);
    const moved = Object.keys(measured).filter((id) => !measured[id].ok);
    const { unpinned } = ops.membershipDiff(opts.root, pin);
    if (opts.json) {
        const entries = {};
        for (const id of Object.keys(measured)) {
            entries[id] = { path: measured[id].path, hash: measured[id].expected, ok: measured[id].ok };
        }
        const extra = {};
        for (const row of unpinned) extra[row.id] = row.path;
        console.log(JSON.stringify({ carrier_logic_digest: hex, entries, unpinned: extra }, null, 2));
    } else {
        console.log(`carrier_logic_digest ${hex}`);
        for (const id of Object.keys(measured)) {
            console.log(`${measured[id].ok ? 'ok   ' : 'MOVED'} ${id} ${measured[id].path}`);
        }
        for (const row of unpinned) console.log(`NEW   ${row.id} ${row.path} (a member the pin does not hold; --add it)`);
    }
    return moved.length || unpinned.length ? 1 : 0;
}

if (require.main === module) {
    try {
        process.exit(main(process.argv.slice(2)));
    } catch (e) {
        console.error(`carrier_logic_pin: ${e.message}`);
        process.exit(e.exitCode || 2);
    }
}

module.exports = Object.assign({
    tokenHash,
    moduleId,
    readPin,
    writePin,
    measure,
    digest,
    siblingDir,
    committedPin,
    repoName,
    main,
    PIN_REL,
    MODULE_REL,
    OPS_REL,
    MODULE_TWINS,
    MODULE_TWIN_FILES,
    REPO_ROOT,
}, ops);
