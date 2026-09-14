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
 * ACTION HANDLER SPELLINGS, shared by the replay verifiers under bin/.
 *
 * The file-size split gave the src/actions handlers a second spelling: the flat
 * src/actions/<name>.js became the directory src/actions/<name>/ (entry index.js, the
 * logic in parts beside it). A replay verifier reads handlers out of trees on either
 * side of that split, so every read here takes whichever spelling the tree carries.
 *
 *   verify-genesis-arm-replay-equivalence.js     handlerSources, relativeRequireTargets
 *   verify-batch-cost-weighting-replay-...js     handlerPaths, handlerFiles,
 *                                                layPreRefHandler, unaccountedHandlerCommits
 *
 * Shared here so both verifiers read a handler the same way, and so neither carries the
 * second spelling inline.
 *
 ********************************************************************/

'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { execSync, spawnSync } = require('child_process');

// The BATCH handler has two spellings across the trees the batch verifier reads: the flat
// src/actions/batch.js, and the directory src/actions/batch/ (entry index.js, one part per
// behaviour) that the file-size split gives it. Each leg below reads whichever spelling the
// tree in front of it carries - the old-side substitution, N4's commit walk, the reader
// check - so a --pre-ref on either side of the split still builds an old side that runs.
function handlerPaths(name) {
    return { flat: 'src/actions/' + name + '.js', dir: 'src/actions/' + name + '/' };
}

// The .js files of a directory-spelled handler, sorted; null when the path is not a
// directory, so a caller can tell "no directory" from "an empty one".
function dirFiles(dirAbs) {
    if (!(fs.existsSync(dirAbs) && fs.statSync(dirAbs).isDirectory())) return null;
    return fs.readdirSync(dirAbs).filter(f => f.endsWith('.js')).sort().map(f => path.join(dirAbs, f));
}

// Every source file of the handler in one tree, at BOTH spellings and sorted. Both rather
// than the newest present, because a caller reading the handler's text (does it name the
// flag?) must see all of it: on the old side the directory can hold a shim beside the
// pre-work flat file, and reading only the shim would answer about the shim.
function handlerFiles(treeDir, name) {
    const files = dirFiles(path.join(treeDir, 'src', 'actions', name)) || [];
    const flatAbs = path.join(treeDir, handlerPaths(name).flat);
    if (fs.existsSync(flatAbs)) files.push(flatAbs);
    return files;
}

// A handler is either src/actions/<name>.js or, once the file-size work split it,
// src/actions/<name>/ with the entry at index.js and the logic in parts beside it.
// Every file of it is read: reading index.js alone after a split would name no gate
// for a handler whose gate check moved into a part, and answer "reads nothing".
// The reader label is the one file, or the directory with a trailing slash; a tree with
// neither spelling returns reader null and no sources.
function handlerSources(treeDir, actionType) {
    const base  = path.join(treeDir, 'src', 'actions', String(actionType).toLowerCase());
    const files = dirFiles(base) || (fs.existsSync(base + '.js') ? [base + '.js'] : []);
    if (!files.length) return { reader: null, sources: [] };
    const reader = files.length === 1 ? path.relative(treeDir, files[0])
        : path.relative(treeDir, base) + '/';
    return { reader, sources: files.map(file => ({ file, text: fs.readFileSync(file, 'utf8') })) };
}

// The tree-relative targets of every relative require in one handler file, in source order.
// Resolved against the requiring file's own directory rather than assumed one level
// under src/, which is the assumption a part file two levels deep would break.
function relativeRequireTargets(treeDir, file, text) {
    const targets = [];
    for (const m of text.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
        let target = path.resolve(path.dirname(file), m[1]);
        if (!/\.js$/.test(target))
            target = fs.existsSync(target) && fs.statSync(target).isDirectory()
                ? path.join(target, 'index.js') : target + '.js';
        targets.push(path.relative(treeDir, target));
    }
    return targets;
}

