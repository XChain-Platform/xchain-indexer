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
 * BELOW-THE-FLAG REPLAY WITNESS for the MIRROR-ADMISSION family (BF4 and AB4).
 *
 * WHY THIS EXISTS. The family re-keys eleven barrier predicates and six binding
 * rules off the block's own stamp and onto a per-table admission HEIGHT. Every
 * one of those changes is gated by MIRROR_ADMISSION_CONSUMER_ACTIVATION (and, for
 * the anchor member, ANCHOR_ATTEST_BARRIER_ACTIVATION), and the whole train rests
 * on one claim: BELOW the activation the new code commits exactly what the old
 * code committed, byte for byte. If any of it leaks below the gate, a from-genesis
 * replay reaches verdicts the live fleet never wrote and the ledger forks. BF4's
 * lower half and AB4 are the evidence for that claim, and the milestone requires
 * them DRIVEN rather than read.
 *
 * ------------------------------------------------------------------------------
 * THE OPERATIONALIZATION, AND WHY IT IS NOT A PRE-FAMILY TREE
 *
 * BF4 as written says "an OLD-versus-NEW replay ... produces byte-identical
 * state_hash, actions_hash and ledger_hash at every block". The obvious reading is
 * an OLD tree, and it is the wrong tool here: the family landed across seven
 * commits in two repos and the indexer's whole structure pass moved every one of
 * the files afterwards, so a revert or a file swap would put the structure pass on
 * one side of the comparison and not the other, and the run would be measuring the
 * refactor rather than the gate.
 *
 * What BF4 has to establish can be stated without an old tree, because the gate is
 * a HEIGHT and a height has two sides inside one corpus:
 *
 *   side OFF       - HEAD, activation INERT on every network (the regtest lever
 *                    unset). This is the code every node runs below its height.
 *   side BOUNDARY  - HEAD, activation armed at --activation-height H, a height
 *                    INSIDE the corpus. Below H this process is in the legacy era
 *                    and at or above H it is in the admission era, judged by the
 *                    REAL predicates rather than by a stub.
 *   side ON        - HEAD, armed at 0 (genesis). The NEGATIVE CONTROL, never
 *                    evidence: it exists so that a corpus which never reaches the
 *                    gated code cannot pass this tool by agreeing about nothing.
 *
 * All three replay the SAME decoder corpus from genesis into three schemas of
 * their own. The assertions:
 *
 *   A1 (BF4 below, AB4)  OFF and BOUNDARY agree on ledger_hash, actions_hash,
 *                        contract_hash and state_hash at EVERY block below H.
 *                        This is the boundary comparison, over strictly more
 *                        blocks than any single boundary block would carry.
 *   A2 (the control)     ON differs from OFF somewhere, or the corpus never
 *                        reached an admission-bearing path and A1 is vacuous.
 *                        Reported as a FAILURE of this tool, not as a pass.
 *   A3 (era proof)       Each side reports the activation its OWN process
 *                        resolved, and the run refuses unless the three differ
 *                        in the way the sides above describe.
 *
 * WHY THE ARMING IS MOVED RATHER THAN THE PREDICATE STUBBED: the below-the-flag
 * condition IS "the height has not arrived". Arming the real regtest resolver
 * makes the real predicate answer the real way; a stubbed predicate would prove
 * that a stub returns false.
 *
 * ------------------------------------------------------------------------------
 * THE REFUSAL CLAUSE, which matters more than the assertion
 *
 * A replay over a corpus with no admission-bearing rows agrees trivially, and it
 * prints the same tally line as a real pass. So this tool never prints a bare
 * green: it exits NON-ZERO WITH A NAMED REASON when its own preconditions are
 * unmet, and it always prints the block count it compared against the corpus it
 * was pointed at.
 *
 *   exit 0  every assertion holds AND the control shows the gate does something
 *   exit 1  an assertion failed: the first divergent block and field are printed
 *   exit 2  REFUSED: a precondition is unmet; the reason is the last line
 *   exit 3  VACUOUS: the corpus carries no blocks below H, so nothing was measured
 *
 * DATABASE COORDINATES ARE EXPLICIT, NEVER LOADED FROM .env. The harness this
 * tool drives falls back to .env INDEXER_DB_* when TEST_DB_* is unset, which on a
 * validator host points a replay at the LIVE indexer database. This tool refuses
 * to start unless the coordinates were named on the command line or in TEST_DB_*,
 * and it passes what it was given to the children explicitly.
 *
 * USAGE
 *   node bin/verify-mirror-admission-replay-equivalence.js \
 *        --coin BTC --network regtest \
 *        --decoder-db ma_witness_dec --activation-height 120 \
 *        --db-host 127.0.0.1 --db-port 3306 --db-user replay --db-pass-env MA_DB_PASS
 *
 * Options: --schema-prefix <name> (default ma_witness_replay_<coin>), --sides
 * <off,boundary,on>, --dry-run (prove the sides and their eras, replay nothing,
 * exit 2), --keep (leave the schemas), --workdir <dir>.
 *
 * The password is read from the environment variable NAMED by --db-pass-env, so
 * it never appears in a process list or in this tool's output.
 *
 *********************************************************************/

