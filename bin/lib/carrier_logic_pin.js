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
 * WHY THREE BYTE-IDENTICAL COPIES. This module is a twin in xchain-indexer,
 * xchain-sync and xchain-hub, and the membership rule for each repo lives here
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
 * USAGE (from the repo root)
 *   node bin/lib/carrier_logic_pin.js                 check every entry
 *   node bin/lib/carrier_logic_pin.js --json          the digest and entries
 *   node bin/lib/carrier_logic_pin.js --write --id <id> --reason "<text>"
 *   node bin/lib/carrier_logic_pin.js --add --id <id> --path <p> --reason "<text>"
 *   node bin/lib/carrier_logic_pin.js --init --reason "<text>" [--twins <json>]
 *   node bin/lib/carrier_logic_pin.js --root <dir>    check another checkout
 *
 * Exit 0 when every entry holds, 1 when one moved, 2 on a refused write.
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
const REPO_ROOT  = path.resolve(__dirname, '..', '..');

// The repos that carry a copy of this module; each copy's twins are the others.
const MODULE_TWINS = ['xchain-indexer', 'xchain-sync', 'xchain-hub'];

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

/** The sibling checkout for `repoName`: XCHAIN_<NAME>_DIR (XCHAIN_HUB_DIR for xchain-hub), else the directory beside this one. */
function siblingDir(repoName, dir) {
    const env = process.env[`XCHAIN_${repoName.replace(/^xchain-/, '').toUpperCase().replace(/-/g, '_')}_DIR`];
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

/** The initialiser of `const <name> = ...` in `source`, read from the AST rather than restated here. */
function constInit(source, name) {
    const ast = acorn.parse(source, TOKENIZER_OPTS);
    for (const node of ast.body) {
        if (node.type !== 'VariableDeclaration') continue;
        for (const decl of node.declarations) {
            if (decl.id.type === 'Identifier' && decl.id.name === name) return decl.init;
        }
    }
    throw new Error(`${name} is not declared at the top level`);
}

/** The top-level `*_activation.js` files of `src/`, as repo-relative paths. */
function activationFiles(dir, sub) {
    const rel = sub ? `src/${sub}` : 'src';
    let names;
    try { names = fs.readdirSync(path.join(dir, rel)); } catch (e) { return []; }
    return names.filter((f) => f.endsWith('_activation.js')).sort().map((f) => `${rel}/${f}`);
}

/**
 * The armed-map fingerprint's membership, read from the module that defines
 * it: every top-level activation file plus the FIXED_GATE_FILES that exist.
 */
function fingerprintMembers(dir, fingerprintRel) {
    const source = fs.readFileSync(path.join(dir, fingerprintRel), 'utf8');
    const fixed = constInit(source, 'FIXED_GATE_FILES').elements.map((e) => `src/${e.value}`);
    return activationFiles(dir).concat(fixed).filter((rel) => fs.existsSync(path.join(dir, rel)));
}

/**
 * The hub's gate carriers, the same set its frozen-set check freezes: every
 * activation file at the top level and under src/lib, every SHARED_GATES
 * carrier at src/<name>.js, and the digest module that computes the requires.
 */
function hubMembers(dir) {
    const source = fs.readFileSync(path.join(dir, 'src/consensus_rules_digest.js'), 'utf8');
    const shared = constInit(source, 'SHARED_GATES').elements
        .map((row) => `src/${row.elements[0].value}.js`);
    return activationFiles(dir).concat(activationFiles(dir, 'lib'), shared, ['src/consensus_rules_digest.js'])
        .filter((rel) => fs.existsSync(path.join(dir, rel)));
}

/**
 * The paths this repo pins, by the repo's package name, deduplicated and sorted.
 * @param {string} dir a checkout
 * @returns {string[]} repo-relative posix paths
 */
function members(dir) {
    const name = repoName(dir);
    let list;
    if (name === 'xchain-indexer') {
        list = fingerprintMembers(dir, 'src/consensus/armed_map/armed_map_fingerprint.js')
            .concat(['src/consensus_rules_digest.js']);
    } else if (name === 'xchain-sync') {
        list = fingerprintMembers(dir, 'src/armedMapFingerprint.js');
    } else if (name === 'xchain-hub') {
        list = hubMembers(dir);
    } else {
        throw new Error(`no membership rule for ${name}`);
    }
    return Array.from(new Set(list)).sort();
}

/** Today's date for a repins record, from the clock at the moment of the write. */
function today() { return new Date().toISOString().slice(0, 10); }

/**
 * Add or replace one entry, recording the move. Refused when the file is
 * absent or when the hash has not moved, because a record of nothing is noise.
 */
function pinEntry(dir, pin, id, rel, reason, twins) {
    const hash = hashFile(dir, rel);
    if (hash === null) throw new Error(`${rel} does not exist under ${dir}`);
    const before = pin.entries[id];
    if (before && before.hash === hash && before.path === rel) throw new Error(`${id} is unchanged; nothing to re-pin`);
    pin.entries[id] = { path: rel, hash, twins: twins || (before ? before.twins : []) };
    if (before && before.note) pin.entries[id].note = before.note;
    pin.repins.push({ id, from: before ? before.hash : null, to: hash, reason, date: today() });
}

function parseArgs(argv) {
    const opts = { root: REPO_ROOT };
    const valued = { '--id': 'id', '--path': 'path', '--reason': 'reason', '--twins': 'twins', '--root': 'root' };
    const flags = { '--json': 'json', '--write': 'write', '--add': 'add', '--init': 'init' };
    for (let i = 0; i < argv.length; i += 1) {
        if (valued[argv[i]]) { opts[valued[argv[i]]] = argv[i + 1]; i += 1; }
        else if (flags[argv[i]]) opts[flags[argv[i]]] = true;
        else if (argv[i] === '--help' || argv[i] === '-h') opts.help = true;
        else throw new Error(`unknown argument: ${argv[i]}`);
    }
    if (opts.root) opts.root = path.resolve(opts.root);
    return opts;
}

/** The write paths: one entry, one added entry, or the whole membership on first use. */
function runWrite(opts) {
    if (!opts.reason) throw new Error('--reason is required for any write');
    const dir = opts.root;
    const pinPath = path.join(dir, PIN_REL);
    if (opts.init) {
        if (fs.existsSync(pinPath)) throw new Error(`${PIN_REL} exists; --init is for a repo without one`);
        const twins = opts.twins ? JSON.parse(fs.readFileSync(opts.twins, 'utf8')) : {};
        const pin = { version: 1, entries: {}, repins: [] };
        for (const rel of members(dir)) pinEntry(dir, pin, moduleId(rel), rel, opts.reason, twins[moduleId(rel)] || []);
        writePin(dir, pin);
        console.log(`pinned ${Object.keys(pin.entries).length} entries to ${PIN_REL}`);
        return 0;
    }
    if (!opts.id) throw new Error('--id is required');
    const pin = readPin(dir);
    if (opts.add) {
        if (!opts.path) throw new Error('--add needs --path');
        if (pin.entries[opts.id]) throw new Error(`${opts.id} is already pinned; use --write`);
        pinEntry(dir, pin, opts.id, opts.path, opts.reason, opts.twins ? opts.twins.split(',') : []);
    } else {
        if (!pin.entries[opts.id]) throw new Error(`${opts.id} is not pinned; use --add`);
        pinEntry(dir, pin, opts.id, pin.entries[opts.id].path, opts.reason);
    }
    writePin(dir, pin);
    const rec = pin.repins[pin.repins.length - 1];
    console.log(`${opts.add ? 'added' : 're-pinned'} ${opts.id}: ${rec.from || '(new)'} -> ${rec.to}`);
    return 0;
}

function main(argv) {
    const opts = parseArgs(argv);
    if (opts.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        return 0;
    }
    if (opts.write || opts.add || opts.init) return runWrite(opts);

    const pin = readPin(opts.root);
    const measured = measure(opts.root, pin);
    const hex = digest(pin);
    const moved = Object.keys(measured).filter((id) => !measured[id].ok);
    if (opts.json) {
        const entries = {};
        for (const id of Object.keys(measured)) {
            entries[id] = { path: measured[id].path, hash: measured[id].expected, ok: measured[id].ok };
        }
        console.log(JSON.stringify({ carrier_logic_digest: hex, entries }, null, 2));
    } else {
        console.log(`carrier_logic_digest ${hex}`);
        for (const id of Object.keys(measured)) {
            console.log(`${measured[id].ok ? 'ok   ' : 'MOVED'} ${id} ${measured[id].path}`);
        }
    }
    return moved.length ? 1 : 0;
}

if (require.main === module) {
    try {
        process.exit(main(process.argv.slice(2)));
    } catch (e) {
        console.error(`carrier_logic_pin: ${e.message}`);
        process.exit(2);
    }
}

module.exports = {
    tokenHash,
    moduleId,
    readPin,
    writePin,
    measure,
    digest,
    siblingDir,
    members,
    committedPin,
    repoName,
    main,
    PIN_REL,
    MODULE_REL,
    MODULE_TWINS,
    REPO_ROOT,
};
