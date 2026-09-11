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
 * FROM-GENESIS REPLAY WITNESS for the MAINNET GENESIS ARM.
 *
 * WHY THIS EXISTS. The genesis arm moves every mainnet consensus gate that was
 * measured identity on the indexed mainnet history from an inert placeholder to
 * genesis (0), in one commit per repo. "Identity" was measured by counting action
 * types, then argued gate by gate. This tool is the evidence that the argument
 * holds when the gates actually run: the SAME mainnet corpus is replayed from its
 * first block by the pre-arm code and by the armed code, and the consensus hash
 * chain must agree at every block. It is the acceptance for the replay-witness
 * milestone, and it is the last gate before the arm ships, so it has to be driven.
 *
 * ------------------------------------------------------------------------------
 * THE TWO SIDES
 *
 *   OLD  - HEAD's tree with the arm commit's hunks REVERTED, file by file, by a
 *          three-way merge (current = HEAD's file, base = the arm's version of it,
 *          other = the arm's parent's version). This is HEAD with exactly the arm
 *          removed and nothing else: every commit that landed on the same files
 *          after the arm stays in place on both sides and cancels out.
 *   ON   - HEAD as shipped, arm live.
 *
 * WHY A REVERT AND NOT A WHOLE OLD TREE OR A FILE SWAP. The predecessor witness
 * for BATCH_COST_WEIGHTING swaps ONE file to its pre-work version, which is exact
 * only while no later commit touched that file. The arm touches the activation
 * maps across more than thirty files, and later commits have already landed on
 * some of them, so a file swap would silently roll those back too and the
 * comparison would be about something else. The revert keeps them. Its exactness
 * is asserted, not assumed (N4 below).
 *
 * The indexer loads xchain-vm in-process, and the vm carries its own copy of the
 * armed maps (the exec-lint gate). The OLD side therefore also runs a reverted
 * vm tree; the ON side runs the vm's HEAD. Copies of the maps in repos this
 * process never loads (hub, sync, decoder, sdk, documentation) are byte-identical
 * twins by the arm's own CI gates and are NOT exercised here.
 *
 * WHY GENESIS GOES THROUGH THE PIPELINE. The indexer can bulk-import a
 * precomputed genesis state dump instead of re-deriving the ~124k synthetic
 * ISSUEs through the action handlers. An import runs no gate, so a witness that
 * took it would compare two identical imports and call the arm identity over a
 * history it never replayed. Both sides here are forced onto the CSV path (the
 * dump path is pointed at a file that does not exist, and the side proves it),
 * so every genesis action is judged by the real handlers under each side's maps.
 *
 * ------------------------------------------------------------------------------
 * THE REFUSAL CLAUSE, which matters more here than the assertion
 *
 * Mainnet history is a genesis allocation plus a few dozen organic transactions,
 * so a correct run of this witness legitimately looks like it measured almost
 * nothing, and that is exactly the shape that fools a reader: a replay that
 * silently imported genesis, or started past it, or ran a corpus with no actions,
 * reports IDENTICAL with the same tally line as a real pass. So this tool never
 * prints a bare green. It exits NON-ZERO WITH A NAMED REASON when its own
 * preconditions are unmet, and it always prints the replayed action count against
 * the action count the fleet actually indexed (--indexed-db), refusing when the
 * replay reproduced less than --min-replay-fraction of it.
 *
 *   exit 0  every assertion holds AND the run measured the indexed history
 *   exit 1  an assertion failed: the sides diverge (block, field and the rows that
 *           moved are printed, with the gates the divergent action's handler reads)
 *   exit 2  REFUSED: a precondition is unmet; the reason is named on the last line
 *   exit 3  VACUOUS: the corpus carries no actions on either side, so nothing was
 *           measured (the expected result for a chain with no mainnet history)
 *
 * ------------------------------------------------------------------------------
 * NEGATIVE CONTROLS
 *
 *   N1. GATE STATE IS PROVEN PER SIDE. Each side reports every registry gate's
 *       mainnet instant as ITS OWN ProtocolChanges registered it, plus the
 *       armed-map fingerprint of the tree it ran from. The parent lists the
 *       registry constants and the map keys that moved, and asserts that every
 *       one reads 0 on ON (1786060800 for ORACLE_FEE_SET_CAPTURE, its base gate's
 *       instant) and an inert value on OLD. A run where nothing moved is refused.
 *   N2. THE HARNESS DETECTS DIVERGENCE. The comparator is the integration tier's
 *       own hash-chain and strict table oracle, the one that fails on a fork.
 *   N3. THE SIDES ARE THE SAME HARNESS. The launcher, the db module, the
 *       equivalence oracle, genesis.js and package.json are byte-identical in
 *       both trees.
 *   N4. THE REVERT IS EXACT. For every reverted file, the code-line delta between
 *       the two trees equals the arm commit's own code-line delta for that file.
 *       A conflict on code lines refuses the run naming the file; a conflict on
 *       comment lines only is resolved to HEAD's comment (comments move nothing
 *       the parser sees).
 *
 * Alongside the OLD-vs-ON assertion the ON chain is also compared against the
 * hash chain the fleet actually wrote (--indexed-db). That is reported as a
 * measurement, not asserted: the fleet's history was written by many releases,
 * so a difference there is a finding for the operator, not a verdict on the arm.
 *
 * READ-ONLY WITH RESPECT TO THE REPOSITORIES. Both trees are materialized with
 * `git archive` into a temp dir. The tool writes only to its own throwaway
 * schemas and never to --decoder-db or --indexed-db.
 *
 * USAGE
 *   node bin/verify-genesis-arm-replay-equivalence.js \
 *        --coin BTC --network mainnet \
 *        --decoder-db ga_witness_btc_dec --indexed-db ga_witness_btc_idx
 *
 * Options: --arm-ref <sha> (default d362079e), --vm-arm-ref <sha> (default
 * b86aa1a8, --no-vm skips the vm revert), --vm-root <dir> (default the file:
 * dependency), --min-replay-fraction <0..1> (default 0.99), --serial (run the
 * sides one after the other), --dry-run (build and prove the trees, replay
 * nothing, exit 2), --keep, --workdir <dir>.
 *
 * Needs a MariaDB the user may CREATE schemas on: TEST_DB_HOST TEST_DB_PORT
 * TEST_DB_USER TEST_DB_PASS (fall back to .env INDEXER_DB_*), and TEST_DB_NS for
 * the throwaway schema prefix (default ga_witness_replay_<coin>).
 *
 *********************************************************************/

'use strict';

const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');
const { execSync, spawn, spawnSync } = require('child_process');

const REPO      = path.resolve(__dirname, '..');
const SIDE_MARK = '###GA-SIDE###';