'use strict';

const path = require('path');
const fs   = require('fs');
const { spawn } = require('child_process');

const REPO      = path.resolve(__dirname, '..');
const SIDE_MARK = '###MA-SIDE###';
const EXIT      = { PASS: 0, FAIL: 1, REFUSED: 2, VACUOUS: 3 };
const ARM_ENV   = 'XC_MIRROR_ADMISSION_ACTIVATION';
const HASH_FIELDS = ['ledger', 'actions', 'contracts', 'state'];

// The three sides, and the arming each one gives its own child process. `null`
// means the lever is UNSET, which is what leaves every regtest key inert.
const SIDES = {
    off:      { arm: null,  label: 'OFF (inert, the code below every height)' },
    boundary: { arm: 'H',   label: 'BOUNDARY (armed at --activation-height)' },
    on:       { arm: '0',   label: 'ON (armed at genesis, the negative control)' },
};

let failures = 0;

// Guarded, because the pure helpers below are exported for their own unit drive:
// an unguarded body would start a replay the moment anything required this file.
if (require.main === module) {
    if (process.argv.includes('--side')) {
        runSide().catch((e) => { console.error('SIDE ERROR: ' + ((e && e.stack) || e)); process.exit(1); });
    } else {
        main().catch((e) => { console.error('ERR ' + ((e && e.stack) || e)); process.exit(EXIT.REFUSED); });
    }
}

// ---------------------------------------------------------------------------
// CHILD MODE: replay the shared decoder corpus with ONE side's arming.
// ---------------------------------------------------------------------------

async function runSide() {
    const key = process.env.MA_SIDE_KEY;

    // The era this process actually resolved, read from the real gate rather than
    // from the variable we set: an unrecognised value leaves the resolver INERT
    // and would otherwise make an "armed" side silently a second OFF.
    const gate = require(path.join(REPO, 'src', 'consensus', 'gates', 'mirror_admission_gate.js'));
    const coin = process.env.INDEXER_COIN, network = process.env.INDEXER_NETWORK;
    const era = {
        armEnv:   process.env[ARM_ENV] === undefined ? null : String(process.env[ARM_ENV]),
        producer: gate.MIRROR_ADMISSION_ACTIVATION[coin + ':' + network],
        consumer: gate.MIRROR_ADMISSION_CONSUMER_ACTIVATION[coin + ':' + network],
    };

    const launcher = require(path.join(REPO, 'test', 'integration', 'setup', 'indexer-launcher.js'));
    const indexer  = await launcher.initIndexer();
    const t0 = Date.now();
    const blocks = await launcher.processBlocks(indexer);
    const ms = Date.now() - t0;

    const eq = require(path.join(REPO, 'test', 'integration', 'setup', 'equivalence.js'));
    const q = (sql, args) => indexer.indexerDb.query(sql, args);
    const chain = await eq.readHashChain(q);
    await launcher.destroyIndexer(indexer);

    console.log(SIDE_MARK + JSON.stringify({ key, blocks, ms, era, chain }));
    process.exit(0);
}

// ---------------------------------------------------------------------------
// PARENT
// ---------------------------------------------------------------------------

function check(ok, label, detail) {
    console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '\n          ' + detail : ''));
    if (!ok) failures += 1;
    return ok;
}
function info(msg) { console.log('  ....  ' + msg); }
function section(title) { console.log('\n== ' + title + ' ' + '='.repeat(Math.max(0, 62 - title.length))); }

// A named refusal is the whole point: the last line says why, and the exit code
// says it was not a verdict.
function refuse(reason) {
    console.log('\nREFUSED: ' + reason);
    process.exit(EXIT.REFUSED);
}

function parseArgs(argv) {
    const o = { coin: 'BTC', network: 'regtest', decoderDb: null, activationHeight: null,
                schemaPrefix: null, sides: ['off', 'boundary', 'on'], dryRun: false, keep: false,
                workdir: null, db: { host: null, port: null, user: null, passEnv: null } };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--coin')                   o.coin = String(argv[++i]).toUpperCase();
        else if (a === '--network')           o.network = String(argv[++i]);
        else if (a === '--decoder-db')        o.decoderDb = argv[++i];
        else if (a === '--activation-height') o.activationHeight = Number(argv[++i]);
        else if (a === '--schema-prefix')     o.schemaPrefix = argv[++i];
        else if (a === '--sides')             o.sides = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
        else if (a === '--db-host')           o.db.host = argv[++i];
        else if (a === '--db-port')           o.db.port = argv[++i];
        else if (a === '--db-user')           o.db.user = argv[++i];
        else if (a === '--db-pass-env')       o.db.passEnv = argv[++i];
        else if (a === '--dry-run')           o.dryRun = true;
        else if (a === '--keep')              o.keep = true;
        else if (a === '--workdir')           o.workdir = argv[++i];
    }
    return o;
}

