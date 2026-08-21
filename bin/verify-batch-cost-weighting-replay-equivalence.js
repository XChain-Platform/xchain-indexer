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
 * BELOW-THE-FLAG REPLAY EQUIVALENCE for BATCH_COST_WEIGHTING.
 *
 * WHY THIS EXISTS. BATCH_COST_WEIGHTING replaces the flat 250-command BATCH cap with a
 * budget over per-action cost weights (default 1, DEPLOY/EXECUTE/XEXEC 30, AIRDROP/
 * DIVIDEND 25) and widens the provably-unaffordable spam collapse to duration-metered
 * creates and to EXECUTE's acceptance floor. Both are consensus. If either leaks below
 * the gate, a from-genesis replay reaches verdicts the live fleet never wrote and the
 * ledger forks. This tool is the evidence that nothing leaks, and it is the last gate
 * before the operator may arm the flag on mainnet, so it may not be a code-reading
 * argument: it has to be driven, in both directions.
 *
 * ------------------------------------------------------------------------------
 * THE THREE SIDES
 *
 *   OLD  - HEAD's tree with src/actions/batch.js taken from --pre-ref (the parent of
 *          the first weighting commit). That file is the ONLY src file the weighting
 *          commits changed behaviourally, so this is HEAD with exactly this change
 *          removed and nothing else.
 *   OFF  - HEAD, with BATCH_COST_WEIGHTING's registered instant moved to the UNARMED
 *          sentinel on every network: a block below the flag instant.
 *   ON   - HEAD with the flag as regtest actually ships it (genesis-active). This is
 *          the NEGATIVE CONTROL, not evidence.
 *
 * All three replay the SAME decoder corpus from genesis into three separate databases.
 * OLD vs OFF must be byte-identical, table for table and hash for hash. ON must not be.
 *
 * WHY OLD IS SURGICAL AND NOT A WHOLE OLD TREE. The predecessor tool for
 * BATCH_ISSUANCE_LIMITS materializes the entire tree at the last pre-work commit,
 * which is sound when that commit is days-adjacent to HEAD. It is not sound here:
 * between the first weighting commit's parent and HEAD sit 74 changed src files,
 * including schema migrations and several unrelated per-network flag days that are
 * live on regtest. A whole-tree diff would confound them with this change and could
 * only ever produce a red run for the wrong reason. So the old side is built by
 * substituting ONE file, and the substitution's exactness is asserted rather than
 * assumed (see N4 below).
 *
 * WHY THE GATE IS FORCED BY MOVING THE INSTANT AND NOT BY STUBBING isEnabled: the
 * pre-flag condition IS "the instant has not arrived". Rewriting the registered
 * activation times to the sentinel makes the REAL isEnabled evaluate the REAL gate and
 * answer false the same way it answers false on mainnet today. A stubbed isEnabled
 * would prove that a stub returns false.
 *
 * ------------------------------------------------------------------------------
 * TWO CORPORA, BECAUSE NEITHER ONE ALONE IS THE WHOLE CLAIM
 *
 *   --corpus real (--decoder-db <schema>): an existing decoder schema replayed from its
 *     first block. This is the acceptance criterion's "real on-chain corpus": whatever
 *     a live chain actually produced, weights included, judged by both code paths. Its
 *     job is the BYTE-IDENTICAL half. It cannot carry the negative control, because a
 *     real chain is not obliged to contain a batch that straddles the budget - and if
 *     it does not, ON agreeing with OLD is the measured no-op the spec predicts, not
 *     evidence that the harness can see a fork.
 *
 *   --corpus synthetic (default): purpose-built shapes that straddle the budget in
 *     both directions. Its job is the NEGATIVE CONTROL: the divergences here are
 *     designed, so a run where ON matches OLD means the harness has gone blind and is
 *     reported as a FAILURE of this tool rather than a pass.
 *
 * The synthetic shapes, each paired with a control that must NOT move:
 *
 *   S1  250 ordinary SENDs                  valid everywhere   (weight 250 = budget)
 *   S2  251 ordinary SENDs                  invalid everywhere (the count pre-filter)
 *   S3  1 DEPLOY + 249 SENDs                OLD/OFF valid, ON invalid   (30+249=279)
 *   S4  1 DEPLOY + 220 SENDs                valid everywhere            (30+220=250)
 *   S5  9 EXECUTEs                          OLD/OFF valid, ON invalid   (9x30=270)
 *   S6  8 EXECUTEs                          valid everywhere            (8x30=240)
 *   S7  11 AIRDROPs                         OLD/OFF valid, ON invalid   (11x25=275)
 *   S8  10 AIRDROPs                         valid everywhere            (10x25=250)
 *   S9  two DEPLOYs                         `invalid: DEPLOY (limit)` everywhere
 *   S10 3 ORDERs from a gasless source       OLD/OFF valid, ON collapses to GAS
 *   S11 3 ORDERs from a funded source        valid everywhere
 *   S12 2 EXECUTEs from a gasless source     OLD/OFF valid, ON collapses to GAS
 *   S13 2 SENDs from a gasless source        valid everywhere (cost not knowable)
 *
 * S9 is the DEPLOY conjunction: a weighted sum cannot express "at most one DEPLOY", so
 * the cap survives beside the weight and must keep reporting its own string.
 * S10-S13 are the D10 half of this flag. Without them the run would measure the budget
 * and leave the widened spam collapse - the other consensus change riding this same
 * gate - entirely unmeasured, and pass anyway.
 *
 * ------------------------------------------------------------------------------
 * NEGATIVE CONTROLS (a comparison that would pass even if the gate did nothing is
 * worthless)
 *
 *   N1. GATE STATE IS PROVEN, NOT ASSUMED. Each side reports the activation times its
 *       OWN ProtocolChanges registered, and the OLD side additionally proves its src
 *       tree contains no reader of the flag outside protocol_changes.js itself.
 *   N2. THE HARNESS DETECTS DIVERGENCE. Side ON is compared against OLD with the same
 *       comparator, and on the synthetic corpus it MUST differ, in the tables this
 *       change is supposed to move.
 *   N3. THE WITNESSES. Specific verdicts on the OLD side are asserted individually, so
 *       "identical" cannot be satisfied by two sides that both did nothing.
 *   N4. THE SUBSTITUTION IS EXACT. Every commit touching src/actions/batch.js between
 *       --pre-ref and HEAD must be either a declared weighting commit or provably
 *       comment-only in that file (checked by inspecting its diff, not by trusting its
 *       subject line). Otherwise the OLD side would silently carry an unrelated
 *       behavioural rollback and the comparison would be about something else.
 *
 * ------------------------------------------------------------------------------
 * WHAT IT DOES NOT COVER - read this before quoting a green run.
 *
 *   - The synthetic corpus's EXECUTE sub-commands name a contract index that does not
 *     exist, so they are rejected before any contract code runs. That is deliberate:
 *     the weight scan reads the ACTION NAME only, so the budget divergence is fully
 *     exercised without the corpus depending on a working isolate. The VM dispatch path
 *     is covered by the real-corpus run instead, where whatever DEPLOYs and EXECUTEs
 *     the chain actually carries are replayed for real on both sides.
 *   - XEXEC carries the same weight 30 as EXECUTE but is system-injected, so no wire
 *     transaction can put one in a BATCH. Its weight is pinned in the unit tier only.
 *   - The real corpus's coverage is whatever that chain contains. The run prints the
 *     BATCH count and the weight distribution it actually saw, so a corpus that reaches
 *     no batch at all cannot be quoted as evidence about batches.
 *
 * READ-ONLY WITH RESPECT TO THE REPOSITORY. The old tree is materialized with
 * `git archive` (no worktree metadata, no index, no ref writes) into a temp dir. The
 * tool writes only to its own throwaway databases, and never to --decoder-db.
 *
 * USAGE
 *   node bin/verify-batch-cost-weighting-replay-equivalence.js
 *   node bin/verify-batch-cost-weighting-replay-equivalence.js \
 *        --corpus real --decoder-db xchain_test_a6_ltc_dec --coin LTC --network regtest
 *
 * Needs a MariaDB the test user may CREATE schemas on:
 *   TEST_DB_HOST TEST_DB_PORT TEST_DB_USER TEST_DB_PASS (fall back to .env INDEXER_DB_*
 *   exactly like test/integration/setup/db-connection.js), and TEST_DB_NS (default
 *   xchain_test_a6) for the throwaway schema prefix.
 *
 * EXIT: 0 every assertion holds, 1 an assertion failed, 2 cannot run.
 *
 *********************************************************************/

