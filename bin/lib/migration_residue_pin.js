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
 * The migration immutability pin: two sha256 values per committed migration in
 * test/fixtures/migration-executable-residue.json, so an in-place edit to an
 * applied file fails in CI instead of surfacing on a fleet as `content CHANGED`.
 *
 *   residue  the file with every `--` line and blank line dropped (the basis the
 *            MIGRATION_CHECKSUM_REBASELINES entries are verified on). A change
 *            here is an executable edit and always fails.
 *   sha256   the whole file, exactly what schema_migrations records. A change here
 *            passes only when a reviewed rebaseline heals the pinned hash to the
 *            current one, since that is the only case a deployed DB survives.
 *
 * A file the pin does not hold yet passes in the plain check, so a branch needs no fixture
 * edit mid-flight; `--add` pins it. The check also fails every file already committed at the
 * merge-base with develop (or `--base <ref>`) and still unpinned, so a migration that reached
 * develop cannot stay uncovered and the gate needs no manual `--add` to notice it. When no base
 * ref resolves (a shallow or detached checkout) the compare is skipped with a warning;
 * `--no-base` skips it on purpose. An existing entry moves only through `--accept <file>`,
 * which is legitimate solely for a file no database has applied.
 *
 * USAGE (from the repo root)
 *   node bin/lib/migration_residue_pin.js              check; exit 1 on a violation
 *   node bin/lib/migration_residue_pin.js --base <ref> compare against another base than develop
 *   node bin/lib/migration_residue_pin.js --no-base    skip the merge-base compare
 *   node bin/lib/migration_residue_pin.js --add        pin every unpinned file
 *   node bin/lib/migration_residue_pin.js --accept <file> [--accept <file>]
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const { execFileSync } = require('child_process');
const path   = require('path');

const ROOT    = path.join(__dirname, '..', '..');
const MIG_DIR = path.join(ROOT, 'src', 'sql', 'migrations');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'migration-executable-residue.json');
const REBASELINE_SOURCE = path.join(ROOT, 'src', 'db', 'migration', 'checksum_rebaselines.js');
const REBASELINE_NAME   = 'MIGRATION_CHECKSUM_REBASELINES';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function executableResidue(raw){
    return String(raw).split('\n').filter((l) => !/^\s*--/.test(l) && l.trim() !== '').join('\n');
}

function pinOf(raw){
    return { residue: sha256(executableResidue(raw)), sha256: sha256(raw) };
}

// Every violation of the pin over `files` (name -> raw text), as { file, kind, message }.
function findViolations({ files, fixture, rebaselines, committed }){
    const out = [];
    for(const file of [].concat(committed || []).filter((f) => !Object.hasOwn(fixture, f)).sort()){
        out.push({ file, kind: 'unpinned', message: file + ' is committed at the base but not pinned: run ' +
            'node bin/lib/migration_residue_pin.js --add and commit the fixture.' });
    }
    for(const file of Object.keys(fixture).sort()){
        const pinned = fixture[file];
        if(!Object.hasOwn(files, file)){
            out.push({ file, kind: 'missing', message: file + ' is pinned but gone: deleting or renaming an applied ' +
                'migration breaks every ledger that recorded it (a rename also needs a MIGRATION_LEDGER_RENAMES entry).' });
            continue;
        }
        const now = pinOf(files[file]);
        if(now.residue !== pinned.residue){
            out.push({ file, kind: 'residue', message: file + ': the executable statements of a pinned migration ' +
                'changed. Revert and write a new dated migration; MIGRATION_CHECKSUM_REBASELINES heals the ledger only.' });
            continue;
        }
        const heal = rebaselines && rebaselines[file];
        const healed = heal && heal.to === now.sha256 && [].concat(heal.from).includes(pinned.sha256);
        if(now.sha256 !== pinned.sha256 && !healed){
            out.push({ file, kind: 'content', message: file + ': content changed with no rebaseline from ' +
                pinned.sha256.slice(0, 12) + ' to ' + now.sha256.slice(0, 12) + ', so every DB that applied it logs ' +
                '`content CHANGED` and migrate.js fails closed there. Revert, or add a reviewed comment-only rebaseline.' });
        }
    }
    return out;
}

// Drops `//` and `/* */` comments outside string literals; the rebaseline table holds only
// quoted hex and file names, so a quote always closes on its own line.
function stripComments(src){
    let out = '';
    for(let i = 0; i < src.length;){
        const c = src[i], n = src[i + 1];
        if(c === "'" || c === '"'){
            let j = i + 1;
            while(j < src.length && src[j] !== c && src[j] !== '\n'){ j += src[j] === '\\' ? 2 : 1; }
            if(src[j] !== c) throw new Error('unterminated string in the rebaseline source');
            out += src.slice(i, j + 1); i = j + 1;
        } else if(c === '/' && n === '/'){
            while(i < src.length && src[i] !== '\n') i++;
        } else if(c === '/' && n === '*'){
            const end = src.indexOf('*/', i + 2);
            if(end < 0) throw new Error('unterminated comment in the rebaseline source');
            i = end + 2;
        } else { out += c; i++; }
    }
    return out;
}