/**
 * The database coordinates, EXPLICIT or nothing. Returns null when the caller
 * named none, which is a refusal rather than a fallback: the harness would
 * otherwise read .env and point a from-genesis replay at the live indexer DB.
 */
function explicitDbParams(o) {
    const host = o.db.host || process.env.TEST_DB_HOST || null;
    const port = o.db.port || process.env.TEST_DB_PORT || null;
    const user = o.db.user || process.env.TEST_DB_USER || null;
    if (host === null || port === null || user === null) return null;
    let pass = null;
    if (o.db.passEnv) {
        if (process.env[o.db.passEnv] === undefined)
            return { missingPassEnv: o.db.passEnv };
        pass = process.env[o.db.passEnv];
    } else if (process.env.TEST_DB_PASS !== undefined) {
        pass = process.env.TEST_DB_PASS;
    } else {
        return { missingPassEnv: '--db-pass-env or TEST_DB_PASS' };
    }
    return { host, port: String(port), user, pass };
}

/** Which era each side must have resolved, so an arming that silently failed
 *  cannot be mistaken for the side it was supposed to be. */
function eraExpectation(side, height) {
    if (side === 'off')      return { value: null,   how: 'INERT (the lever unset)' };
    if (side === 'boundary') return { value: height, how: 'armed at the boundary height' };
    return { value: 0, how: 'armed at genesis' };
}

function armValueFor(side, height) {
    const arm = SIDES[side].arm;
    return arm === 'H' ? String(height) : arm;
}

/** The blocks strictly below the boundary, which is the region BF4 is about. */
function belowBoundary(chain, height) {
    return chain.filter((b) => b.block_index < height);
}

/**
 * The first block at which two chains disagree on any consensus hash, or null.
 * Compared field by field so the report names WHICH hash forked, which is what
 * separates a ledger divergence from an action-shape divergence.
 */
function firstDivergence(chainA, chainB) {
    const len = Math.min(chainA.length, chainB.length);
    for (let i = 0; i < len; i += 1) {
        const a = chainA[i], b = chainB[i];
        if (a.block_index !== b.block_index)
            return { block: a.block_index, field: 'sequence', a: a.block_index, b: b.block_index };
        for (const f of HASH_FIELDS)
            if (a[f] !== b[f]) return { block: a.block_index, field: f, a: a[f], b: b[f] };
    }
    if (chainA.length !== chainB.length)
        return { block: null, field: 'length', a: chainA.length, b: chainB.length };
    return null;
}