// What the handler ADMITS, read out of one tree: its member names, its static keys, and the
// instance tables the constructor builds (the command limit, the weight budget, the per
// action weights, the per action caps, the FORMAT set). A split moves method bodies between
// files and rewrites the ones that now call a part, so bodies cannot say whether a split
// changed anything; these three do, because every admission decision this tool replays is
// taken against them. A declared relocation that moves one of them is not a relocation.
function handlerAdmissionSurface(treeDir, name) {
    const entry = fs.existsSync(path.join(treeDir, 'src', 'actions', name, 'index.js'))
        ? path.join(treeDir, 'src', 'actions', name, 'index.js')
        : path.join(treeDir, handlerPaths(name).flat);
    // The action object the loader hands the constructor. It is only stored, so identity is
    // all it needs; any method call on it is a change in the constructor and throws here.
    const reader = 'const H = require(' + JSON.stringify(entry) + ');'
        + 'const stub = { config: {}, decoderDb: {}, indexerDb: {}, util: {}, mapper: {},'
        + '               protocolChanges: {}, actionAliases: {} };'
        + 'const inst = new H(stub);'
        + 'const instance = {};'
        + 'for (const k of Object.keys(inst).sort())'
        + '  if (inst[k] !== stub) instance[k] = JSON.stringify(inst[k]) || String(inst[k]);'
        + 'process.stdout.write(JSON.stringify({'
        + '  members: Reflect.ownKeys(H.prototype).map(String).sort(),'
        + '  statics: Reflect.ownKeys(H).map(String).sort(), instance }));';
    const r = spawnSync(process.execPath, ['-e', reader], { cwd: treeDir, maxBuffer: 1024 * 1024 * 64 });
    if (r.status !== 0) throw new Error('cannot load the ' + name.toUpperCase() + ' handler in ' + treeDir + ': '
        + String(r.stderr).split('\n').slice(0, 3).join(' '));
    return r.stdout.toString();
}

// Materialize one commit's tree (archive only: no index or ref writes) with the repo's
// node_modules borrowed, so the handler can be loaded from it.
function archiveTree(repo, sha, dir) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    execSync('git archive ' + sha + ' | tar -x -C ' + JSON.stringify(dir), { cwd: repo });
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'));
    return dir;
}

// The machine half of a relocation declaration, and only that half. It checks the ONE thing
// a move must not do: change what the handler admits. The member names, the static keys and
// the instance tables the constructor builds (command limit, weight budget, per action
// weights and caps, FORMAT set) must be identical either side of the commit, so a "split"
// that retunes a weight is reported as unaccounted.
//
// What it does NOT prove, and what the reviewer's declaration is therefore still carrying:
// a rewritten method body that decides differently with the same tables. Declaring the
// behavioural commit 182f138f (a probe-path condition) as a relocation passes this check;
// it was run that way once to see that it does. So the verifier's RELOCATION_COMMITS list
// is a reviewed claim, backed here against table drift, not a substitute for reading the
// commits.
//
// Lines naming the flag are NOT a signal (a relocation moves the flag's reader like any
// other line); WHERE the flag is read is asserted separately, by the verifier's reader check.
function declaredRelocationTablesHold(repo, name, sha) {
    const base = path.join(os.tmpdir(), 'xchain-a6-reloc-' + sha.slice(0, 8));
    try {
        const before = handlerAdmissionSurface(archiveTree(repo, sha + '^', base + '-pre'), name);
        const after  = handlerAdmissionSurface(archiveTree(repo, sha, base + '-post'), name);
        return before === after;
    } catch (e) {
        return false;
    } finally {
        for (const d of [base + '-pre', base + '-post'])
            if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    }
}