// Reads the rebaseline table as data: the object literal is cut out of the source text,
// rewritten to JSON and parsed, so nothing in the checked-out file is ever evaluated.
// Any construct beyond quoted strings, arrays and nested objects fails the parse.
function readRebaselines(sourcePath){
    const src = fs.readFileSync(sourcePath || REBASELINE_SOURCE, 'utf8');
    const decl = src.indexOf('const ' + REBASELINE_NAME + ' = {');
    if(decl < 0) throw new Error(REBASELINE_NAME + ' declaration not found in ' + (sourcePath || REBASELINE_SOURCE));
    const body = stripComments(src.slice(src.indexOf('{', decl)));
    let depth = 0, end = -1, quote = null;
    for(let i = 0; i < body.length && end < 0; i++){
        const c = body[i];
        if(quote){ if(c === '\\') i++; else if(c === quote) quote = null; continue; }
        if(c === "'" || c === '"') quote = c;
        else if(c === '{') depth++;
        else if(c === '}' && --depth === 0) end = i;
    }
    if(end < 0) throw new Error('unbalanced ' + REBASELINE_NAME + ' literal');
    const json = body.slice(0, end + 1)
        .replace(/'((?:[^'\\\n]|\\.)*)'/g, (_m, t) => JSON.stringify(t.replace(/\\'/g, "'")))
        .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
        .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(json);
}

function readTree(){
    const files = {};
    for(const f of fs.readdirSync(MIG_DIR).filter((n) => n.endsWith('.sql'))) files[f] = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
    return files;
}

// Migration file names present at the merge-base of HEAD and `ref`.
function committedAtBase(ref){
    const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const rel = path.relative(git(['rev-parse', '--show-toplevel']), MIG_DIR).split(path.sep).join('/');
    let base = null;
    for(const r of [ref, 'origin/' + ref]){
        try { base = git(['merge-base', 'HEAD', r]); break; } catch(e){ /* try the next ref */ }
    }
    if(!base) throw new Error('base ' + ref + ': no merge-base with HEAD');
    return git(['ls-tree', '--name-only', base, rel + '/']).split('\n').map((n) => path.basename(n)).filter((n) => n.endsWith('.sql'));
}

function baseCommitted(argv){
    const bi = argv.indexOf('--base');
    const explicit = bi >= 0 && argv[bi + 1] && !argv[bi + 1].startsWith('--');
    try { return committedAtBase(explicit ? argv[bi + 1] : 'develop'); }
    catch(e){
        if(explicit) throw e;
        console.warn('merge-base compare skipped: ' + e.message);
        return [];
    }
}

function writeFixture(fixture){
    const sorted = {};
    for(const k of Object.keys(fixture).sort()) sorted[k] = fixture[k];
    fs.writeFileSync(FIXTURE, JSON.stringify(sorted, null, 2) + '\n');
}

function main(argv){
    const files   = readTree();
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const accept  = argv.flatMap((a, i) => (a === '--accept' ? [argv[i + 1]] : []));
    if(argv.includes('--add') || accept.length){
        const added = Object.keys(files).filter((f) => !fixture[f]);
        if(argv.includes('--add')) for(const f of added) fixture[f] = pinOf(files[f]);
        for(const f of accept){
            if(!files[f]) throw new Error('--accept ' + f + ': no such migration');
            console.warn('ACCEPTED a new pin for ' + f + ': legitimate only if no database has applied it.');
            fixture[f] = pinOf(files[f]);
        }
        writeFixture(fixture);
        console.log('pinned ' + (argv.includes('--add') ? added.length : 0) + ' new, accepted ' + accept.length +
            '. Next: node bin/lib/migration_residue_pin.js');
        return 0;
    }
    const committed = argv.includes('--no-base') ? [] : baseCommitted(argv);
    const bad = findViolations({ files, fixture, rebaselines: readRebaselines(), committed });
    for(const v of bad) console.log(v.kind + ': ' + v.message);
    const unpinned = Object.keys(files).filter((f) => !fixture[f]).length;
    console.log(bad.length + ' violation(s), ' + unpinned + ' unpinned file(s).' +
        (unpinned ? ' Next: node bin/lib/migration_residue_pin.js --add' : ''));
    return bad.length ? 1 : 0;
}

module.exports = { executableResidue, pinOf, findViolations, readTree, readRebaselines, stripComments, committedAtBase, FIXTURE };

if(require.main === module) process.exitCode = main(process.argv.slice(2));