function runSideProcess(side, env, logPath) {
    return new Promise((resolve) => {
        const log = fs.createWriteStream(logPath);
        const child = spawn(process.execPath, [__filename, '--side'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        child.stdout.on('data', (d) => { stdout += d; log.write(d); });
        child.stderr.on('data', (d) => log.write(d));
        child.on('close', (status) => { log.end(); resolve({ side, status, stdout }); });
    });
}

function parseSideOutput(side, res) {
    const line = res.stdout.split('\n').find((l) => l.startsWith(SIDE_MARK));
    if (!line) return null;
    return JSON.parse(line.slice(SIDE_MARK.length));
}

function sideEnv(o, p, side, schema) {
    return Object.assign({}, process.env, {
        MA_SIDE_KEY: side,
        INDEXER_COIN: o.coin, INDEXER_NETWORK: o.network,
        TEST_DB_HOST: p.host, TEST_DB_PORT: p.port, TEST_DB_USER: p.user, TEST_DB_PASS: p.pass,
        TEST_DECODER_DB: o.decoderDb, TEST_INDEXER_DB: schema,
        // Each side's arming, and ONLY that, is what differs between the children.
        [ARM_ENV]: armValueFor(side, o.activationHeight),
    });
}

function provePreconditions(o, p) {
    if (p === null)
        refuse('no database coordinates: pass --db-host/--db-port/--db-user (and --db-pass-env), or set ' +
               'TEST_DB_HOST/TEST_DB_PORT/TEST_DB_USER. This tool never falls back to .env, because on a ' +
               'validator host that points a from-genesis replay at the live indexer database');
    if (p.missingPassEnv)
        refuse('the database password must come from an environment variable named by ' + p.missingPassEnv +
               ', so it never reaches a process list or this tool\'s output');
    if (!o.decoderDb) refuse('--decoder-db <schema> is required: the corpus is what makes this measurement mean anything');
    if (!Number.isSafeInteger(o.activationHeight) || o.activationHeight <= 0)
        refuse('--activation-height <H> is required and must be a positive integer: it is the boundary the ' +
               'comparison is about, and a height outside the corpus measures nothing');
    for (const s of o.sides) if (!SIDES[s]) refuse('unknown side ' + JSON.stringify(s) + '; the sides are off, boundary, on');
    if (!o.sides.includes('off') || !o.sides.includes('boundary'))
        refuse('sides off and boundary are the comparison itself and cannot be dropped');
    if (o.network === 'mainnet')
        refuse('this witness never runs against mainnet: the family is inert there under the write hold, and a ' +
               'from-genesis replay of mainnet history is a different tool');
}

async function main() {
    const o = parseArgs(process.argv.slice(2));
    const p = explicitDbParams(o);
    const prefix = o.schemaPrefix || ('ma_witness_replay_' + o.coin.toLowerCase());
    const workdir = o.workdir || fs.mkdtempSync(path.join(require('os').tmpdir(), 'ma-witness-'));

    console.log('# below-the-flag replay witness for the mirror-admission family (BF4, AB4)');
    console.log('# chain ' + o.coin + '/' + o.network + '   boundary height ' + o.activationHeight);
    console.log('# corpus ' + (o.decoderDb || '(none)') + '   schemas ' + prefix + '_{' + o.sides.join(',') + '}');

    section('preconditions');
    provePreconditions(o, p);
    info('db ' + p.user + '@' + p.host + ':' + p.port + ' (password from the environment, never printed)');
    info('sides: ' + o.sides.map((s) => s + ' = ' + SIDES[s].label).join('; '));
    fs.mkdirSync(workdir, { recursive: true });
    info('logs under ' + workdir);

    if (o.dryRun) {
        console.log('\nREFUSED: --dry-run proved the sides and their arming and replayed nothing');
        process.exit(EXIT.REFUSED);
    }

    section('replay');
    const results = {};
    for (const side of o.sides) {
        const logPath = path.join(workdir, side + '.log');
        const res = await runSideProcess(side, sideEnv(o, p, side, prefix + '_' + side), logPath);
        const parsed = parseSideOutput(side, res);
        if (res.status !== 0 || parsed === null)
            refuse('side ' + side + ' exited ' + res.status + ' without a result; its log is ' + logPath);
        results[side] = parsed;
        info(side + ': ' + parsed.blocks + ' blocks in ' + Math.round(parsed.ms / 1000) + 's, ' +
             'consumer activation ' + JSON.stringify(parsed.era.consumer));
    }

    section('A3: each side resolved the era it was supposed to');
    for (const side of o.sides) {
        const want = eraExpectation(side, o.activationHeight);
        check(results[side].era.consumer === want.value,
            side + ' resolved the consumer activation ' + want.how,
            'expected ' + JSON.stringify(want.value) + ', got ' + JSON.stringify(results[side].era.consumer));
    }

    section('A1: OFF and BOUNDARY are byte-identical BELOW the boundary');
    const offBelow = belowBoundary(results.off.chain, o.activationHeight);
    const bndBelow = belowBoundary(results.boundary.chain, o.activationHeight);
    if (offBelow.length === 0) {
        console.log('\nVACUOUS: the corpus carries no block below ' + o.activationHeight +
                    ', so the boundary comparison measured nothing');
        process.exit(EXIT.VACUOUS);
    }
    const div = firstDivergence(offBelow, bndBelow);
    check(div === null, 'all four hashes agree at every one of the ' + offBelow.length + ' blocks below the boundary',
        div === null ? '' : 'first divergence at block ' + div.block + ' on ' + div.field +
                            ': off=' + div.a + ' boundary=' + div.b);

    if (o.sides.includes('on')) {
        section('A2: the control, the gate must actually do something');
        const onDiv = firstDivergence(results.off.chain, results.on.chain);
        check(onDiv !== null,
            'ON differs from OFF somewhere, so the corpus reaches the gated code',
            onDiv !== null ? 'first difference at block ' + onDiv.block + ' on ' + onDiv.field
                           : 'ON and OFF are identical at every block: this corpus never reaches an ' +
                             'admission-bearing path, so the A1 pass above is vacuous');
    }

    console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + ': ' + offBelow.length +
                ' blocks below the boundary compared on ledger, actions, contract and state hashes; ' +
                results.off.chain.length + ' blocks in the corpus');
    process.exit(failures === 0 ? EXIT.PASS : EXIT.FAIL);
}

module.exports = { parseArgs, explicitDbParams, eraExpectation, armValueFor, belowBoundary,
                   firstDivergence, sideEnv, SIDES, EXIT, HASH_FIELDS };
