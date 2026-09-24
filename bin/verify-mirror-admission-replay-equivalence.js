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
 * WHAT "ADMISSION-BEARING" NEEDS, measured on the rail 2026-09-17 (A2 failed with
 * ON and OFF identical at all 102 blocks). Every consumer-gated read is a select
 * over a HUB-MIRROR table (cross_chain_matches and cross_chain_calls in
 * db/cross_chain, bridge_transfers and policy_snapshots in bridge_settle,
 * attestation_responses in db/attests) or a barrier that needs a hub connection.
 * A side process has no hub connection, and its fresh schema's mirror tables are
 * EMPTY, so over a decoder corpus alone arming changes no read at any block and
 * the comparison cannot be anything but vacuous. The corpus is therefore TWO
 * schemas: the decoder schema, and --mirror-db, a hub mirror whose rows every side
 * copies into its own schema before it replays (the state a from-genesis resync
 * starts from). The run refuses, before any verdict, when:
 *
 *   - no --mirror-db is named;
 *   - the mirror holds no row carrying this chain's admission height in a table a
 *     consumer binds by it, because only such a row binds differently armed;
 *   - the sides did not copy the same mirror;
 *   - a side's replay did not run the production pass that reads a table holding
 *     admission-era rows (ADMISSION_TABLE_PASSES), because that side never read
 *     the rows and agrees with every other side about them by not looking;
 *   - the corpus carries no block at or above --activation-height, because then
 *     BOUNDARY never arms inside it and is a second OFF.
 *
 * A mirror that passes and still leaves ON equal to OFF is a FAIL of A2: the rows
 * exist and arming moved none of them, which is a finding, not a corpus gap.
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
 *        --decoder-db ma_witness_dec --mirror-db ma_witness_mirror --activation-height 120 \
 *        --db-host 127.0.0.1 --db-port 3306 --db-user replay --db-pass-env MA_DB_PASS
 *
 * --mirror-db names the hub mirror schema every side copies before it replays (see
 * WHAT "ADMISSION-BEARING" NEEDS above); it is required, on the same server.
 *
 * Options: --schema-prefix <name> (default ma_witness_replay_<coin>), --sides
 * <off,boundary,on>, --dry-run (prove the sides and their eras, replay nothing,
 * exit 2), --keep (leave the replay schemas and workdir, and print their names),
 * --workdir <new directory below the system temporary root>.
 *
 * The password is read from the environment variable NAMED by --db-pass-env, so
 * it never appears in a process list or in this tool's output.
 *
 *********************************************************************/

'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { spawn } = require('child_process');

const REPO      = path.resolve(__dirname, '..');
const SIDE_MARK = '###MA-SIDE###';
const EXIT      = { PASS: 0, FAIL: 1, REFUSED: 2, VACUOUS: 3 };
const ARM_ENV   = 'XC_MIRROR_ADMISSION_ACTIVATION';
const HASH_FIELDS = ['ledger', 'actions', 'contracts', 'state'];

// The three sides, and the arming each one gives its own child process. `null`
// means the lever is UNSET, which is what leaves every regtest key inert: sideEnv()
// deletes the key for it rather than passing null, which spawn would stringify.
const SIDES = {
    off:      { arm: null,  label: 'OFF (inert, the code below every height)' },
    boundary: { arm: 'H',   label: 'BOUNDARY (armed at --activation-height)' },
    on:       { arm: '0',   label: 'ON (armed at genesis, the negative control)' },
};

// A schema name this tool will splice into SQL: letters, digits and underscore only.
const SCHEMA_NAME = /^[A-Za-z0-9_]+$/;

let failures = 0;

class WitnessExit extends Error {
    constructor(code) {
        super('witness exit ' + code);
        this.code = code;
    }
}

class InterruptedExit extends Error {}

// Adapt the indexer Database wrapper to the raw-query callback expected by the
// equivalence reader; query exists only on the wrapper's pooled connections.
function queryIndexerDb(indexerDb) {
    return (sql, args) => indexerDb.doQuery(sql, args);
}