'use strict';

const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');

const REPO      = path.resolve(__dirname, '..');
const GATE      = 'BATCH_COST_WEIGHTING';
const UNARMED   = 9999999999;      // the house UNARMED sentinel (protocol_changes.js)
const SIDE_MARK = '###A6-SIDE###'; // child -> parent report line

// The commits that introduced this spec's change to src/actions/batch.js. N4 requires
// every OTHER commit touching that file since --pre-ref to be comment-only, so this list
// is what makes "the old side differs by exactly this change" checkable rather than
// asserted. Short SHAs, resolved through git so an abbreviation change cannot silently
// drop one from the list.
const WEIGHTING_COMMITS = ['013c206', 'd627a4b', '2d70b903'];

// Declared before main() so a FAILING check on the synchronous prefix can still print its
// verdict instead of dying in the temporal dead zone.
let failures = 0;

if (process.argv.includes('--side')) {
    runSide().catch(e => { console.error('SIDE ERROR: ' + (e && e.stack || e)); process.exit(1); });
} else {
    main().catch(e => { console.error('ERR ' + (e && e.stack || e)); process.exit(1); });
}

// ---------------------------------------------------------------------------
// CHILD MODE: index the shared decoder corpus with ONE side's code.
// ---------------------------------------------------------------------------