// The house sentinels: the registry's UNARMED instant and the maps' INERT height.
const UNARMED = 9999999999;
const INERT   = 999999999;
// What an armed mainnet value may read on ON. 1786060800 is ORACLE_FEE_SET_CAPTURE's
// base gate instant (the decoder conformance suite refuses anything below it).
const ARMED_OK = new Set(['0', '1786060800']);
// What a mainnet value may read on OLD for a key the arm moved.
const INERT_OK = new Set([String(UNARMED), String(INERT), 'null']);

const EXIT = { PASS: 0, FAIL: 1, REFUSED: 2, VACUOUS: 3 };

let failures = 0;

if (process.argv.includes('--side')) {
    runSide().catch(e => { console.error('SIDE ERROR: ' + (e && e.stack || e)); process.exit(1); });
} else {
    main().catch(e => { console.error('ERR ' + (e && e.stack || e)); process.exit(EXIT.REFUSED); });
}

// ---------------------------------------------------------------------------
// CHILD MODE: index the shared decoder corpus with ONE side's tree.
// ---------------------------------------------------------------------------

async function runSide() {
    const root = process.env.GA_SIDE_ROOT;
    const key  = process.env.GA_SIDE_KEY;

    // The genesis dump path is pointed at nothing so genesis.js takes the CSV path
    // and every synthetic action goes through the handlers. Proven, not assumed.
    if (!process.env.GENESIS_DUMP_PATH || fs.existsSync(process.env.GENESIS_DUMP_PATH))
        throw new Error('GENESIS_DUMP_PATH must name a file that does not exist (got ' +
                        process.env.GENESIS_DUMP_PATH + ')');

    const launcher = require(path.join(root, 'test', 'integration', 'setup', 'indexer-launcher.js'));
    const indexer  = await launcher.initIndexer();
    const cfg      = indexer.config;

    const genesis = {
        block:      Number(cfg['GENESIS_BLOCK']),
        ledgerHash: cfg['GENESIS_LEDGER_HASH'] || null,
        ledgerPath: cfg['GENESIS_LEDGER_PATH'],
        ledgerPathExists: fs.existsSync(cfg['GENESIS_LEDGER_PATH']),
        dumpPath:   cfg['GENESIS_DUMP_PATH'],
        dumpExists: fs.existsSync(cfg['GENESIS_DUMP_PATH']),
    };

    // N1: the registry exactly as THIS side's ProtocolChanges registered it.
    const registry = {};
    for (const [name, c] of Object.entries(indexer.protocolChanges.changes || {}))
        registry[name] = { mainnet: Number(c.mainnet_time), testnet: Number(c.testnet_time),
                           regtest: Number(c.regtest_time) };

    const fp = require(path.join(root, 'src', 'armedMapFingerprint.js')).computeArmedMapFingerprint();

    // Which vm this process actually loaded, and the bytes of its entry module.
    const vmMain = require.resolve('xchain-vm', { paths: [root] });
    const vm = { main: vmMain, sha256: sha256File(vmMain) };

    // Progress to stderr (the parent streams it to a per-side log), so a long
    // genesis block and a long tail are both visible while they run.
    const t0 = Date.now();
    let done = 0;
    const realCreateBlock = indexer.indexerDb.createBlock.bind(indexer.indexerDb);
    indexer.indexerDb.createBlock = async function (blockIndex, blockTime) {
        const r = await realCreateBlock(blockIndex, blockTime);
        done++;
        if (done === 1 || done % 2000 === 0)
            console.error('[' + key + '] block ' + blockIndex + ' (' + done + ' done, ' +
                          ((Date.now() - t0) / 1000).toFixed(0) + 's)');
        return r;
    };

    const blocks = await launcher.processBlocks(indexer);
    const ms = Date.now() - t0;
    await launcher.destroyIndexer(indexer);

    console.log(SIDE_MARK + JSON.stringify({ key, blocks, ms, genesis, registry, fingerprint: fp, vm }));
    process.exit(0);
}

// ---------------------------------------------------------------------------
// PARENT
// ---------------------------------------------------------------------------

function check(ok, label, detail) {
    console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '\n          ' + detail : ''));
    if (!ok) failures++;
    return ok;
}
function info(msg) { console.log('  ....  ' + msg); }
function section(title) { console.log('\n== ' + title + ' ' + '='.repeat(Math.max(0, 68 - title.length))); }

// A named refusal is the whole point: the last line says why, and the exit code
// says it was not a verdict.
function refuse(reason) {
    console.log('\nREFUSED: ' + reason);
    process.exit(EXIT.REFUSED);
}

function parseArgs() {
    const a = process.argv.slice(2);
    const o = { coin: 'BTC', network: 'mainnet', decoderDb: null, indexedDb: null,
                armRef: 'd362079e', vmArmRef: 'b86aa1a8', vmRoot: null, noVm: false,
                minFraction: 0.99, keep: false, serial: false, workdir: null };
    for (let i = 0; i < a.length; i++) {
        switch (a[i]) {
            case '--coin':        o.coin = a[++i]; break;
            case '--network':     o.network = a[++i]; break;
            case '--decoder-db':  o.decoderDb = a[++i]; break;
            case '--indexed-db':  o.indexedDb = a[++i]; break;
            case '--arm-ref':     o.armRef = a[++i]; break;
            case '--vm-arm-ref':  o.vmArmRef = a[++i]; break;
            case '--vm-root':     o.vmRoot = a[++i]; break;
            case '--no-vm':       o.noVm = true; break;
            case '--min-replay-fraction': o.minFraction = Number(a[++i]); break;
            case '--keep':        o.keep = true; break;
            case '--serial':      o.serial = true; break;
            case '--dry-run':     o.dryRun = true; break;
            case '--workdir':     o.workdir = a[++i]; break;
            case '--help': case '-h':
                console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
                process.exit(0);
                break;
            default: console.error('unknown arg: ' + a[i]); process.exit(64);
        }
    }
    if (!o.decoderDb) { console.error('--decoder-db <schema> is required'); process.exit(64); }
    if (!o.indexedDb) {
        console.error('--indexed-db <schema> is required: without the fleet\'s indexed action count ' +
                      'the replayed count cannot be judged, and a bare green is what this tool refuses to print');
        process.exit(64);
    }
    if (!(o.minFraction >= 0 && o.minFraction <= 1)) { console.error('--min-replay-fraction must be 0..1'); process.exit(64); }
    return o;
}

// --- git helpers --------------------------------------------------------------