// The old-side substitution into a tree already extracted at dir: HEAD's handler out,
// --pre-ref's handler in, at whichever spelling each carries.
function layPreRefHandler(repo, name, preRef, dir) {
    const { flat, dir: handlerDir } = handlerPaths(name);
    // Drop HEAD's handler whichever shape it has, then lay down --pre-ref's, so the old
    // side carries the pre-work handler and nothing of HEAD's.
    for (const abs of handlerFiles(dir, name)) fs.rmSync(abs);
    const preFiles = execSync('git ls-tree -r --name-only ' + JSON.stringify(preRef)
        + ' -- ' + flat + ' ' + handlerDir, { cwd: repo }).toString().split('\n').filter(Boolean);
    if (!preFiles.length)
        throw new Error(preRef + ' carries no ' + name.toUpperCase() + ' handler at either spelling');
    for (const rel of preFiles) {
        const pre = execSync('git show ' + JSON.stringify(preRef + ':' + rel),
            { cwd: repo, maxBuffer: 1024 * 1024 * 64 });
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), pre);
    }

    // HEAD's loader and suites name the spelling HEAD uses. When --pre-ref is on the other
    // side of the split, one shim keeps that require path resolving to the pre-work code:
    // without it the old side would fail to load rather than replay the old behaviour.
    const flatOnly = preFiles.length === 1 && preFiles[0] === flat;
    if (flatOnly && !fs.existsSync(path.join(dir, 'src', 'actions', name, 'index.js'))) {
        fs.mkdirSync(path.join(dir, 'src', 'actions', name), { recursive: true });
        fs.writeFileSync(path.join(dir, 'src', 'actions', name, 'index.js'),
            "// OLD side only: --pre-ref predates the handler split, so the directory entry HEAD\n"
            + "// requires resolves to the pre-work flat handler beside it.\n"
            + "module.exports = require('../" + name + ".js');\n");
    }
}

// N4. Every commit touching src/actions/batch.js between preRef and HEAD must be a
// declared weighting commit or comment-only in that file. Returns the offenders, so a
// caller can name them rather than just refuse.
function unaccountedHandlerCommits(repo, name, preRef, weightingCommits, relocationCommits) {
    const { flat, dir } = handlerPaths(name);
    const declared = new Set(weightingCommits.map(
        s => execSync('git rev-parse ' + JSON.stringify(s), { cwd: repo }).toString().trim()));
    const relocationDeclared = new Set(relocationCommits.map(
        s => execSync('git rev-parse ' + JSON.stringify(s), { cwd: repo }).toString().trim()));
    const shas = execSync('git log --format=%H ' + JSON.stringify(preRef) + '..HEAD -- '
        + flat + ' ' + dir, { cwd: repo }).toString().trim().split('\n').filter(Boolean);
    const offenders = [];
    let relocations = 0;
    for (const sha of shas) {
        if (declared.has(sha)) continue;
        const diff = execSync('git show ' + sha + ' -- ' + flat + ' ' + dir,
            { cwd: repo, maxBuffer: 1024 * 1024 * 64 }).toString();
        const changed = diff.split('\n')
            .filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
            .map(l => l.slice(1).trim());
        // A comment-only commit moves nothing the parser sees. Anything else is a
        // behavioural change the substitution would silently roll back too.
        const code = changed.filter(l => l !== '' && !/^(\/\/|\*|\/\*)/.test(l));
        if (!code.length) continue;
        // A commit that moved the handler between its flat file and its directory rewrites
        // every line it touches while deciding nothing differently, so the line read above
        // cannot judge it. Such a commit is DECLARED below and then checked: its admission
        // surface must be identical either side, or it counts as an offender.
        if (relocationDeclared.has(sha) && declaredRelocationTablesHold(repo, name, sha)) { relocations++; continue; }
        offenders.push({ sha: sha.slice(0, 8), codeLines: code.length, sample: code[0].slice(0, 80) });
    }
    return { total: shas.length, declared: declared.size, relocations, offenders };
}

module.exports = {
    handlerPaths, handlerFiles, handlerSources, relativeRequireTargets,
    layPreRefHandler, unaccountedHandlerCommits,
};