async function runSide() {
    const root = process.env.A6_SIDE_ROOT;      // repo root this side runs from
    const gate = process.env.A6_SIDE_GATE;      // 'natural' | 'off'

    // Move the registered activation instant instead of stubbing the gate: below the flag,
    // isEnabled answers false BECAUSE the instant has not arrived, and that is the code
    // path a pre-flag block takes. Patched on the prototype before initIndexer constructs
    // the instance, and only for THIS flag - every sibling gate keeps whatever the tree
    // under test registers for it.
    if (gate === 'off') {
        const PC = require(path.join(root, 'src', 'protocol_changes.js'));
        const realAddChange = PC.prototype.addChange;
        PC.prototype.addChange = function (name, version, mt, tt, rt, mb, tb, rb) {
            if (name === GATE) { mt = tt = rt = UNARMED; mb = tb = rb = 0; }
            return realAddChange.call(this, name, version, mt, tt, rt, mb, tb, rb);
        };
    }

    const launcher = require(path.join(root, 'test', 'integration', 'setup', 'indexer-launcher.js'));
    const indexer  = await launcher.initIndexer();

    // N1: report the gate exactly as THIS side's ProtocolChanges registered it.
    const change = indexer.protocolChanges.changes ? indexer.protocolChanges.changes[GATE] : undefined;
    const gateReport = change
        ? { registered: true, mainnet_time: Number(change.mainnet_time),
            testnet_time: Number(change.testnet_time), regtest_time: Number(change.regtest_time) }
        : { registered: false };

    const t0 = Date.now();
    const blocks = await launcher.processBlocks(indexer);
    const ms = Date.now() - t0;
    await launcher.destroyIndexer(indexer);

    console.log(SIDE_MARK + JSON.stringify({ blocks, ms, gate: gateReport }));
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

function parseArgs() {
    const a = process.argv.slice(2);
    const o = { preRef: '3140ea2^', keep: false, corpus: 'synthetic',
                coin: 'BTC', network: 'regtest', decoderDb: null };
    for (let i = 0; i < a.length; i++) {
        switch (a[i]) {
            case '--pre-ref':    o.preRef = a[++i]; break;
            case '--corpus':     o.corpus = a[++i]; break;
            case '--decoder-db': o.decoderDb = a[++i]; o.corpus = 'real'; break;
            case '--coin':       o.coin = a[++i]; break;
            case '--network':    o.network = a[++i]; break;
            case '--keep':       o.keep = true; break;
            case '--workdir':    o.workdir = a[++i]; break;
            case '--help': case '-h':
                console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
                process.exit(0);
                break;
            default: console.error('unknown arg: ' + a[i]); process.exit(64);
        }
    }
    if (o.corpus !== 'synthetic' && o.corpus !== 'real') {
        console.error('--corpus must be synthetic or real'); process.exit(64);
    }
    if (o.corpus === 'real' && !o.decoderDb) {
        console.error('--corpus real needs --decoder-db <existing schema>'); process.exit(64);
    }
    return o;
}

// --- synthetic corpus -------------------------------------------------------
//
// Real base58check regtest P2PKH addresses, shared with the integration tier:
// utility.isCryptoAddress decodes and version-checks, so an invented string is rejected
// wherever an address is validated.
const A1 = 'mq7tVfobimRUPxPNnyd5mKn11SVmTiLxtu';   // issuer / deployer, funded with gas
const A2 = 'n4nbVcRRR5sEHyp2VYuLUvCyDmQmBoonoK';   // counterparty, funded with gas
const A4 = 'mwGujTXFXMLN2YXqo4mQK4DcKy31DUcwoi';   // deliberately holds NO gas (D10)

const T0    = 1700000000;
const STEP  = 60;
const GAS_B = 99;      // gas preamble block (seedGas convention: first block - 1)
const TOK   = 'WTOK';  // the tick every ordinary sub-command moves

// Inline DEPLOY code is base64 at/after DEPLOY_BASE64_CODE, genesis-active on regtest.
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const contractCode = tag =>
    "module.exports={ permissions:['SEND'], maxTakeBps:100, guard:function(){ return {}; } }; // " + tag;

// A contract index no DEPLOY in this corpus produces, so every EXECUTE is rejected on
// CONTRACT_ACTION_INDEX before a contract runs. The weight scan reads the action name
// only, so the budget divergence is unaffected and the corpus needs no isolate.
const NO_SUCH_CONTRACT = 999999;

// Far enough out to be chargeable: the unified expiration fee is free for the first 90
// days, so a 200-day ORDER owes a real duration fee and D10 can price it.
const ORDER_EXP = T0 + 86400 * 200;

const order   = () => `ORDER|0|BTC|${TOK}|10|0|BTC|${TOK}|20|0|${A1}|${ORDER_EXP}|||`;
const exec    = n  => `EXECUTE|0|${NO_SUCH_CONTRACT}|m${n}|`;
const airdrop = n  => `AIRDROP|0|${TOK}|1|${900000 + n}|`;
const send    = () => `SEND|0|${TOK}|1|${A2}`;
const deploy  = tag => `DEPLOY|0|${b64(contractCode(tag))}|300000|`;

function batchOf(commands) { return 'BATCH|0|' + commands.join(';'); }
function rep(n, f) { return Array.from({ length: n }, (_, i) => f(i)); }

// Block index -> the shape it carries, so witnesses address shapes by block rather than
// by position in a verdict list that a corpus edit could renumber.
const SHAPE_BLOCK = {
    S1: 102, S2: 103, S3: 104, S4: 105, S5: 106, S6: 107, S7: 108,
    S8: 109, S9: 110, S10: 111, S11: 112, S12: 113, S13: 114,
};
const LAST_BLOCK = 114;

function corpus() {
    const t = n => T0 + (n - 100) * STEP;
    const blocks = [];

    blocks.push({ block: 100, time: t(100), txs: [
        { source: A1, data: `ISSUE|0|${TOK}|100000000|1000000|0|weighting corpus` },
    ] });
    blocks.push({ block: 101, time: t(101), txs: [
        { source: A1, data: `MINT|0|${TOK}|1000000` },
    ] });

    const at = (shape, source, cmds) =>
        blocks.push({ block: SHAPE_BLOCK[shape], time: t(SHAPE_BLOCK[shape]),
                      txs: [{ source, data: batchOf(cmds) }] });

    at('S1',  A1, rep(250, send));
    at('S2',  A1, rep(251, send));
    at('S3',  A1, [deploy('s3')].concat(rep(249, send)));
    at('S4',  A1, [deploy('s4')].concat(rep(220, send)));
    at('S5',  A1, rep(9, exec));
    at('S6',  A1, rep(8, exec));
    at('S7',  A1, rep(11, airdrop));
    at('S8',  A1, rep(10, airdrop));
    at('S9',  A1, [deploy('s9a'), deploy('s9b')]);
    at('S10', A4, rep(3, order));
    at('S11', A1, rep(3, order));
    at('S12', A4, rep(2, exec));
    at('S13', A4, rep(2, send));

    return blocks;
}

// --- old tree ---------------------------------------------------------------

// Materialize HEAD with `git archive` (a pure read of the object store: no index, no ref
// writes), then substitute the one src file this spec changed with its pre-work version.
function materializeOldTree(preRef, dir) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    execSync('git archive HEAD | tar -x -C ' + JSON.stringify(dir), { cwd: REPO });
    const pre = execSync('git show ' + JSON.stringify(preRef + ':src/actions/batch.js'),
        { cwd: REPO, maxBuffer: 1024 * 1024 * 64 });
    fs.writeFileSync(path.join(dir, 'src', 'actions', 'batch.js'), pre);
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
    return dir;
}