function git(cwd, args, opts) {
    return execSync('git ' + args, Object.assign({ cwd, maxBuffer: 1024 * 1024 * 256 }, opts || {})).toString();
}
function gitTry(cwd, args) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 256 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sha256File(p) {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function isCommentLine(l) {
    const t = l.trim();
    return t === '' || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

// Code lines of a unified diff, sign-separated and trimmed, comments dropped.
function codeDelta(diffText) {
    const plus = [], minus = [];
    for (const l of diffText.split('\n')) {
        if (/^(\+\+\+|---)/.test(l)) continue;
        if (l[0] === '+' && !isCommentLine(l.slice(1))) plus.push(l.slice(1).trim());
        else if (l[0] === '-' && !isCommentLine(l.slice(1))) minus.push(l.slice(1).trim());
    }
    return { plus: plus.sort(), minus: minus.sort() };
}

// --- old tree ---------------------------------------------------------------

function archiveTree(repo, ref, dir) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    execSync('git archive ' + JSON.stringify(ref) + ' | tar -x -C ' + JSON.stringify(dir), { cwd: repo });
}

// Resolve merge-file conflict blocks: keep HEAD's side when BOTH sides of every
// block are comment lines only; refuse (return null) when any block has code.
function resolveCommentConflicts(text, file) {
    const out = [];
    const lines = text.split('\n');
    let i = 0;
    const codeConflicts = [];
    while (i < lines.length) {
        if (lines[i].startsWith('<<<<<<< ')) {
            const cur = [], other = [];
            i++;
            while (i < lines.length && !lines[i].startsWith('=======')) cur.push(lines[i++]);
            i++; // =======
            while (i < lines.length && !lines[i].startsWith('>>>>>>> ')) other.push(lines[i++]);
            i++; // >>>>>>>
            const codeCur = cur.filter(l => !isCommentLine(l));
            const codeOther = other.filter(l => !isCommentLine(l));
            if (codeCur.length || codeOther.length)
                codeConflicts.push({ file, cur: codeCur.slice(0, 3), other: codeOther.slice(0, 3) });
            out.push(...cur);
        } else {
            out.push(lines[i++]);
        }
    }
    return { text: out.join('\n'), codeConflicts };
}

// Revert ONE commit's src/ hunks onto an archived HEAD tree, three-way per file,
// and prove the result differs from HEAD by exactly that commit's code lines.
function revertCommitOnto(repo, ref, headRef, treeDir, tmpDir) {
    const files = git(repo, 'show --name-only --format= ' + JSON.stringify(ref) + ' -- src/')
        .split('\n').map(s => s.trim()).filter(Boolean);
    const report = { files: [], commentResolved: [], problems: [] };
    fs.mkdirSync(tmpDir, { recursive: true });
    for (const f of files) {
        const target = path.join(treeDir, f);
        if (!fs.existsSync(target)) { report.problems.push(f + ': not in HEAD tree'); continue; }
        const base = gitTry(repo, ['show', ref + ':' + f]);
        const pre  = gitTry(repo, ['show', ref + '^:' + f]);
        if (base.status !== 0 || pre.status !== 0) { report.problems.push(f + ': the arm added or removed this file'); continue; }
        const curP = path.join(tmpDir, 'cur'), baseP = path.join(tmpDir, 'base'), preP = path.join(tmpDir, 'pre');
        fs.writeFileSync(curP, fs.readFileSync(target));
        fs.writeFileSync(baseP, base.stdout);
        fs.writeFileSync(preP, pre.stdout);
        const m = spawnSync('git', ['merge-file', '-p', curP, baseP, preP], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
        if (m.status < 0 || m.status === null) { report.problems.push(f + ': merge-file error ' + m.stderr); continue; }
        let merged = m.stdout;
        if (m.status > 0) {
            const r = resolveCommentConflicts(merged, f);
            if (r.codeConflicts.length) {
                report.problems.push(f + ': code-line conflict with a later commit ' + JSON.stringify(r.codeConflicts[0]));
                continue;
            }
            merged = r.text;
            report.commentResolved.push(f + ' (' + m.status + ' comment-only block' + (m.status > 1 ? 's' : '') + ')');
        }
        fs.writeFileSync(target, merged);

        // N4: HEAD -> OLD must be exactly the arm's hunks reversed, code lines only.
        const oldP = path.join(tmpDir, 'old');
        fs.writeFileSync(oldP, merged);
        const d = spawnSync('git', ['diff', '--no-index', '--', curP, oldP], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
        const got = codeDelta(d.stdout || '');
        const arm = codeDelta(git(repo, 'show ' + JSON.stringify(ref) + ' -- ' + JSON.stringify(f)));
        // Going HEAD -> OLD, the arm's added lines are removed and its removed lines return.
        const exact = JSON.stringify(got.minus) === JSON.stringify(arm.plus) &&
                      JSON.stringify(got.plus) === JSON.stringify(arm.minus);
        if (!exact)
            report.problems.push(f + ': the revert is not exactly the arm (HEAD->OLD removes ' + got.minus.length +
                                 '/adds ' + got.plus.length + ' code lines; the arm added ' + arm.plus.length +
                                 '/removed ' + arm.minus.length + ')');
        report.files.push({ file: f, codeLines: arm.plus.length + arm.minus.length });
    }
    return report;
}

// A node_modules for a materialized tree: every entry of the real one, symlinked,
// except the packages named in `overrides`, which point at their own trees.
function wireNodeModules(treeDir, realNodeModules, overrides) {
    const nm = path.join(treeDir, 'node_modules');
    fs.mkdirSync(nm);
    for (const entry of fs.readdirSync(realNodeModules)) {
        const target = overrides[entry] || path.join(realNodeModules, entry);
        fs.symlinkSync(target, path.join(nm, entry));
    }
}

// The mainnet map keys a file carries, keyed by the line's key text. Comments are
// skipped and a trailing comment is stripped, so `'BTC:mainnet': 0, // note` reads 0.
function mainnetKeys(text) {
    const out = {};
    let n = 0;
    for (const raw of text.split('\n')) {
        n++;
        if (isCommentLine(raw)) continue;
        const m = raw.match(/^\s*(['"]?[A-Z]*:?mainnet['"]?)\s*:\s*([^,\s\/]+)/);
        if (!m) continue;
        const key = m[1].replace(/['"]/g, '');
        out[key + '@' + n] = { key, value: m[2] };
    }
    return out;
}

// Map keys whose value differs between two versions of a file, matched by key AND
// occurrence number (several maps in one file share the key text), so a key the
// arm inserted cannot shift every later key onto the wrong partner.
function movedMapKeys(onText, oldText) {
    const byOccurrence = t => {
        const seen = {}, out = {};
        for (const e of Object.values(mainnetKeys(t))) {
            seen[e.key] = (seen[e.key] || 0) + 1;
            out[e.key + '#' + seen[e.key]] = e.value;
        }
        return out;
    };
    const a = byOccurrence(onText), b = byOccurrence(oldText);
    const moved = [];
    for (const k of Object.keys(a))
        if (b[k] !== undefined && a[k] !== b[k])
            moved.push({ key: k.replace(/#\d+$/, ''), on: a[k], old: b[k] });
    return { moved, countOn: Object.keys(a).length, countOld: Object.keys(b).length };
}

// --- db ---------------------------------------------------------------------

function dbParams() {
    const envVars = {};
    const envPath = path.join(REPO, '.env');
    if (fs.existsSync(envPath))
        for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
            const m = line.match(/^\s*([\w]+)\s*=\s*(.*)$/);
            if (m) envVars[m[1]] = m[2].trim();
        }
    return {
        host: process.env.TEST_DB_HOST || envVars.INDEXER_DB_HOST || '127.0.0.1',
        port: parseInt(process.env.TEST_DB_PORT || envVars.INDEXER_DB_PORT || '3306'),
        user: process.env.TEST_DB_USER || envVars.INDEXER_DB_USER || 'root',
        pass: process.env.TEST_DB_PASS || envVars.INDEXER_DB_PASS || '',
    };
}

async function connect(p, database) {
    const mariadb = require('mariadb');
    return mariadb.createConnection({
        host: p.host, port: p.port, user: p.user, password: p.pass,
        database, insertIdAsNumber: true, multipleStatements: true, connectTimeout: 10000,
    });
}
function queryFnFor(conn) { return (sql, args) => conn.query(sql, args); }

async function schemaExists(admin, name) {
    const r = await admin.query('SELECT COUNT(*) n FROM information_schema.schemata WHERE schema_name = ?', [name]);
    return Number(r[0].n) > 0;
}
async function tableExists(q, table) {
    const r = await q('SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [table]);
    return Number(r[0].n) > 0;
}
async function countRows(q, table) {
    const rows = await q('SELECT COUNT(*) AS n FROM `' + table + '`');
    return Number(rows[0].n);
}
async function actionsByType(q) {
    const rows = await q('SELECT ia.action, COUNT(*) n FROM actions a JOIN index_actions ia ON ia.id = a.action_id GROUP BY ia.action ORDER BY n DESC');
    const out = {};
    for (const r of rows) out[String(r.action)] = Number(r.n);
    return out;
}
async function blockRange(q) {
    const r = await q('SELECT MIN(block_index) lo, MAX(block_index) hi, COUNT(*) n FROM blocks');
    return { lo: r[0].lo === null ? null : Number(r[0].lo), hi: r[0].hi === null ? null : Number(r[0].hi), n: Number(r[0].n) };
}

// --- comparison -------------------------------------------------------------

function diffStates(stateA, stateB) {
    const tables = Array.from(new Set(Object.keys(stateA).concat(Object.keys(stateB)))).sort();
    const out = [];
    for (const t of tables) {
        const a = stateA[t] || [], b = stateB[t] || [];
        if (a.length === b.length && a.every((r, i) => r === b[i])) continue;
        const setA = new Set(a), setB = new Set(b);
        out.push({ table: t, aRows: a.length, bRows: b.length,
                   onlyA: a.filter(r => !setB.has(r)).length,
                   onlyB: b.filter(r => !setA.has(r)).length });
    }
    return out;
}

function firstDivergence(chainA, chainB) {
    const len = Math.min(chainA.length, chainB.length);
    for (let i = 0; i < len; i++) {
        if (chainA[i].block_index !== chainB[i].block_index)
            return { block: chainA[i].block_index, field: 'sequence', a: chainA[i].block_index, b: chainB[i].block_index };
        for (const f of ['ledger', 'actions', 'contracts', 'state'])
            if (chainA[i][f] !== chainB[i][f])
                return { block: chainA[i].block_index, field: f,
                         a: String(chainA[i][f]).slice(0, 16), b: String(chainB[i][f]).slice(0, 16) };
    }
    if (chainA.length !== chainB.length)
        return { block: null, field: 'length', a: chainA.length, b: chainB.length };
    return null;
}

// Every row of every block-indexed table at ONE block, canonicalized the way the
// equivalence oracle does it, so the rows that moved at the fork can be named.
async function rowsAtBlock(q, block) {
    const tables = await q('SELECT table_name t FROM information_schema.columns WHERE table_schema = DATABASE() AND column_name = ? ORDER BY table_name', ['block_index']);
    const out = {};
    for (const r of tables) {
        const t = String(r.t);
        const rows = await q('SELECT * FROM `' + t + '` WHERE block_index = ?', [block]);
        out[t] = rows.map(row => {
            const o = {};
            for (const k of Object.keys(row).sort()) {
                if (['created_at', 'created', 'updated', 'logged_at', 'time'].includes(k)) continue;
                let v = row[k];
                if (Buffer.isBuffer(v)) v = '0x' + v.toString('hex');
                else if (typeof v === 'bigint') v = v.toString();
                else if (v instanceof Date) v = v.toISOString();
                o[k] = v;
            }
            return JSON.stringify(o);
        }).sort();
    }
    return out;
}

// The gates a handler consults, restricted to what the arm moved: registry names
// it asks isEnabled about, and arm-touched modules it requires. Naming the gate
// from the divergent action's own reader is what makes a red run actionable.
function gatesReadBy(treeDir, actionType, movedRegistry, armFiles) {
    const reader = path.join(treeDir, 'src', 'actions', String(actionType).toLowerCase() + '.js');
    if (!fs.existsSync(reader)) return { reader: null, registry: [], modules: [] };
    const text = fs.readFileSync(reader, 'utf8');
    const registry = new Set(), modules = new Set();
    for (const m of text.matchAll(/isEnabled\(\s*['"]([A-Z0-9_]+)['"]/g))
        if (movedRegistry.has(m[1])) registry.add(m[1]);
    for (const m of text.matchAll(/require\(\s*['"]\.\.?\/([\w\/.-]+?)(?:\.js)?['"]\s*\)/g)) {
        const rel = ('src/' + m[1] + '.js').replace('src/../', '');
        if (armFiles.has(rel)) modules.add(rel);
    }
    return { reader: path.relative(treeDir, reader), registry: Array.from(registry), modules: Array.from(modules) };
}

// --- sides ------------------------------------------------------------------

function runSideProcess(side, env, logPath) {
    return new Promise(resolve => {
        const log = fs.createWriteStream(logPath);
        const child = spawn(process.execPath, [__filename, '--side'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        child.stdout.on('data', d => { stdout += d; log.write(d); });
        child.stderr.on('data', d => log.write(d));
        child.on('close', status => { log.end(); resolve({ side, status, stdout }); });
    });
}

// --- main -------------------------------------------------------------------

async function main() {
    const opts = parseArgs();
    const p    = dbParams();
    const NS   = process.env.TEST_DB_NS || ('ga_witness_replay_' + opts.coin.toLowerCase());
    const DB   = { OLD: NS + '_old', ON: NS + '_on' };
    const head = git(REPO, 'rev-parse HEAD').trim();

    console.log('# from-genesis replay witness for the mainnet genesis arm');
    console.log('# indexer HEAD ' + head.slice(0, 12) + '   arm ' + opts.armRef +
                '   chain ' + opts.coin + '/' + opts.network);
    console.log('# decoder corpus ' + opts.decoderDb + '   indexed reference ' + opts.indexedDb);
    console.log('# db ' + p.user + '@' + p.host + ':' + p.port + '   schemas ' + Object.values(DB).join(', '));

    // ---- preconditions on the refs ----------------------------------------
    section('preconditions: refs');
    const armFull = gitTry(REPO, ['rev-parse', '--verify', opts.armRef + '^{commit}']);
    if (armFull.status !== 0) refuse('arm ref ' + opts.armRef + ' does not resolve in ' + REPO);
    if (gitTry(REPO, ['merge-base', '--is-ancestor', opts.armRef, 'HEAD']).status !== 0)
        refuse('arm ref ' + opts.armRef + ' is not an ancestor of HEAD: this tree does not carry the arm, so there is nothing to witness');
    info('arm commit ' + git(REPO, 'log -1 --format=%h\\ %s ' + opts.armRef).trim());
    const dirty = git(REPO, 'status --porcelain').split('\n').filter(Boolean).length;
    info('working tree: ' + dirty + ' modified path(s); both sides are built from the HEAD archive, not the working tree');

    let vmRoot = null;
    if (!opts.noVm) {
        vmRoot = opts.vmRoot ? path.resolve(opts.vmRoot) : fs.realpathSync(path.join(REPO, 'node_modules', 'xchain-vm'));
        if (!fs.existsSync(path.join(vmRoot, '.git')))
            refuse('vm root ' + vmRoot + ' is not a git checkout; pass --vm-root or --no-vm');
        if (gitTry(vmRoot, ['rev-parse', '--verify', opts.vmArmRef + '^{commit}']).status !== 0)
            refuse('vm arm ref ' + opts.vmArmRef + ' does not resolve in ' + vmRoot);
        if (gitTry(vmRoot, ['merge-base', '--is-ancestor', opts.vmArmRef, 'HEAD']).status !== 0)
            refuse('vm arm ref ' + opts.vmArmRef + ' is not an ancestor of the vm HEAD');
        info('vm ' + vmRoot + ' HEAD ' + git(vmRoot, 'rev-parse --short HEAD').trim() +
             ', arm ' + git(vmRoot, 'log -1 --format=%h\\ %s ' + opts.vmArmRef).trim());
    } else {
        info('vm revert skipped (--no-vm): the vm-side maps run armed on BOTH sides');
    }

    // ---- preconditions on the corpus ---------------------------------------
    section('preconditions: corpus');
    const admin = await connect(p, undefined);
    if (!await schemaExists(admin, opts.decoderDb)) refuse('decoder schema ' + opts.decoderDb + ' does not exist');
    if (!await schemaExists(admin, opts.indexedDb)) refuse('indexed reference schema ' + opts.indexedDb + ' does not exist');

    const dec = await connect(p, opts.decoderDb);
    const qDec = queryFnFor(dec);
    if (!await tableExists(qDec, 'blocks') || !await tableExists(qDec, 'transactions'))
        refuse('decoder schema ' + opts.decoderDb + ' has no blocks/transactions tables');
    const decRange = await blockRange(qDec);
    const decTx = await countRows(qDec, 'transactions');
    const decTypes = {};
    for (const r of await qDec("SELECT UPPER(SUBSTRING_INDEX(data, '|', 1)) t, COUNT(*) n FROM transactions GROUP BY t ORDER BY n DESC"))
        decTypes[String(r.t)] = Number(r.n);
    await dec.end();
    info('decoder corpus: blocks ' + decRange.lo + '..' + decRange.hi + ' (' + decRange.n + '), ' +
         decTx + ' transactions ' + JSON.stringify(decTypes));
    if (decRange.n === 0) refuse('decoder corpus ' + opts.decoderDb + ' holds no blocks');

    const ref = await connect(p, opts.indexedDb);
    const qRef = queryFnFor(ref);
    if (!await tableExists(qRef, 'actions') || !await tableExists(qRef, 'blocks'))
        refuse('indexed reference schema ' + opts.indexedDb + ' has no actions/blocks tables');
    const refRange = await blockRange(qRef);
    const refActions = await countRows(qRef, 'actions');
    const refTypes = await actionsByType(qRef);
    info('indexed reference: blocks ' + refRange.lo + '..' + refRange.hi + ' (' + refRange.n + '), ' +
         refActions + ' actions ' + JSON.stringify(refTypes));

    // The genesis block this chain bootstraps at, from the same config the sides
    // will load. The replay must START there or the genesis allocation is never
    // derived and the run compares two empty ledgers.
    let genesisBlock;
    try {
        const cfg = require(path.join(REPO, 'src', 'config.js')).getConfig(opts.coin, opts.network);
        genesisBlock = Number(cfg['GENESIS_BLOCK']);
        info('config: GENESIS_BLOCK ' + genesisBlock + ', ledger manifest ' +
             (cfg['GENESIS_LEDGER_HASH'] ? 'pinned ' + String(cfg['GENESIS_LEDGER_HASH']).slice(0, 12) + '...' : 'NOT pinned') +
             ', dump bundled: ' + fs.existsSync(cfg['GENESIS_DUMP_PATH']));
    } catch (e) {
        refuse('cannot load the ' + opts.coin + '/' + opts.network + ' config: ' + e.message);
    }
    const genesisConfigured = genesisBlock > 0;
    if (genesisConfigured && decRange.lo !== genesisBlock)
        refuse('decoder corpus starts at ' + decRange.lo + ' but this chain bootstraps its genesis ledger at ' +
               genesisBlock + '; a replay from here would skip the allocation the gates are being asked about');
    if (!genesisConfigured)
        info('no genesis bootstrap on ' + opts.coin + '/' + opts.network + ' (GENESIS_BLOCK 0): the corpus is the whole history');
    if (refRange.lo !== decRange.lo)
        refuse('the indexed reference starts at ' + refRange.lo + ' and the decoder corpus at ' + decRange.lo + '; they are not the same history');

    // ---- trees -------------------------------------------------------------
    section('trees: ON = HEAD archive, OLD = HEAD archive with the arm reverted');
    const workdir = opts.workdir ? path.resolve(opts.workdir)
                                 : path.join(os.tmpdir(), 'xchain-ga-witness-' + opts.coin.toLowerCase());
    if (fs.existsSync(workdir)) fs.rmSync(workdir, { recursive: true, force: true });
    fs.mkdirSync(workdir, { recursive: true });
    const T = { on: path.join(workdir, 'indexer-on'), old: path.join(workdir, 'indexer-old'),
                vmOn: path.join(workdir, 'vm-on'), vmOld: path.join(workdir, 'vm-old') };
    archiveTree(REPO, 'HEAD', T.on);
    archiveTree(REPO, 'HEAD', T.old);
    const rev = revertCommitOnto(REPO, opts.armRef, 'HEAD', T.old, path.join(workdir, 'tmp'));
    for (const r of rev.commentResolved) info('comment-only conflict resolved to HEAD: ' + r);
    if (rev.problems.length) {
        for (const pr of rev.problems) console.log('  FAIL  ' + pr);
        refuse('the OLD tree cannot be built as exactly HEAD-minus-the-arm (' + rev.problems.length + ' file(s) above)');
    }
    const armFiles = new Set(rev.files.map(f => f.file));
    check(rev.files.length > 0, 'N4 the arm reverted file by file, each revert exactly the arm\'s code lines',
          rev.files.length + ' files, ' + rev.files.reduce((n, f) => n + f.codeLines, 0) + ' code lines');

    let vmRev = null;
    if (vmRoot) {
        archiveTree(vmRoot, 'HEAD', T.vmOn);
        archiveTree(vmRoot, 'HEAD', T.vmOld);
        vmRev = revertCommitOnto(vmRoot, opts.vmArmRef, 'HEAD', T.vmOld, path.join(workdir, 'tmp-vm'));
        for (const r of vmRev.commentResolved) info('vm comment-only conflict resolved to HEAD: ' + r);
        if (vmRev.problems.length) {
            for (const pr of vmRev.problems) console.log('  FAIL  vm ' + pr);
            refuse('the OLD vm tree cannot be built as exactly HEAD-minus-the-arm');
        }
        check(vmRev.files.length > 0, 'N4 the vm arm reverted file by file, exactly',
              vmRev.files.map(f => f.file).join(', '));
        fs.symlinkSync(path.join(vmRoot, 'node_modules'), path.join(T.vmOn, 'node_modules'));
        fs.symlinkSync(path.join(vmRoot, 'node_modules'), path.join(T.vmOld, 'node_modules'));
        wireNodeModules(T.on,  path.join(REPO, 'node_modules'), { 'xchain-vm': T.vmOn });
        wireNodeModules(T.old, path.join(REPO, 'node_modules'), { 'xchain-vm': T.vmOld });
    } else {
        fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(T.on, 'node_modules'));
        fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(T.old, 'node_modules'));
    }

    // N3: same harness on both sides.
    for (const rel of ['test/integration/setup/indexer-launcher.js', 'test/integration/setup/db-connection.js',
                       'test/integration/setup/equivalence.js', 'src/genesis.js', 'src/XChainIndexer.js',
                       'src/actions.js', 'package.json']) {
        const a = path.join(T.on, rel), b = path.join(T.old, rel);
        const same = fs.existsSync(a) && fs.existsSync(b) && sha256File(a) === sha256File(b);
        check(same, 'N3 identical in both trees: ' + rel, same ? '' : 'the two sides would run different harnesses');
    }

    // N1 (static half): which mainnet keys the revert moved, file by file.
    const moved = [];
    for (const f of armFiles) {
        const r = movedMapKeys(fs.readFileSync(path.join(T.on, f), 'utf8'), fs.readFileSync(path.join(T.old, f), 'utf8'));
        for (const m of r.moved) moved.push(Object.assign({ file: f }, m));
    }
    const badOn  = moved.filter(m => !ARMED_OK.has(m.on));
    const badOld = moved.filter(m => !INERT_OK.has(m.old));
    check(moved.length > 0, 'N1 the arm moves mainnet map keys in this tree (static scan of the reverted files)',
          moved.length + ' key(s) across ' + new Set(moved.map(m => m.file)).size + ' file(s)');
    check(badOn.length === 0, 'N1 every moved key reads 0 (or the D24 instant) on ON', badOn.length ? JSON.stringify(badOn.slice(0, 5)) : '');
    check(badOld.length === 0, 'N1 every moved key reads an inert sentinel or null on OLD', badOld.length ? JSON.stringify(badOld.slice(0, 5)) : '');
    if (failures) refuse('the trees do not isolate the arm (see FAIL lines above)');
    if (opts.dryRun) {
        info('moved map keys: ' + moved.map(m => m.file.replace(/^src\//, '') + ' ' + m.key + ' ' + m.old + '->' + m.on).join('; '));
        await admin.end();
        await ref.end();
        if (!opts.keep) fs.rmSync(workdir, { recursive: true, force: true });
        console.log('\nDRY RUN: trees built and the arm isolated; no replay was run, so this is NOT a verdict');
        process.exit(EXIT.REFUSED);
    }

    // ---- schemas -----------------------------------------------------------
    for (const name of Object.values(DB)) {
        await admin.query('DROP DATABASE IF EXISTS `' + name + '`');
        await admin.query('CREATE DATABASE `' + name + '`');
    }
    await admin.end();

    // ---- run the sides -----------------------------------------------------
    section('sides' + (opts.serial ? ' (serial)' : ' (parallel)'));
    const noDump = path.join(workdir, 'no-such-genesis-dump.ndjson.gz');
    const sides = [
        { key: 'OLD', root: T.old, db: DB.OLD, label: 'HEAD minus the arm' },
        { key: 'ON',  root: T.on,  db: DB.ON,  label: 'HEAD, arm live' },
    ];
    const envFor = s => Object.assign({}, process.env, {
        GA_SIDE_ROOT: s.root, GA_SIDE_KEY: s.key,
        TEST_DB_HOST: p.host, TEST_DB_PORT: String(p.port), TEST_DB_USER: p.user, TEST_DB_PASS: p.pass,
        TEST_INDEXER_DB: s.db, TEST_DECODER_DB: opts.decoderDb,
        INDEXER_COIN: opts.coin, INDEXER_NETWORK: opts.network,
        GENESIS_DUMP_PATH: noDump,
    });
    const results = {};
    const started = Date.now();
    if (opts.serial) {
        for (const s of sides) results[s.key] = await runSideProcess(s, envFor(s), path.join(workdir, s.key + '.log'));
    } else {
        const rs = await Promise.all(sides.map(s => runSideProcess(s, envFor(s), path.join(workdir, s.key + '.log'))));
        for (const r of rs) results[r.side.key] = r;
    }
    const reports = {};
    for (const s of sides) {
        const r = results[s.key];
        const line = String(r.stdout || '').split('\n').find(l => l.startsWith(SIDE_MARK));
        if (r.status !== 0 || !line) {
            console.log('  FAIL  side ' + s.key + ' exited ' + r.status + '; last lines of ' + path.join(workdir, s.key + '.log') + ':');
            const tail = fs.readFileSync(path.join(workdir, s.key + '.log'), 'utf8').split('\n').slice(-20).join('\n');
            console.log(tail);
            refuse('side ' + s.key + ' did not complete its replay');
        }
        reports[s.key] = JSON.parse(line.slice(SIDE_MARK.length));
        info(s.key.padEnd(3) + ' ' + s.label.padEnd(24) + reports[s.key].blocks + ' blocks in ' +
             (reports[s.key].ms / 1000).toFixed(0) + 's');
    }
    info('wall time for both sides: ' + ((Date.now() - started) / 1000).toFixed(0) + 's');

    // ---- N1: gate state proven per side --------------------------------------
    section('N1 gate state proven per side');
    for (const k of ['OLD', 'ON']) {
        const g = reports[k].genesis;
        check(g.dumpExists === false && (!genesisConfigured || (g.ledgerPathExists === true && g.block === genesisBlock)),
              k + (genesisConfigured ? ' derived genesis through the pipeline (no dump; manifest present; block ' + g.block + ')'
                                     : ' ran with no genesis bootstrap (none configured for this chain)'),
              JSON.stringify(g));
        if (genesisConfigured)
            check(!!g.ledgerHash, k + ' verified the genesis manifest against a pinned hash', g.ledgerHash ? '' : 'GENESIS_LEDGER_HASH unset');
    }
    const movedRegistry = new Map();
    const regOn = reports.ON.registry, regOld = reports.OLD.registry;
    for (const name of Object.keys(regOn))
        if (regOld[name] && regOld[name].mainnet !== regOn[name].mainnet)
            movedRegistry.set(name, { old: regOld[name].mainnet, on: regOn[name].mainnet });
    const regBad = Array.from(movedRegistry).filter(([, v]) => !ARMED_OK.has(String(v.on)) || !INERT_OK.has(String(v.old)));
    check(Object.keys(regOn).length === Object.keys(regOld).length &&
          Object.keys(regOn).every(n => regOld[n] !== undefined),
          'both sides registered the same protocol-change names (' + Object.keys(regOn).length + ')');
    check(movedRegistry.size > 0, 'registry constants moved by the arm, as registered by each side\'s own ProtocolChanges',
          Array.from(movedRegistry).map(([n, v]) => n + ' ' + v.old + '->' + v.on).join(', '));
    check(regBad.length === 0, 'every moved registry constant reads UNARMED on OLD and 0 on ON',
          regBad.length ? JSON.stringify(regBad) : '');
    const fpOn = reports.ON.fingerprint, fpOld = reports.OLD.fingerprint;
    check(fpOn.fingerprint !== fpOld.fingerprint, 'armed-map fingerprint differs between the sides',
          'OLD ' + fpOld.fingerprint.slice(0, 16) + '... ON ' + fpOn.fingerprint.slice(0, 16) + '...');
    const gateFilesTouched = Object.keys(fpOn.files).filter(n => armFiles.has('src/' + n));
    const gateFilesSame = gateFilesTouched.filter(n => fpOn.files[n] === fpOld.files[n]);
    check(gateFilesTouched.length > 0 && gateFilesSame.length === 0,
          'every arm-touched gate carrier hashes differently per side (' + gateFilesTouched.length + ' carriers)',
          gateFilesSame.length ? 'unchanged: ' + gateFilesSame.join(', ') : '');
    if (vmRoot) {
        check(reports.ON.vm.sha256 !== reports.OLD.vm.sha256, 'each side loaded its own vm tree',
              'OLD ' + reports.OLD.vm.main + '\n          ON  ' + reports.ON.vm.main);
    }
    check(reports.OLD.blocks === reports.ON.blocks && reports.ON.blocks === decRange.n,
          'both sides processed every corpus block', 'OLD=' + reports.OLD.blocks + ' ON=' + reports.ON.blocks + ' corpus=' + decRange.n);

    // ---- what was replayed, against what was indexed ----------------------
    section('the tally: replayed against indexed (the line a bare green would hide)');
    const conns = {};
    for (const k of ['OLD', 'ON']) conns[k] = await connect(p, DB[k]);
    const q = { OLD: queryFnFor(conns.OLD), ON: queryFnFor(conns.ON) };
    const replayed = { OLD: await countRows(q.OLD, 'actions'), ON: await countRows(q.ON, 'actions') };
    const typesOn = await actionsByType(q.ON);
    const typesOld = await actionsByType(q.OLD);
    console.log('  TALLY replayed actions: ON ' + replayed.ON + '  OLD ' + replayed.OLD +
                '  |  indexed by the fleet: ' + refActions);
    console.log('  TALLY replayed by type ON:  ' + JSON.stringify(typesOn));
    console.log('  TALLY replayed by type OLD: ' + JSON.stringify(typesOld));
    console.log('  TALLY indexed by type:      ' + JSON.stringify(refTypes));
    const fraction = refActions > 0 ? replayed.ON / refActions : null;

    // ---- G3 ---------------------------------------------------------------
    section('G3: consensus hash chain OLD vs ON, from genesis');
    const eq = require(path.join(REPO, 'test', 'integration', 'setup', 'equivalence.js'));
    const chainOLD = await eq.readHashChain(q.OLD);
    const chainON  = await eq.readHashChain(q.ON);
    const fork = firstDivergence(chainOLD, chainON);
    check(fork === null, 'consensus hash chain identical at all ' + chainON.length + ' blocks (ledger/actions/contracts + state)',
          fork ? 'FIRST DIVERGENCE: block ' + fork.block + ' field ' + fork.field + ' OLD=' + fork.a + '... ON=' + fork.b + '...'
               : chainON.length ? 'first ' + chainON[0].block_index + ' ledger=' + String(chainON[0].ledger).slice(0, 16) +
                 '...  last ' + chainON[chainON.length - 1].block_index + ' ledger=' +
                 String(chainON[chainON.length - 1].ledger).slice(0, 16) + '...' : 'no blocks');

    const stateOLD = await eq.captureDbState(q.OLD, { mode: 'strict' });
    const stateON  = await eq.captureDbState(q.ON,  { mode: 'strict' });
    const tableDiff = diffStates(stateOLD, stateON);
    check(tableDiff.length === 0, 'every table byte-identical OLD vs ON (' + Object.keys(stateON).length + ' tables, strict mode)',
          tableDiff.length === 0 ? 'row totals: ' + Object.values(stateON).reduce((n, r) => n + r.length, 0)
                                 : JSON.stringify(tableDiff, null, 2));

    // A divergence names the block AND the gate: the rows that moved at the fork,
    // and the arm gates the moved action's own handler reads.
    if (fork && fork.block !== null) {
        section('divergence attribution at block ' + fork.block);
        const rowsOld = await rowsAtBlock(q.OLD, fork.block);
        const rowsOn  = await rowsAtBlock(q.ON, fork.block);
        const movedTypes = new Set();
        for (const t of Object.keys(rowsOn)) {
            const a = rowsOld[t] || [], b = rowsOn[t];
            const setA = new Set(a), setB = new Set(b);
            const onlyOld = a.filter(r => !setB.has(r)), onlyOn = b.filter(r => !setA.has(r));
            if (!onlyOld.length && !onlyOn.length) continue;
            console.log('  ROWS  ' + t + ': ' + onlyOld.length + ' only on OLD, ' + onlyOn.length + ' only on ON');
            for (const r of onlyOld.slice(0, 3)) console.log('          OLD ' + r.slice(0, 300));
            for (const r of onlyOn.slice(0, 3))  console.log('          ON  ' + r.slice(0, 300));
            for (const r of onlyOn.concat(onlyOld)) {
                const m = r.match(/"action":"([A-Z]+)"/) || r.match(/"type":"([A-Z]+)"/);
                if (m) movedTypes.add(m[1]);
                if (t !== 'actions' && t !== 'blocks' && !t.startsWith('index_')) movedTypes.add(t.replace(/s$/, '').toUpperCase());
            }
        }
        // The action types in that block on ON, which name the handlers to look at.
        const acts = await q.ON('SELECT ia.action, COUNT(*) n FROM actions a JOIN index_actions ia ON ia.id = a.action_id WHERE a.block_index = ? GROUP BY ia.action', [fork.block]);
        for (const r of acts) movedTypes.add(String(r.action));
        for (const t of movedTypes) {
            const g = gatesReadBy(T.on, t, movedRegistry, armFiles);
            if (!g.reader) continue;
            console.log('  GATE  ' + t + ' handler ' + g.reader + ' reads moved registry gates [' + g.registry.join(', ') +
                        '] and moved map carriers [' + g.modules.join(', ') + ']');
        }
        console.log('  GATE  per the spec, the gate named above leaves the genesis set and takes a future instant (row 7)');
    }

    // ---- measurement: ON against the chain the fleet wrote ----------------
    section('measurement: ON replay against the fleet\'s indexed hash chain (reported, not asserted)');
    const chainREF = await eq.readHashChain(qRef);
    const refFork = firstDivergence(chainON, chainREF);
    info('indexed reference chain: ' + chainREF.length + ' blocks; ON replay: ' + chainON.length + ' blocks');
    if (chainREF.length && chainON.length) {
        info(refFork === null ? 'ON replay reproduces the fleet\'s hash chain end to end: the armed code re-derives what the fleet wrote'
                              : 'ON replay parts from the fleet\'s chain at block ' + refFork.block + ' field ' + refFork.field +
                                ' (ON=' + refFork.a + '... fleet=' + refFork.b + '...); a finding about the fleet\'s multi-release history, not about the arm');
        const refOld = firstDivergence(chainOLD, chainREF);
        info('OLD replay against the fleet\'s chain: ' + (refOld === null ? 'identical end to end' : 'parts at block ' + refOld.block + ' field ' + refOld.field));
    }
    await ref.end();

    // ---- coverage statement ----------------------------------------------
    section('coverage of this run');
    info('COVERED: every action this chain\'s indexed history contains, replayed from block ' + decRange.lo +
         ' by both trees: ' + JSON.stringify(typesOn));
    info('  Gate carriers exercised are the ones those handlers read; the arm moved ' + moved.length +
         ' map key(s) in ' + armFiles.size + ' indexer file(s) and ' + movedRegistry.size + ' registry constant(s)' +
         (vmRoot ? ', plus the vm\'s ' + vmRev.files.length + ' carrier(s)' : '') + '.');
    info('NOT COVERED: any gate whose action type is absent from the tally above never ran on either side;');
    info('  identity for those rests on the measured absence, which is what this tally line records.');
    info('  Copies of the maps in hub, sync, decoder, sdk and documentation are byte-identical twins by CI and are not loaded here.');

    for (const k of ['OLD', 'ON']) { try { await conns[k].end(); } catch (e) {} }

    if (!opts.keep) {
        const a2 = await connect(p, undefined);
        for (const name of Object.values(DB)) await a2.query('DROP DATABASE IF EXISTS `' + name + '`');
        await a2.end();
        fs.rmSync(workdir, { recursive: true, force: true });
    } else {
        info('kept: schemas ' + Object.values(DB).join(', ') + ' and trees under ' + workdir);
    }

    // ---- verdict, refusal first -------------------------------------------
    console.log('\nTALLY replayed ' + replayed.ON + ' / indexed ' + refActions + ' actions on ' + opts.coin + '/' + opts.network +
                (fraction === null ? '' : ' (' + (fraction * 100).toFixed(2) + '%)'));
    if (replayed.ON === 0 && refActions === 0) {
        console.log('VACUOUS: the corpus carries no actions on either side; the hash chains agree over ' + chainON.length +
                    ' empty blocks and NOTHING about the gates was measured');
        process.exit(EXIT.VACUOUS);
    }
    if (replayed.ON === 0)
        refuse('the replay produced no actions while the fleet indexed ' + refActions + '; the sides compared nothing');
    if (fraction !== null && fraction < opts.minFraction)
        refuse('the replay reproduced ' + replayed.ON + ' of ' + refActions + ' indexed actions (' + (fraction * 100).toFixed(2) +
               '%), below --min-replay-fraction ' + opts.minFraction + '; the witness did not exercise the indexed history');
    if (failures) {
        console.log('\nFAILED: ' + failures + ' assertion(s)');
        process.exit(EXIT.FAIL);
    }
    console.log('\nALL ASSERTIONS HOLD: OLD and ON agree on every block over ' + replayed.ON + ' replayed actions (G3 for ' +
                opts.coin + '/' + opts.network + ')');
    process.exit(EXIT.PASS);
}