// Guarded, because the pure helpers below are exported for their own unit drive:
// an unguarded body would start a replay the moment anything required this file.
if (require.main === module) {
    if (process.argv.includes('--side')) {
        runSide().catch((e) => { console.error('SIDE ERROR: ' + ((e && e.stack) || e)); process.exit(1); });
    } else {
        runParent();
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
    const era = resolvedEra(gate);

    const launcher = require(path.join(REPO, 'test', 'integration', 'setup', 'indexer-launcher.js'));
    const indexer  = await launcher.initIndexer();
    const q = queryIndexerDb(indexer.indexerDb);

    // The mirror goes in BEFORE the first block: every side must replay against the same
    // mirrored rows, or the sides differ by their inputs and not by their arming.
    const mirrorDb = sideMirrorDb(process.argv);
    const mirror = mirrorDb === null ? null : await loadMirror(q, mirrorDb, process.env.INDEXER_COIN);

    const t0 = Date.now();
    const blocks = await launcher.processBlocks(indexer);
    const ms = Date.now() - t0;

    const eq = require(path.join(REPO, 'test', 'integration', 'setup', 'equivalence.js'));
    const chain = await eq.readHashChain(q);
    // What the replay actually ran, reported rather than assumed, so the parent can refuse a
    // side that never reached the pass reading an admission-bearing table (skippedPassRefusal).
    const passes = typeof launcher.passesRun === 'function' ? launcher.passesRun(indexer) : null;
    await launcher.destroyIndexer(indexer);

    console.log(SIDE_MARK + JSON.stringify({ key, blocks, ms, era, mirror, passes, chain }));
    process.exit(0);
}

/** The --mirror-db a side process was spawned with, or null. Passed on argv, so no new env read. */
function sideMirrorDb(argv) {
    const i = argv.indexOf('--mirror-db');
    return (i >= 0 && i + 1 < argv.length && SCHEMA_NAME.test(String(argv[i + 1]))) ? String(argv[i + 1]) : null;
}

/**
 * The admission column a consumer binds each hub-mirror table by for `coin`, from the read
 * sites (db/cross_chain mirrorBindClause for matches and calls, bridge_settle for transfers and
 * policies, db/attests mirror_responses for the BTC-only attest rail). A table absent here binds
 * nothing by height for this chain, so none of its rows can bind differently armed.
 */
function admissionColumnsFor(coin) {
    const c = String(coin || '').trim().toLowerCase();
    if (!/^[a-z]+$/.test(c)) return {};
    const out = {
        cross_chain_matches: 'admit_block_' + c,
        cross_chain_calls:   'admit_block_' + c,
        bridge_transfers:    'admit_block_' + c,
        policy_snapshots:    'admit_block_' + c,
    };
    if (c === 'btc') out.attestation_responses = 'admit_block_btc';
    return out;
}

/**
 * For each table admissionColumnsFor names, the production block pass group whose consumer
 * binds its rows (src/XChainIndexer/block_passes.js). A replay that did not run the group never
 * read the table, however many admission-era rows the mirror put there.
 */
const ADMISSION_TABLE_PASSES = Object.freeze({
    cross_chain_matches:   Object.freeze({ pass: 'runSettlementPasses', consumer: 'processCrossChainSettlements' }),
    bridge_transfers:      Object.freeze({ pass: 'runSettlementPasses', consumer: 'processBridgeSettlePass' }),
    policy_snapshots:      Object.freeze({ pass: 'runSettlementPasses', consumer: 'processBridgeSettlePass' }),
    cross_chain_calls:     Object.freeze({ pass: 'runCrossChainPasses', consumer: 'processCrossChainCalls' }),
    attestation_responses: Object.freeze({ pass: 'runCrossChainPasses', consumer: 'processAttestationResponses' }),
});

/**
 * The first side whose replay skipped the pass reading a table that holds admission-era rows,
 * as a named reason, or null. A side that reports no pass list at all is refused too: a replay
 * that cannot say what it ran cannot prove it read the rows.
 *
 * @returns {string|null}
 */
function skippedPassRefusal(results) {
    for (const s of Object.keys(results || {})) {
        const rows = (results[s].mirror && results[s].mirror.admissionRows) || {};
        const ran = Array.isArray(results[s].passes) ? results[s].passes : null;
        for (const [table, n] of Object.entries(rows)) {
            if (!(Number(n) > 0)) continue;
            const need = ADMISSION_TABLE_PASSES[table];
            if (!need)
                return 'table ' + table + ' holds ' + n + ' admission-era rows and no block pass is named as its reader, ' +
                       'so no replay can be shown to have read them';
            if (ran === null || !ran.includes(need.pass))
                return 'side ' + s + ' replayed without the ' + need.pass + ' pass (' + need.consumer + '), which reads ' +
                       table + ', while the mirror holds ' + n + ' admission-era rows there: the side never read them, so ' +
                       'agreement over them is vacuous (passes run: ' + JSON.stringify(ran) + ')';
        }
    }
    return null;
}

/**
 * Copy every hub-mirror table (the table lifecycle registry's `replication: 'hub-mirror'`
 * rows) from `mirrorDb` into this side's own schema, over the columns both carry, then count
 * the rows that carry this chain's admission height. Same server, one INSERT ... SELECT per
 * table, so the rows never pass through this process.
 *
 * @returns {Promise<{source: string, copied: object, admissionRows: object}>} copied is a row
 *          count per table, or null where the mirror has no such table
 */
async function loadMirror(q, mirrorDb, coin) {
    const lifecycle = require(path.join(REPO, 'src', 'hub', 'table_lifecycle.js'));
    const tables = lifecycle.TABLES.filter((e) => e.replication === 'hub-mirror').map((e) => e.table).sort();
    const copied = {};
    for (const t of tables) {
        const cols = await q('SELECT a.COLUMN_NAME AS c FROM information_schema.COLUMNS a ' +
            'JOIN information_schema.COLUMNS b ON b.TABLE_SCHEMA = DATABASE() AND b.TABLE_NAME = a.TABLE_NAME AND b.COLUMN_NAME = a.COLUMN_NAME ' +
            'WHERE a.TABLE_SCHEMA = ? AND a.TABLE_NAME = ? ORDER BY a.ORDINAL_POSITION', [mirrorDb, t]);
        if (cols.length === 0) { copied[t] = null; continue; }
        const list = cols.map((r) => '`' + String(r.c).replace(/`/g, '``') + '`').join(', ');
        await q('INSERT INTO `' + t + '` (' + list + ') SELECT ' + list + ' FROM `' + mirrorDb + '`.`' + t + '`', []);
        const n = await q('SELECT COUNT(*) AS n FROM `' + t + '`', []);
        copied[t] = Number(n[0].n);
    }
    const admissionRows = {};
    for (const [t, col] of Object.entries(admissionColumnsFor(coin))) {
        admissionRows[t] = 0;
        if (!copied[t]) continue;
        const has = await q('SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, col]);
        if (Number(has[0].n) === 0) continue;
        const r = await q('SELECT COUNT(*) AS n FROM `' + t + '` WHERE `' + col + '` IS NOT NULL', []);
        admissionRows[t] = Number(r[0].n);
    }
    return { source: mirrorDb, copied, admissionRows };
}

/**
 * The era a side process resolved: the lever as this process sees it, and the
 * producer and consumer heights the real gate answers for the coin and network
 * the parent handed down.
 *
 * Every variable here is read by its LITERAL name, never through ARM_ENV, because
 * a computed `process.env[...]` read is invisible to the documentation coverage
 * gate (xchain-documentation lib/env-var-doc-coverage.js). The parent still writes
 * the lever through ARM_ENV in sideEnv(), so the unit suite round-trips sideEnv()
 * into this reader to keep the two names from drifting apart.
 */
function resolvedEra(gate) {
    const armed = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    const key = process.env.INDEXER_COIN + ':' + process.env.INDEXER_NETWORK;
    return {
        armEnv:   armed === undefined ? null : String(armed),
        producer: gate.MIRROR_ADMISSION_ACTIVATION[key],
        consumer: gate.MIRROR_ADMISSION_CONSUMER_ACTIVATION[key],
    };
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
    throw new WitnessExit(EXIT.REFUSED);
}

function parseArgs(argv) {
    const o = { coin: 'BTC', network: 'regtest', decoderDb: null, mirrorDb: null, activationHeight: null,
                schemaPrefix: null, sides: ['off', 'boundary', 'on'], dryRun: false, keep: false,
                workdir: null, db: { host: null, port: null, user: null, passEnv: null } };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--coin')                   o.coin = String(argv[++i]).toUpperCase();
        else if (a === '--network')           o.network = String(argv[++i]);
        else if (a === '--decoder-db')        o.decoderDb = argv[++i];
        else if (a === '--mirror-db')         o.mirrorDb = argv[++i];
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

function createRunArtifacts() {
    return {
        keep: false, workdir: null, ownsWorkdir: false, schemaNames: [], db: null,
        activeChild: null, activeChildDone: null, cleanupPromise: null, keptReported: false,
        interruptedSignal: null,
    };
}

/** A recursive delete is allowed only for a directory this run created below os.tmpdir(). */
function assertSafeOwnedWorkdir(workdir) {
    if (typeof workdir !== 'string' || workdir.length === 0)
        throw new Error('refusing to delete an empty workdir path');
    const tmpRoot = fs.realpathSync(os.tmpdir());
    const candidate = fs.realpathSync(workdir);
    if (candidate === path.parse(candidate).root || candidate === tmpRoot ||
        !candidate.startsWith(tmpRoot + path.sep))
        throw new Error('refusing to delete workdir outside the temporary root ' + tmpRoot + ': ' + candidate);
    if (!fs.lstatSync(workdir).isDirectory())
        throw new Error('refusing to delete a workdir that is not a directory: ' + workdir);
}

function realPathForPotentialPath(candidate) {
    const tail = [];
    let probe = path.resolve(candidate);
    while (!fs.existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe) return probe;
        tail.unshift(path.basename(probe));
        probe = parent;
    }
    return path.join(fs.realpathSync(probe), ...tail);
}

/** Create, and therefore take ownership of, the one workdir cleanup may remove. */
function createWorkdir(requested, artifacts) {
    let workdir;
    if (requested !== null && requested !== undefined) {
        if (String(requested).length === 0) refuse('--workdir must not be empty');
        workdir = path.resolve(String(requested));
        const tmpRoot = fs.realpathSync(os.tmpdir());
        const realTarget = realPathForPotentialPath(workdir);
        if (realTarget === path.parse(realTarget).root || realTarget === tmpRoot ||
            !realTarget.startsWith(tmpRoot + path.sep))
            refuse('--workdir must name a new directory below the temporary root ' + tmpRoot + ', got ' + workdir);
        if (fs.existsSync(workdir))
            refuse('--workdir already exists, so this run cannot own and safely remove it: ' + workdir);
        fs.mkdirSync(workdir, { recursive: true });
    } else {
        workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-witness-'));
    }
    assertSafeOwnedWorkdir(workdir);
    artifacts.workdir = workdir;
    artifacts.ownsWorkdir = true;
    return workdir;
}

function replaySchemaNames(prefix, sides) {
    if (!SCHEMA_NAME.test(String(prefix)))
        refuse('--schema-prefix must contain only letters, digits and underscore, got ' + JSON.stringify(prefix));
    const names = sides.map((side) => prefix + '_' + side);
    for (const name of names) {
        if (name.length > 64)
            refuse('replay schema name exceeds MariaDB\'s 64-character limit: ' + name);
    }
    return names;
}

async function connectAdmin(p) {
    const mariadb = require('mariadb');
    return mariadb.createConnection({
        host: p.host, port: Number(p.port), user: p.user, password: p.pass,
        insertIdAsNumber: true, connectTimeout: 10000,
    });
}

/** Refuse pre-existing names, then create exactly the schemas this run may later drop. */
async function createReplaySchemas(p, names, artifacts) {
    const admin = await connectAdmin(p);
    try {
        for (const name of names) {
            const rows = await admin.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [name]);
            if (rows.length)
                refuse('replay schema already exists, so this run refuses to overwrite or later delete it: ' + name);
        }
        for (const name of names) {
            await admin.query('CREATE DATABASE `' + name + '`');
            artifacts.schemaNames.push(name);
        }
    } finally {
        await admin.end();
    }
}

async function dropReplaySchemas(p, names) {
    const admin = await connectAdmin(p);
    try {
        for (const name of names) {
            if (!SCHEMA_NAME.test(name)) throw new Error('refusing to drop unsafe schema name ' + JSON.stringify(name));
            await admin.query('DROP DATABASE IF EXISTS `' + name + '`');
        }
    } finally {
        await admin.end();
    }
}

/** Keep or remove only the artifacts whose ownership this run recorded. */
function cleanupRunArtifacts(artifacts, deps = {}) {
    if (artifacts.cleanupPromise) return artifacts.cleanupPromise;
    artifacts.cleanupPromise = (async () => {
        const log = deps.log || info;
        if (artifacts.keep) {
            if (!artifacts.keptReported) {
                log('kept schemas: ' + (artifacts.schemaNames.length ? artifacts.schemaNames.join(', ') : '(none created)'));
                if (artifacts.workdir) log('kept workdir: ' + artifacts.workdir);
                artifacts.keptReported = true;
            }
            return;
        }
        const errors = [];
        if (artifacts.schemaNames.length) {
            try {
                const drop = deps.dropSchemas || dropReplaySchemas;
                await drop(artifacts.db, artifacts.schemaNames.slice());
                artifacts.schemaNames.length = 0;
            } catch (e) { errors.push(e); }
        }
        if (artifacts.ownsWorkdir && artifacts.workdir && fs.existsSync(artifacts.workdir)) {
            try {
                assertSafeOwnedWorkdir(artifacts.workdir);
                fs.rmSync(artifacts.workdir, { recursive: true, force: true });
                artifacts.workdir = null;
            } catch (e) { errors.push(e); }
        }
        if (errors.length) throw new Error(errors.map((e) => e.message || String(e)).join('; '));
    })();
    return artifacts.cleanupPromise;
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
        // The one computed env read this tool keeps, by design: --db-pass-env names the
        // variable at run time so the password never reaches argv, so its name cannot be a
        // literal. Read once, so the coverage gate's computed-read count holds at one site.
        const named = process.env[o.db.passEnv];
        if (named === undefined) return { missingPassEnv: o.db.passEnv };
        pass = named;
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

/**
 * Why this run's corpus cannot make A1 or A2 mean anything, or null when it can. Pure over the
 * parsed side results, so each refusal is driven in the unit suite without a database:
 *
 *   - a side replayed without the mirror (no `mirror` record);
 *   - the sides copied different mirrors, so they differ by input and not by arming;
 *   - the mirror holds no row with this chain's admission height, so arming changes no binding;
 *   - no block of the corpus is at or above H, so BOUNDARY never armed inside it.
 *
 * @returns {string|null} the named reason
 */
function corpusRefusal(o, results) {
    const sides = Object.keys(results || {});
    for (const s of sides) {
        if (!results[s].mirror)
            return 'side ' + s + ' replayed without a hub mirror (--mirror-db): its mirror tables were empty, so arming ' +
                   'could change no read and the comparison is vacuous';
    }
    const first = JSON.stringify(results[sides[0]].mirror);
    for (const s of sides.slice(1)) {
        if (JSON.stringify(results[s].mirror) !== first)
            return 'the sides copied different mirrors (' + sides[0] + ' ' + first + ', ' + s + ' ' +
                   JSON.stringify(results[s].mirror) + '), so they differ by their inputs and not by their arming';
    }
    const m = results[sides[0]].mirror;
    const bearing = Object.values(m.admissionRows || {}).reduce((a, n) => a + Number(n || 0), 0);
    if (bearing === 0)
        return 'no row arming would change: mirror ' + m.source + ' holds no row with ' + o.coin + '\'s admission height ' +
               'set in any table a consumer binds by it (' + JSON.stringify(m.admissionRows) + '; copied ' +
               JSON.stringify(m.copied) + '), so every side binds every mirrored row by effective_time and A1 and A2 ' +
               'are vacuous. Supply the mirror of an ARMED venue indexer that finalized admission-era rows';
    const skipped = skippedPassRefusal(results);
    if (skipped !== null) return skipped;
    const chain = (results.off && results.off.chain) || [];
    const top = chain.length ? chain[chain.length - 1].block_index : null;
    if (top === null || top < o.activationHeight)
        return 'the boundary height ' + o.activationHeight + ' is above the corpus tip ' + top + ', so BOUNDARY never ' +
               'armed inside the corpus and A1 compares two inert replays. Pick a height inside the corpus';
    return null;
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

function sideArgs(o) {
    return [__filename, '--side'].concat(o.mirrorDb ? ['--mirror-db', o.mirrorDb] : []);
}

function runSideProcess(side, env, logPath, args, artifacts) {
    const done = new Promise((resolve) => {
        const log = fs.createWriteStream(logPath);
        const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
        artifacts.activeChild = child;
        let stdout = '';
        child.stdout.on('data', (d) => { stdout += d; log.write(d); });
        child.stderr.on('data', (d) => log.write(d));
        child.on('close', (status) => {
            log.end();
            if (artifacts.activeChild === child) artifacts.activeChild = null;
            resolve({ side, status, stdout });
        });
    });
    artifacts.activeChildDone = done;
    return done;
}

function parseSideOutput(side, res) {
    const line = res.stdout.split('\n').find((l) => l.startsWith(SIDE_MARK));
    if (!line) return null;
    return JSON.parse(line.slice(SIDE_MARK.length));
}

function sideEnv(o, p, side, schema) {
    const env = Object.assign({}, process.env, {
        MA_SIDE_KEY: side,
        INDEXER_COIN: o.coin, INDEXER_NETWORK: o.network,
        TEST_DB_HOST: p.host, TEST_DB_PORT: p.port, TEST_DB_USER: p.user, TEST_DB_PASS: p.pass,
        TEST_DECODER_DB: o.decoderDb, TEST_INDEXER_DB: schema,
    });
    // Each side's arming, and ONLY that, is what differs between the children. An unarmed side
    // gets NO key: spawn turns a null value into the string "null", which the regtest resolver
    // rejects as unrecognised (inert, with a warning) instead of reading an unset lever, and a
    // lever inherited from the operator's shell would otherwise arm OFF.
    const arm = armValueFor(side, o.activationHeight);
    if (arm === null) delete env[ARM_ENV];
    else env[ARM_ENV] = arm;
    return env;
}

async function stopActiveChild(artifacts) {
    if (!artifacts.activeChild || !artifacts.activeChildDone) return;
    artifacts.activeChild.kill('SIGTERM');
    let timer;
    await Promise.race([
        artifacts.activeChildDone,
        new Promise((resolve) => { timer = setTimeout(resolve, 5000); }),
    ]);
    if (timer) clearTimeout(timer);
    if (artifacts.activeChild) {
        artifacts.activeChild.kill('SIGKILL');
        await artifacts.activeChildDone;
    }
}

function throwIfInterrupted(artifacts) {
    if (artifacts.interruptedSignal !== null) throw new InterruptedExit();
}

function installSignalHandlers(artifacts, emitter = process) {
    const handlers = {};
    for (const name of ['SIGINT', 'SIGTERM']) {
        handlers[name] = () => {
            if (artifacts.interruptedSignal !== null) return;
            artifacts.interruptedSignal = name;
            if (artifacts.activeChild) artifacts.activeChild.kill('SIGTERM');
        };
        emitter.once(name, handlers[name]);
    }
    return () => {
        for (const name of Object.keys(handlers)) emitter.removeListener(name, handlers[name]);
    };
}

async function runParent() {
    const artifacts = createRunArtifacts();
    const removeSignalHandlers = installSignalHandlers(artifacts);
    let code = EXIT.REFUSED;
    try {
        code = await main(artifacts);
    } catch (e) {
        if (e instanceof WitnessExit) code = e.code;
        else if (e instanceof InterruptedExit) code = EXIT.REFUSED;
        else console.error('ERR ' + ((e && e.stack) || e));
    } finally {
        try {
            if (artifacts.interruptedSignal !== null) await stopActiveChild(artifacts);
            await cleanupRunArtifacts(artifacts);
        } catch (e) {
            console.error('CLEANUP ERROR: ' + ((e && e.stack) || e));
            code = EXIT.REFUSED;
        }
    }
    removeSignalHandlers();
    if (artifacts.interruptedSignal !== null)
        code = artifacts.interruptedSignal === 'SIGINT' ? 130 : 143;
    process.exitCode = code;
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
    if (!o.mirrorDb)
        refuse('--mirror-db <schema> is required: every admission-gated read is a hub-mirror select, a side has no hub, ' +
               'and without a mirror its tables are empty, so arming could change nothing and A1 and A2 would be vacuous');
    if (!SCHEMA_NAME.test(String(o.mirrorDb)))
        refuse('--mirror-db must be a plain schema name (letters, digits, underscore), got ' + JSON.stringify(o.mirrorDb));
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

async function main(artifacts) {
    const o = parseArgs(process.argv.slice(2));
    const p = explicitDbParams(o);
    const prefix = o.schemaPrefix || ('ma_witness_replay_' + o.coin.toLowerCase());
    artifacts.keep = o.keep;
    artifacts.db = p;
    const workdir = createWorkdir(o.workdir, artifacts);
    const schemas = replaySchemaNames(prefix, o.sides);
    throwIfInterrupted(artifacts);

    console.log('# below-the-flag replay witness for the mirror-admission family (BF4, AB4)');
    console.log('# chain ' + o.coin + '/' + o.network + '   boundary height ' + o.activationHeight);
    console.log('# corpus ' + (o.decoderDb || '(none)') + ' + mirror ' + (o.mirrorDb || '(none)') +
                '   schemas ' + prefix + '_{' + o.sides.join(',') + '}');

    section('preconditions');
    provePreconditions(o, p);
    info('db ' + p.user + '@' + p.host + ':' + p.port + ' (password from the environment, never printed)');
    info('sides: ' + o.sides.map((s) => s + ' = ' + SIDES[s].label).join('; '));
    fs.mkdirSync(workdir, { recursive: true });
    info('logs under ' + workdir);

    if (o.dryRun) {
        console.log('\nREFUSED: --dry-run proved the sides and their arming and replayed nothing');
        throw new WitnessExit(EXIT.REFUSED);
    }

    await createReplaySchemas(p, schemas, artifacts);
    throwIfInterrupted(artifacts);

    section('replay');
    const results = {};
    for (const side of o.sides) {
        const logPath = path.join(workdir, side + '.log');
        const res = await runSideProcess(side, sideEnv(o, p, side, prefix + '_' + side), logPath, sideArgs(o), artifacts);
        throwIfInterrupted(artifacts);
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

    // Before any verdict line: a vacuous corpus must end in a named refusal, never in a PASS for
    // A1 followed by a FAIL for A2 that reads like a defect in the gate.
    section('corpus: the mirror carries rows arming would bind differently, and H is inside the corpus');
    for (const side of o.sides)
        info(side + ' mirror: ' + JSON.stringify(results[side].mirror));
    const vacuous = corpusRefusal(o, results);
    if (vacuous !== null) refuse(vacuous);

    section('A1: OFF and BOUNDARY are byte-identical BELOW the boundary');
    const offBelow = belowBoundary(results.off.chain, o.activationHeight);
    const bndBelow = belowBoundary(results.boundary.chain, o.activationHeight);
    if (offBelow.length === 0) {
        console.log('\nVACUOUS: the corpus carries no block below ' + o.activationHeight +
                    ', so the boundary comparison measured nothing');
        throw new WitnessExit(EXIT.VACUOUS);
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
    return failures === 0 ? EXIT.PASS : EXIT.FAIL;
}

module.exports = { queryIndexerDb, parseArgs, explicitDbParams, eraExpectation, armValueFor, belowBoundary,
                   firstDivergence, sideEnv, sideArgs, sideMirrorDb, resolvedEra, admissionColumnsFor, loadMirror,
                   corpusRefusal, skippedPassRefusal, cleanupRunArtifacts, createRunArtifacts, createWorkdir,
                   replaySchemaNames, installSignalHandlers, ADMISSION_TABLE_PASSES, SIDES, EXIT, HASH_FIELDS, ARM_ENV };