// N4. Every commit touching src/actions/batch.js between preRef and HEAD must be a
// declared weighting commit or comment-only in that file. Returns the offenders, so a
// caller can name them rather than just refuse.
function unaccountedBatchCommits(preRef) {
    const declared = new Set(WEIGHTING_COMMITS.map(
        s => execSync('git rev-parse ' + JSON.stringify(s), { cwd: REPO }).toString().trim()));
    const shas = execSync('git log --format=%H ' + JSON.stringify(preRef) + '..HEAD -- src/actions/batch.js',
        { cwd: REPO }).toString().trim().split('\n').filter(Boolean);
    const offenders = [];
    for (const sha of shas) {
        if (declared.has(sha)) continue;
        const diff = execSync('git show ' + sha + ' -- src/actions/batch.js',
            { cwd: REPO, maxBuffer: 1024 * 1024 * 64 }).toString();
        const changed = diff.split('\n')
            .filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
            .map(l => l.slice(1).trim());
        // A comment-only commit moves nothing the parser sees. Anything else is a
        // behavioural change the substitution would silently roll back too.
        const code = changed.filter(l => l !== '' && !/^(\/\/|\*|\/\*)/.test(l));
        if (code.length)
            offenders.push({ sha: sha.slice(0, 8), codeLines: code.length, sample: code[0].slice(0, 80) });
    }
    return { total: shas.length, declared: declared.size, offenders };
}

function sha256File(p) {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
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

// --- comparison -------------------------------------------------------------

// Table-level diff over the SAME canonical snapshots assertCapturedStatesEqual consumes,
// so a difference this reports is a difference that comparator fails on.
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

// The first block where two hash chains part, and on which field. assertHashChainsEqual
// throws the same fact; this returns it as data so the run can print it alongside the
// verdict delta rather than only inside an exception message.
function firstDivergence(chainA, chainB) {
    const len = Math.min(chainA.length, chainB.length);
    for (let i = 0; i < len; i++)
        for (const f of ['ledger', 'actions', 'contracts', 'state'])
            if (chainA[i][f] !== chainB[i][f])
                return { block: chainA[i].block_index, field: f,
                         a: String(chainA[i][f]).slice(0, 16), b: String(chainB[i][f]).slice(0, 16) };
    if (chainA.length !== chainB.length)
        return { block: null, field: 'length', a: chainA.length, b: chainB.length };
    return null;
}

// --- witnesses --------------------------------------------------------------

// Every BATCH's verdict keyed by the block it landed in, which is how the synthetic
// shapes are addressed and what the real corpus needs to report a per-batch delta.
async function batchVerdictsByBlock(q) {
    const rows = await q(
        'SELECT a.block_index, b.action_index, s.status FROM batches b ' +
        'JOIN actions a ON a.action_index = b.action_index ' +
        'LEFT JOIN index_statuses s ON s.id = b.status_id ' +
        'ORDER BY b.action_index');
    const out = [], seen = {};
    for (const r of rows) {
        const block = Number(r.block_index);
        seen[block] = (seen[block] || 0) + 1;
        out.push({ block, pos: seen[block], action: String(r.action_index), status: String(r.status) });
    }
    return out;
}

async function countRows(q, table) {
    const rows = await q('SELECT COUNT(*) AS n FROM `' + table + '`');
    return Number(rows[0].n);
}

async function witnesses(qf) {
    const batches = await batchVerdictsByBlock(qf);
    const byBlock = {};
    for (const b of batches) byBlock[b.block] = b.status;
    return {
        batches, byBlock,
        shape: (s) => byBlock[SHAPE_BLOCK[s]],
        counts: {
            actions:  await countRows(qf, 'actions'),
            batches:  batches.length,
            sends:    await countRows(qf, 'sends'),
            issues:   await countRows(qf, 'issues'),
            orders:   await countRows(qf, 'orders'),
            contracts: await countRows(qf, 'contracts'),
        },
    };
}

// Batches whose verdict differs between two sides, matched by (block, position within the
// block). Deliberately NOT by action_index: a batch the gate refuses consumes fewer action
// indexes than one it admits, so every later batch is renumbered and an index-keyed join
// would report the whole tail as changed. Block position survives that renumbering, which
// is what makes the first entry here the FIRST batch whose verdict really moved.
function verdictDelta(wA, wB) {
    const key = b => b.block + '#' + b.pos;
    const mapB = {};
    for (const b of wB.batches) mapB[key(b)] = b.status;
    const out = [];
    for (const b of wA.batches)
        if (mapB[key(b)] !== b.status)
            out.push({ block: b.block, pos: b.pos, a: b.status, b: mapB[key(b)] || '(absent)' });
    return out;
}

// --- main -------------------------------------------------------------------

async function main() {
    const opts = parseArgs();
    const p    = dbParams();
    const NS   = process.env.TEST_DB_NS || 'xchain_test_a6';
    const DB   = { OLD: NS + '_old', OFF: NS + '_off', ON: NS + '_on' };
    const DEC  = opts.corpus === 'real' ? opts.decoderDb : NS + '_dec';

    console.log('# below-the-flag replay equivalence for ' + GATE);
    console.log('# pre-ref: ' + opts.preRef + '   HEAD: ' +
        execSync('git rev-parse --short HEAD', { cwd: REPO }).toString().trim());
    console.log('# corpus: ' + opts.corpus + '   decoder schema: ' + DEC +
        '   chain: ' + opts.coin + '/' + opts.network);
    console.log('# db: ' + p.user + '@' + p.host + ':' + p.port + '  schemas ' +
        Object.values(DB).join(', '));

    // ---- N4: the substitution is exactly this spec's change ----------------
    section('N4 the old side differs from HEAD by exactly this change');
    const acct = unaccountedBatchCommits(opts.preRef);
    check(acct.offenders.length === 0,
        'every commit touching src/actions/batch.js since ' + opts.preRef +
        ' is a weighting commit or comment-only (' + acct.total + ' commits, ' +
        acct.declared + ' declared)',
        acct.offenders.length === 0 ? '' :
            'unaccounted behavioural commits: ' + JSON.stringify(acct.offenders));
    const otherReaders = execSync(
        'git grep -l ' + JSON.stringify(GATE) + ' HEAD -- src/ || true', { cwd: REPO })
        .toString().trim().split('\n').filter(Boolean)
        .map(l => l.replace(/^HEAD:/, '')).sort();
    check(otherReaders.join(',') === 'src/actions/batch.js,src/protocol_changes.js',
        'the flag is read from src/actions/batch.js alone (plus its own registration)',
        JSON.stringify(otherReaders));
    if (failures) { console.log('\nFAILED: the old side would not isolate this change'); process.exit(1); }

    const workdir = opts.workdir || path.join(os.tmpdir(), 'xchain-a6-oldtree');
    let oldRoot;
    try { oldRoot = materializeOldTree(opts.preRef, workdir); }
    catch (e) { console.error('cannot materialize the old tree: ' + e.message); process.exit(2); }
    info('old tree at ' + oldRoot);

    // The harness is identical by construction (the old tree IS HEAD's archive), but a
    // future edit to materializeOldTree could break that quietly, so it is asserted.
    for (const rel of ['test/integration/setup/indexer-launcher.js',
                       'test/integration/setup/db-connection.js',
                       'test/integration/setup/equivalence.js',
                       'test/integration/setup/decoder-seeder.js',
                       'package.json']) {
        const a = path.join(REPO, rel), b = path.join(oldRoot, rel);
        const same = fs.existsSync(b) && sha256File(a) === sha256File(b);
        check(same, 'identical in both trees: ' + rel, same ? '' : 'the two sides would run different harnesses');
    }
    const oldBatch = fs.readFileSync(path.join(oldRoot, 'src', 'actions', 'batch.js'), 'utf8');
    check(!oldBatch.includes(GATE), 'the OLD side\'s batch.js contains no reader of ' + GATE,
        oldBatch.includes(GATE) ? '--pre-ref is at or after the weighting work' : '');
    if (failures) { console.log('\nFAILED: old-tree construction'); process.exit(1); }

    // ---- databases and corpus --------------------------------------------
    section('corpus');
    const admin = await connect(p, undefined);
    for (const name of Object.values(DB)) {
        await admin.query('DROP DATABASE IF EXISTS `' + name + '`');
        await admin.query('CREATE DATABASE `' + name + '`');
    }
    if (opts.corpus === 'synthetic') {
        await admin.query('DROP DATABASE IF EXISTS `' + DEC + '`');
        await admin.query('CREATE DATABASE `' + DEC + '`');
    }
    await admin.end();

    process.env.TEST_DB_HOST = p.host;
    process.env.TEST_DB_PORT = String(p.port);
    process.env.TEST_DB_USER = p.user;
    process.env.TEST_DB_PASS = p.pass;
    process.env.TEST_DECODER_DB = DEC;
    process.env.INDEXER_COIN    = opts.coin;
    process.env.INDEXER_NETWORK = opts.network;

    let corpusBlocks = 0;
    if (opts.corpus === 'synthetic') {
        const dbc    = require(path.join(REPO, 'test/integration/setup/db-connection.js'));
        const Seeder = require(path.join(REPO, 'test/integration/setup/decoder-seeder.js'));
        const { seedGas } = require(path.join(REPO, 'test/integration/setup/gas-seeder.js'));
        await dbc.createDecoderSchema();
        const seeder = new Seeder(dbc.decoderQuery);
        // A4 is deliberately absent: D10's shapes need a source that provably cannot pay.
        await seedGas(seeder, { blockIndex: GAS_B, blockTime: T0 - STEP, addresses: [A1, A2], amount: '1000' });
        const blocks = corpus();
        for (const b of blocks) await seeder.seedBlock(b.block, b.time, b.txs);
        corpusBlocks = blocks.length + 1;
        info('seeded ' + corpusBlocks + ' decoder blocks (' + GAS_B + '..' + LAST_BLOCK + '), ' +
             blocks.reduce((n, b) => n + b.txs.length, 0) + ' transactions + gas preamble');
        await dbc.closeAll();
    } else {
        const dec = await connect(p, DEC);
        const rows = await dec.query('SELECT MIN(block_index) lo, MAX(block_index) hi, COUNT(*) n FROM blocks');
        const txs  = await dec.query('SELECT COUNT(*) n FROM transactions');
        const bat  = await dec.query(
            "SELECT COUNT(*) n FROM transactions WHERE UPPER(LEFT(data, 6)) = 'BATCH|'");
        corpusBlocks = Number(rows[0].n);
        info('replaying existing decoder schema ' + DEC + ': blocks ' + rows[0].lo + '..' + rows[0].hi +
             ' (' + corpusBlocks + '), ' + txs[0].n + ' transactions, ' + bat[0].n + ' of them BATCH');
        check(Number(bat[0].n) > 0, 'the real corpus actually contains BATCH transactions',
            'a corpus with no BATCH cannot be quoted as evidence about batches');
        await dec.end();
    }

    // ---- run the three sides ---------------------------------------------
    section('sides');
    const sides = [
        { key: 'OLD', root: oldRoot, gate: 'natural', db: DB.OLD, label: 'HEAD minus the weighting (' + opts.preRef + ' batch.js)' },
        { key: 'OFF', root: REPO,    gate: 'off',     db: DB.OFF, label: 'HEAD, flag UNARMED' },
        { key: 'ON',  root: REPO,    gate: 'natural', db: DB.ON,  label: 'HEAD, flag as shipped (control)' },
    ];
    const reports = {};
    for (const s of sides) {
        const env = Object.assign({}, process.env, {
            A6_SIDE_ROOT: s.root, A6_SIDE_GATE: s.gate,
            TEST_INDEXER_DB: s.db, TEST_DECODER_DB: DEC,
            INDEXER_COIN: opts.coin, INDEXER_NETWORK: opts.network,
        });
        const r = spawnSync(process.execPath, [__filename, '--side'],
            { env, encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 });
        const line = String(r.stdout || '').split('\n').find(l => l.startsWith(SIDE_MARK));
        if (r.status !== 0 || !line) {
            console.error('side ' + s.key + ' failed (exit ' + r.status + ')');
            console.error(String(r.stderr || '').split('\n').slice(-25).join('\n'));
            console.error(String(r.stdout || '').split('\n').slice(-15).join('\n'));
            process.exit(1);
        }
        reports[s.key] = JSON.parse(line.slice(SIDE_MARK.length));
        info(s.key.padEnd(3) + ' ' + s.label.padEnd(50) + reports[s.key].blocks + ' blocks in ' +
             (reports[s.key].ms / 1000).toFixed(1) + 's');
    }

    // ---- N1: the gate really was where we said it was ---------------------
    section('N1 gate state proven per side');
    const netKey = opts.network === 'mainnet' ? 'mainnet_time'
                 : opts.network === 'testnet' ? 'testnet_time' : 'regtest_time';
    check(reports.OFF.gate.registered === true && reports.OFF.gate[netKey] === UNARMED &&
          reports.OFF.gate.mainnet_time === UNARMED,
        'OFF registers ' + GATE + ' at the UNARMED sentinel on every network',
        JSON.stringify(reports.OFF.gate));
    check(reports.ON.gate.registered === true && reports.ON.gate[netKey] !== UNARMED,
        'ON registers ' + GATE + ' as active on ' + opts.network + ' (as shipped)',
        JSON.stringify(reports.ON.gate));
    check(reports.OLD.blocks === reports.OFF.blocks && reports.OFF.blocks === reports.ON.blocks,
        'all three sides processed the same block count',
        'OLD=' + reports.OLD.blocks + ' OFF=' + reports.OFF.blocks + ' ON=' + reports.ON.blocks);

    // ---- witnesses --------------------------------------------------------
    section('N3 witnesses: what the OLD code did with the corpus');
    const conns = {};
    for (const k of ['OLD', 'OFF', 'ON']) conns[k] = await connect(p, DB[k]);
    const q = { OLD: queryFnFor(conns.OLD), OFF: queryFnFor(conns.OFF), ON: queryFnFor(conns.ON) };

    const wOld = await witnesses(q.OLD);
    const wOn  = await witnesses(q.ON);
    info('OLD row counts: ' + JSON.stringify(wOld.counts));
    info('ON  row counts: ' + JSON.stringify(wOn.counts));

    if (opts.corpus === 'synthetic') {
        info('OLD batch verdicts by shape: ' + JSON.stringify(
            Object.fromEntries(Object.keys(SHAPE_BLOCK).map(s => [s, wOld.shape(s)]))));
        info('ON  batch verdicts by shape: ' + JSON.stringify(
            Object.fromEntries(Object.keys(SHAPE_BLOCK).map(s => [s, wOn.shape(s)]))));

        const LIMIT = 'invalid: COMMAND (limit)';
        // The OLD side has to be doing the thing the flag is supposed to change, or
        // "identical" is satisfied by two sides that both refused everything.
        check(wOld.shape('S1') === 'valid', 'S1 250 ordinary sub-commands: OLD admits them', wOld.shape('S1'));
        check(wOld.shape('S2') === LIMIT,   'S2 251: the count pre-filter refuses it on OLD too', wOld.shape('S2'));
        check(wOld.shape('S3') === 'valid', 'S3 1 DEPLOY + 249 SENDs: OLD admits (the flat cap counts it as 250)', wOld.shape('S3'));
        check(wOld.shape('S5') === 'valid', 'S5 9 EXECUTEs: OLD admits (no VM weight below the flag)', wOld.shape('S5'));
        check(wOld.shape('S7') === 'valid', 'S7 11 AIRDROPs: OLD admits (no fan-out weight below the flag)', wOld.shape('S7'));
        check(wOld.shape('S9') === 'invalid: DEPLOY (limit)',
            'S9 two DEPLOYs: OLD rejects on the pre-existing DEPLOY cap', wOld.shape('S9'));
        check(wOld.shape('S10') === 'valid',
            'S10 3 ORDERs from a gasless source: OLD has no duration-fee collapse', wOld.shape('S10'));
        check(wOld.shape('S12') === 'valid',
            'S12 2 EXECUTEs from a gasless source: OLD has no VM-floor collapse', wOld.shape('S12'));
    }

    // ---- the A6 assertion -------------------------------------------------
    section('A6: OLD vs HEAD-with-the-flag-unarmed');
    const eq = require(path.join(REPO, 'test/integration/setup/equivalence.js'));
    const stateOLD = await eq.captureDbState(q.OLD, { mode: 'strict' });
    const stateOFF = await eq.captureDbState(q.OFF, { mode: 'strict' });
    const stateON  = await eq.captureDbState(q.ON,  { mode: 'strict' });

    const chainOLD = await eq.readHashChain(q.OLD);
    const chainOFF = await eq.readHashChain(q.OFF);
    const chainON  = await eq.readHashChain(q.ON);

    let hashOk = true, hashErr = '';
    try { eq.assertHashChainsEqual(chainOLD, chainOFF, 'OLD', 'OFF'); }
    catch (e) { hashOk = false; hashErr = e.message; }
    check(hashOk, 'consensus hash chain identical at all ' + chainOLD.length +
        ' blocks (ledger/actions/contracts + state)',
        hashOk ? 'first block ' + chainOLD[0].block_index + ' ledger=' + String(chainOLD[0].ledger).slice(0, 16) + '...  ' +
                 'last block ' + chainOLD[chainOLD.length - 1].block_index + ' ledger=' +
                 String(chainOLD[chainOLD.length - 1].ledger).slice(0, 16) + '...'
               : hashErr);

    const dOffOld = diffStates(stateOLD, stateOFF);
    check(dOffOld.length === 0,
        'every table byte-identical OLD vs OFF (' + Object.keys(stateOLD).length + ' tables, strict mode)',
        dOffOld.length === 0
            ? 'row totals: ' + Object.values(stateOLD).reduce((n, r) => n + r.length, 0)
            : JSON.stringify(dOffOld, null, 2));

    // ---- N2: the harness can see a fork -----------------------------------
    section('N2 negative control: the SAME comparator against the flag ON');
    const dOnOld    = diffStates(stateOLD, stateON);
    const forkPoint = firstDivergence(chainOLD, chainON);
    const delta     = verdictDelta(wOld, wOn);

    if (opts.corpus === 'synthetic') {
        check(dOnOld.length > 0, 'forcing the gate ON moves committed state (so the pass above is not vacuous)',
            dOnOld.length > 0
                ? dOnOld.length + ' tables differ: ' + dOnOld.map(d => d.table + '(' + d.aRows + '->' + d.bRows + ')').join(', ')
                : 'ON matched OLD: the corpus no longer reaches the gated code and the pass above proves NOTHING');
        check(forkPoint !== null, 'and it moves the CONSENSUS HASH CHAIN, not just local rows',
            forkPoint ? 'first divergence: block ' + forkPoint.block + ' ' + forkPoint.field +
                        ' OLD=' + forkPoint.a + '... ON=' + forkPoint.b + '...'
                      : 'the gate moved rows but not the hash chain');

        const LIMIT = 'invalid: COMMAND (limit)';
        const GASX  = 'invalid: GAS (insufficient)';
        check(wOn.shape('S3') === LIMIT, 'control: S3 (30+249=279) is refused with the flag ON', wOn.shape('S3'));
        check(wOn.shape('S5') === LIMIT, 'control: S5 (9x30=270) is refused with the flag ON', wOn.shape('S5'));
        check(wOn.shape('S7') === LIMIT, 'control: S7 (11x25=275) is refused with the flag ON', wOn.shape('S7'));
        check(wOn.shape('S10') === GASX, 'control: S10 collapses to one GAS record with the flag ON', wOn.shape('S10'));
        check(wOn.shape('S12') === GASX, 'control: S12 collapses to one GAS record with the flag ON', wOn.shape('S12'));

        // Targeted, not blanket: every shape that sums to at most the budget must reach the
        // SAME verdict on both sides, or the control is measuring a rule that rejects
        // everything rather than the budget.
        for (const s of ['S1', 'S2', 'S4', 'S6', 'S8', 'S9', 'S11', 'S13'])
            check(wOn.shape(s) === wOld.shape(s),
                'control is TARGETED: ' + s + ' reaches the same verdict on both sides',
                'OLD=' + wOld.shape(s) + ' ON=' + wOn.shape(s));

        const movedTables = new Set(dOnOld.map(d => d.table));
        for (const t of ['batches', 'actions', 'sends'])
            check(movedTables.has(t), 'control moves `' + t + '` (the surface this spec changes)',
                movedTables.has(t) ? '' : 'the corpus does not reach the gated code that writes ' + t);
    } else {
        // A real chain is not obliged to contain a straddling batch. Whichever way it
        // lands is a MEASUREMENT, reported and not asserted, because asserting either
        // direction here would make the tool lie about a corpus it does not control.
        info('real-corpus control: ' + (dOnOld.length > 0
            ? dOnOld.length + ' tables differ with the flag ON: ' +
              dOnOld.map(d => d.table + '(' + d.aRows + '->' + d.bRows + ')').join(', ')
            : 'the flag ON changes NOTHING on this corpus, i.e. no batch on this chain ' +
              'straddles the budget - the measured no-op the spec predicts'));
        info('real-corpus first hash divergence vs OLD: ' +
            (forkPoint ? 'block ' + forkPoint.block + ' ' + forkPoint.field : 'none'));
    }

    info('BATCH verdict delta OLD -> ON: ' + (delta.length
        ? delta.length + ' batches move; ' + JSON.stringify(delta.slice(0, 8))
        : 'none'));

    // ---- coverage statement ----------------------------------------------
    section('coverage of this run');
    if (opts.corpus === 'synthetic') {
        info('COVERED, driven on all three sides: the weight budget for the default class,');
        info('  the VM class (DEPLOY, EXECUTE) and the fan-out class (AIRDROP), the count');
        info('  pre-filter, the surviving DEPLOY cap and its own error string, and the D10');
        info('  spam collapse in both its new forms (duration-metered ORDER, EXECUTE floor)');
        info('  together with its refusal to collapse where a cost is not knowable.');
        info('NOT COVERED: contract code never runs - the EXECUTEs name a contract index that');
        info('  does not exist, so the corpus needs no isolate. The VM dispatch path is the');
        info('  real-corpus run\'s job. XEXEC weighs 30 but is system-injected, so no wire');
        info('  transaction can place one in a BATCH; it stays unit-tier only.');
    } else {
        info('COVERED: every BATCH, DEPLOY, EXECUTE, AIRDROP and ORDER this chain actually');
        info('  produced, replayed from its first block by both code paths, including real');
        info('  contract deployment and execution.');
        info('NOT COVERED: whatever this chain does not contain. The BATCH count printed above');
        info('  is the whole of what the batch surface was measured over, and the negative');
        info('  control for this flag lives in the synthetic run, not here.');
    }

    for (const k of ['OLD', 'OFF', 'ON']) { try { await conns[k].end(); } catch (e) {} }

    if (!opts.keep) {
        const a2 = await connect(p, undefined);
        for (const name of Object.values(DB)) await a2.query('DROP DATABASE IF EXISTS `' + name + '`');
        if (opts.corpus === 'synthetic') await a2.query('DROP DATABASE IF EXISTS `' + DEC + '`');
        await a2.end();
        fs.rmSync(workdir, { recursive: true, force: true });
    } else {
        info('kept: schemas ' + Object.values(DB).join(', ') + ' and old tree ' + workdir);
    }

    console.log(failures ? '\nFAILED: ' + failures + ' assertion(s)'
                         : '\nALL ASSERTIONS HOLD (A6 evidence for the surfaces listed above)');
    process.exit(failures ? 1 : 0);
}
