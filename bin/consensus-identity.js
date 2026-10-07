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
 * The six numbers that say whether this build still applies the same rules and
 * still produces the same state as the one before it.
 *
 *   coin_registry_consensus_hash   sha256 over the consensus-critical subset of
 *                                  every bundled coin definition, per network.
 *                                  A changed value means a node would fail its
 *                                  own boot pin and halt rather than fork.
 *   armed_map_fingerprint          sha256 over the armed VALUES the registry
 *   and armed_map_rows             rows resolve to, one hash per key in
 *                                  armed_map_rows, plus the count. Unmoved by a
 *                                  comment, rename or move, so it answers "same
 *                                  armed map?"; UNREADABLE when a row fails to
 *                                  resolve, never a plausible hash, and the run
 *                                  then exits 1 with the reason. v1 (a hash
 *                                  over carrier bytes) is gone since W3; the
 *                                  legacy field carries v2 and
 *                                  armed_map_fingerprint_version says so. The
 *                                  armed_map_fingerprint_v2 alias of the W1 to
 *                                  W4 window is gone since W5.
 *   carrier_logic_digest           sha256 over the sorted id=hash lines of
 *                                  bin/pins/carrier-logic.json, the token-stream
 *                                  pin of every gate carrier's LOGIC. Read from
 *                                  the pin, not the tree: the pin's own guard
 *                                  measures the tree. Answers "same logic?"
 *                                  for THIS repo only: each repo pins its own
 *                                  carrier membership (the rule in
 *                                  bin/lib/carrier_logic_pin_ops.js, keyed by
 *                                  package name), so the hub's and sync's
 *                                  values differ from this one by design and
 *                                  are never compared with it. Cross-repo
 *                                  agreement is held per shared id by test (c)
 *                                  of test/unit/repo_guards/carrier_logic_pin.test.js.
 *   consensus_rules_digest        sha256 over the DECIDED HEIGHTS of the gates
 *                                  the hub also evaluates. Comparable across
 *                                  repos, and it answers "same rules?".
 *   gates_field_hash               sha256 of the GATES field the hub signs into a
 *   and gates_field                ROLLCALL v1 epoch, knownGateKeys().join(',').
 *                                  Built from the key list alone, so it reads the
 *                                  same bare or armed; comparable across repos,
 *                                  and the repo guard holds it to the hub pin.
 *   state_hash                     the stored hash at the regtest tip, or at a
 *                                  named height. The only one of the six that
 *                                  needs a database, and the only one that
 *                                  speaks for the LEDGER rather than the code.
 *
 * WHY A SCRIPT AND NOT AN RPC. The health RPC already returns the fingerprint
 * and the digest, but only from a RUNNING server against a reachable database,
 * and there is no RPC at all for the coin hash or the state hash. A restructure
 * has to take the same reading from a checkout, before and after, with nothing
 * deployed. So the five code-derived values are computed here exactly as the
 * server computes them, from the same modules, with no process to start.
 *
 * THE STATE HASH IS OPT-IN for that reason: without --state-hash this script
 * opens no socket and reads no configuration beyond the source tree.
 *
 * TWO OF THE FIVE ARE NOT PURE, AND IT MATTERS FOR ANY PIN. The rules digest
 * hashes gate VALUES, and a regtest venue arms some gates from its own
 * environment rather than from a committed height, so the same build reports one
 * digest in a bare checkout and another inside a configured container. The
 * armed-map fingerprint moves with it too, because like the digest it hashes
 * resolved values; the carrier logic digest does not, because it reads a
 * committed pin, and neither does the gates field hash, which hashes key names
 * rather than values. Two readings of the two that move
 * therefore have to be taken with the same environment to be comparable, and
 * `consensus_rules_gates` in the JSON output is what turns a mismatch into a
 * named gate instead of two opaque hashes. A reading records that environment as
 * `env` (a flat reading with none was taken bare), and --compare refuses (exit
 * 2) a pin block or reading taken under another, so exit 1 only means drift.
 *
 * READING THE TIP AGAINST A REGTEST RAIL, READ-ONLY. Run it on the host that
 * runs the regtest stack, as a user whose grants are SELECT only, with the
 * indexer service's own .env supplying the connection:
 *
 *   set -a; . /path/to/the/indexer/.env; set +a
 *   node bin/consensus-identity.js --state-hash --json
 *
 * The query is one SELECT against `blocks` and `index_transactions`. Nothing
 * here writes, migrates or connects to anything but that database, and the
 * credentials come from the environment so none of them reach a command line,
 * a log or this file.
 *
 * USAGE
 *   node bin/consensus-identity.js                    human summary, no database
 *   node bin/consensus-identity.js --json             the five code values
 *   node bin/consensus-identity.js --state-hash       adds the tip read; an
 *                                                     unread tip exits 1 in
 *                                                     every output mode
 *   node bin/consensus-identity.js --at-block 4210    the same read at a height,
 *                                                     which is how a reindex is
 *                                                     compared against its pin;
 *                                                     a height that is not a
 *                                                     non-negative integer is
 *                                                     refused (exit 2)
 *   node bin/consensus-identity.js --network testnet  default regtest
 *   node bin/consensus-identity.js --assert-no-absent exit 1 if any shared gate
 *                                                     reads the absent sentinel;
 *                                                     a missing registry row is
 *                                                     an exit-2 refusal naming
 *                                                     the key, flag or no flag
 *   node bin/consensus-identity.js --compare <pin>    compare the selected pin
 *                                                     block, or a flat file
 *                                                     --out wrote, field by
 *                                                     field; a pin block or
 *                                                     flat reading taken under
 *                                                     another regtest arming
 *                                                     environment is refused
 *                                                     (exit 2)
 *   node bin/consensus-identity.js --out <file>       write the identity as JSON
 *
 *   XC_ROLLCALL_REGTEST_ACTIVATION=armed XC_ROLLCALL_GATES_REGTEST_ACTIVATION=armed \
 *     node bin/consensus-identity.js
 *                                      reproduces the digest an ARMED regtest
 *                                      venue reports, from a bare checkout
 *
 ********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..');

class CliUsageError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CliUsageError';
    }
}

// The row a function-valued shared gate prints: present, body not digested (see SHARED_GATES).
const FUNCTION_GATE = '<function>';

// Name every gate row, since a function canonicalizes to undefined and JSON would drop it.
function projectGates(gates) {
    const out = {};
    for (const key of Object.keys(gates)) out[key] = gates[key] === undefined ? FUNCTION_GATE : gates[key];
    return out;
}

/**
 * The five numbers that come from the source tree alone, with the shape fields
 * that make a mismatch diagnosable beside them.
 * @returns {{network: string, coin_registry_consensus_hash: string, coin_registry_consensus_hashes: object,
 *            armed_map_fingerprint: string, armed_map_fingerprint_unreadable_reason: ?string,
 *            armed_map_fingerprint_version: number, armed_map_rows: ?object, armed_map_row_count: ?number,
 *            consensus_rules_digest: string, gate_key_count: number, absent_gates: string[],
 *            consensus_rules_gates: object, gates_field: string, gates_field_hash: string,
 *            carrier_logic_digest: string, env: Object<string, ?string>}}
 */
function codeIdentity(network) {
    const coins = require('../src/coins/index.js');
    const { computeArmedMapFingerprintV2, UNREADABLE } = require('../src/consensus/armed_map/fingerprint.js');
    const { computeConsensusRulesDigest, knownGateKeys, ABSENT } = require('../src/consensus_rules_digest.js');
    const logicPin = require('./lib/carrier_logic_pin.js');

    const hashes = coins.consensusHashes(network);
    const rules = computeConsensusRulesDigest();
    const gates = projectGates(rules.gates);
    const armedMapV2 = computeArmedMapFingerprintV2();
    const gatesField = knownGateKeys().join(',');
    // The shape of the measurement, beside the number it produced. A digest taken over a
    // list in which some gate read ABSENT is a different question answered, and nothing
    // about the hash itself says so: 87637dfa and 26ba9cce are equally plausible on sight.
    const absent = Object.keys(gates).filter(k => gates[k] === ABSENT).sort();
    return {
        network,
        // One number for the registry, over the per-coin hashes the hub serves.
        // The per-coin map is kept beside it because a single moved hash has to
        // be attributable to a chain before anyone can act on it.
        // Canonicalised by the registry's own exporter, the one consensusHash uses.
        coin_registry_consensus_hash: crypto.createHash('sha256').update(coins.canonicalJson(hashes)).digest('hex'),
        coin_registry_consensus_hashes: hashes,
        // The legacy field carries v2 since W3 and the version field says so; the
        // _v2 alias of the W1 to W4 window is gone since W5. The row map and count
        // are null exactly when v2 reads UNREADABLE.
        armed_map_fingerprint: armedMapV2.hex,
        // The module's reason beside its sentinel, so an UNREADABLE reading names its cause.
        armed_map_fingerprint_unreadable_reason: armedMapV2.hex === UNREADABLE ? String(armedMapV2.reason) : null,
        armed_map_fingerprint_version: 2,
        armed_map_rows: armedMapV2.rows || null,
        armed_map_row_count: armedMapV2.count === undefined ? null : armedMapV2.count,
        consensus_rules_digest: rules.digest,
        // Spelt as the hub spells them, so one concept keys the same in both readouts.
        gate_key_count: Object.keys(gates).length,
        absent_gates: absent,
        // The gate-by-gate preimage, kept beside the digest because two
        // mismatched hashes say nothing about what to fix. It is also what makes
        // an environment-shifted digest diagnosable in one read: see the header.
        consensus_rules_gates: gates,
        gates_field: gatesField,
        gates_field_hash: crypto.createHash('sha256').update(gatesField, 'utf8').digest('hex'),
        carrier_logic_digest: logicPin.digest(logicPin.readPin(REPO_ROOT)),
        // The regtest arming this reading was taken under; --compare refuses a pin taken under another.
        env: armingEnv(process.env),
    };
}

// Each arming variable read BY NAME, for the reason ENV_READERS in shared_rows.js gives.
const ARMING_READERS = {
    XC_ANCHOR_FOLD_REGTEST_ACTIVATION:    (env) => env.XC_ANCHOR_FOLD_REGTEST_ACTIVATION,
    XC_ANCHOR_STAKE_REGTEST_ACTIVATION:   (env) => env.XC_ANCHOR_STAKE_REGTEST_ACTIVATION,
    XC_ANCHOR_SLASH_REGTEST_ACTIVATION:   (env) => env.XC_ANCHOR_SLASH_REGTEST_ACTIVATION,
    XC_ROLLCALL_REGTEST_ACTIVATION:       (env) => env.XC_ROLLCALL_REGTEST_ACTIVATION,
    XC_ROLLCALL_GATES_REGTEST_ACTIVATION: (env) => env.XC_ROLLCALL_GATES_REGTEST_ACTIVATION,
    XC_MIRROR_ADMISSION_ACTIVATION:       (env) => env.XC_MIRROR_ADMISSION_ACTIVATION,
    XC_AMOUNTS_PRICE_REGTEST_ACTIVATION:  (env) => env.XC_AMOUNTS_PRICE_REGTEST_ACTIVATION,
    XC_AMOUNTS_PRICE_REGTEST_TIME:        (env) => env.XC_AMOUNTS_PRICE_REGTEST_TIME,
    XC_CONTRACTS_REGTEST_ACTIVATION:      (env) => env.XC_CONTRACTS_REGTEST_ACTIVATION,
    XC_LISTS_MARKET_REGTEST_ACTIVATION:   (env) => env.XC_LISTS_MARKET_REGTEST_ACTIVATION,
    XC_LISTS_MARKET_REGTEST_TIME:         (env) => env.XC_LISTS_MARKET_REGTEST_TIME,
};

/**
 * Every variable REGTEST_ARMING names, mapped to its raw value, null when unset.
 * @param {object} env the environment to read
 * @returns {Object<string, string|null>}
 */
function armingEnv(env) {
    const { REGTEST_ARMING } = require('../src/protocol_changes/shared_rows.js');
    const out = {};
    for (const name of Array.from(new Set(Object.values(REGTEST_ARMING).map((rule) => rule.env))).sort()) {
        // A variable with no reader would arm the digest unrecorded, so it is a refusal.
        if (!ARMING_READERS[name]) throw new Error(`REGTEST_ARMING names ${name}, which armingEnv has no reader for`);
        const raw = ARMING_READERS[name](env);
        out[name] = raw === undefined ? null : String(raw);
    }
    return out;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// One "NAME: pin X, now Y" line per variable the two arming environments disagree on; missing and null both read unset.
function armingDifferences(pinEnv, nowEnv) {
    const shown = (v) => (v === null || v === undefined ? 'unset' : JSON.stringify(String(v)));
    return Array.from(new Set(Object.keys(pinEnv).concat(Object.keys(nowEnv)))).sort()
        .filter((name) => shown(pinEnv[name]) !== shown(nowEnv[name]))
        .map((name) => `${name}: pin ${shown(pinEnv[name])}, now ${shown(nowEnv[name])}`);
}

// The exit-2 line for a reading taken under another arming environment, which is a venue effect and never drift.
function armingRefusal(where, moved) {
    return new CliUsageError(`${where} taken under a different regtest arming environment (${moved.join('; ')}); `
        + 'take both readings under the same environment');
}

// The block of a two-block pin whose whole arming env equals this run's (a block with no env was taken bare).
function venueBlock(pin, pinPath, nowEnv) {
    const blockEnv = (name) => (isPlainObject(pin[name]) && isPlainObject(pin[name].env) ? pin[name].env : {});
    const candidates = ['bare_checkout', 'armed_regtest_venue']
        .map((name) => ({ name, moved: armingDifferences(blockEnv(name), nowEnv) }));
    const match = candidates.find((candidate) => candidate.moved.length === 0);
    if (match) {
        if (!isPlainObject(pin[match.name])) throw new CliUsageError(`${pinPath}: the pin has no ${match.name} block`);
        return pin[match.name];
    }
    // Name the differences against the nearer block, the one the operator most likely meant.
    const nearest = candidates.slice().sort((a, b) => a.moved.length - b.moved.length)[0];
    throw armingRefusal(`${pinPath}: its ${nearest.name} block was`, nearest.moved);
}

/**
 * Pick the two-block pin's venue block, or take a flat --out reading whole, and
 * refuse by name (exit 2) anything else or anything taken under another arming.
 * @param {*} pin the parsed pin file
 * @param {string} pinPath named in every refusal
 * @param {object} nowEnv armingEnv() of this run
 * @returns {object} the block to compare field by field
 */
function selectedPinBlock(pin, pinPath = 'pin', nowEnv = armingEnv(process.env)) {
    if (!isPlainObject(pin)) throw new CliUsageError(`${pinPath}: a pin must be a JSON object`);
    if ('bare_checkout' in pin || 'armed_regtest_venue' in pin) return venueBlock(pin, pinPath, nowEnv);
    if ('hub_schema_version' in pin) {
        throw new CliUsageError(`${pinPath}: a hub identity; compare it with the hub's bin/consensus-identity.js`);
    }
    if (typeof pin.network !== 'string' || typeof pin.consensus_rules_digest !== 'string') {
        throw new CliUsageError(`${pinPath}: neither a bare_checkout/armed_regtest_venue pin nor an --out identity`);
    }
    // Verify the flat reading's env is an object; a reading with none was taken bare.
    if ('env' in pin && !isPlainObject(pin.env)) throw new CliUsageError(`${pinPath}: env must be a JSON object`);
    const moved = armingDifferences(pin.env || {}, nowEnv);
    if (moved.length) throw armingRefusal(`${pinPath}: was`, moved);
    return pin;
}

// Compare by value, since an array or object read back from JSON is never === the fresh one.
function sameValue(before, after) {
    if (before !== null && typeof before === 'object') return JSON.stringify(before) === JSON.stringify(after);
    return before === after;
}

function compareIdentity(pinBlock, fresh) {
    const results = [];
    for (const field of Object.keys(pinBlock)) {
        // Skip the venue env and the tip, which --compare never reads (it opens no database).
        if (field === 'env' || field === 'tip') continue;
        const before = pinBlock[field];
        const after = fresh[field];
        if (isPlainObject(before)) {
            const keys = Array.from(new Set(Object.keys(before).concat(Object.keys(after || {})))).sort();
            for (const key of keys) {
                results.push({ field: field + '.' + key, before: before[key], after: (after || {})[key],
                    same: sameValue(before[key], (after || {})[key]) });
            }
        } else {
            results.push({ field, before, after, same: sameValue(before, after) });
        }
    }
    return results;
}

function printable(value) {
    return value === undefined ? '<missing>' : JSON.stringify(value);
}

function runComparison(pinPath, identity) {
    const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
    const block = selectedPinBlock(pin, pinPath, identity.env);
    if ('tip' in block) console.log('skip tip: --compare reads no database');
    const results = compareIdentity(block, identity);
    for (const result of results) {
        if (result.same) console.log('ok ' + result.field);
        else console.log('MISMATCH ' + result.field + ': ' + printable(result.before)
            + ' -> ' + printable(result.after));
    }
    if (results.some((result) => !result.same)) process.exitCode = 1;
}

/**
 * The stored state hash at the tip, read through the indexer's own Database so
 * the connection, the pool and the type handling are the service's and not a
 * second implementation of them.
 *
 * The query lives here rather than behind a named db method because the database
 * class exposes none that returns the stored state hash: the column is written by
 * db/blocks/index.js createBlock and read back only by the replication compare in
 * another service.
 */
async function readStateHash(opts) {
    const Database = require('../src/db');
    const config   = require('../src/config.js');
    const Utility  = require('../src/utility.js');

    const host = process.env.INDEXER_DB_HOST;
    const port = process.env.INDEXER_DB_PORT;
    const user = process.env.INDEXER_DB_USER;
    const pass = process.env.INDEXER_DB_PASS;
    const name = opts.db || process.env.INDEXER_DB_NAME;
    if (!host || !user || !name) {
        return { error: 'INDEXER_DB_HOST / INDEXER_DB_USER / INDEXER_DB_NAME are unset; '
                        + 'load the indexer service .env before --state-hash' };
    }

    const cfg = config.getConfig(opts.chain, opts.network);
    const db = new Database(host, port, name, user, pass, { config: cfg, util: new Utility(cfg) });
    try {
        // At a named height when one is given, and only otherwise at the tip. A
        // reindex is compared at the height that was pinned: the chain keeps
        // moving underneath it, so two tip reads taken minutes apart are two
        // different blocks and disagree for a reason that is not divergence.
        const rows = opts.atBlock === undefined
            ? await db.doQuery(
                `SELECT b.block_index, b.block_time, t.hash AS state_hash
                   FROM blocks b
                   LEFT JOIN index_transactions t ON (t.id = b.state_hash_id)
                  ORDER BY b.block_index DESC
                  LIMIT 1`, [])
            : await db.doQuery(
                `SELECT b.block_index, b.block_time, t.hash AS state_hash
                   FROM blocks b
                   LEFT JOIN index_transactions t ON (t.id = b.state_hash_id)
                  WHERE b.block_index = ?`, [opts.atBlock]);
        if (!rows || rows.length === 0) {
            return { error: opts.atBlock === undefined ? 'the blocks table is empty'
                                                      : `no block ${opts.atBlock} in this database` };
        }
        return {
            block_index: Number(rows[0].block_index),
            block_time: Number(rows[0].block_time),
            state_hash: rows[0].state_hash === null ? null : String(rows[0].state_hash),
        };
    } catch (e) {
        return { error: e.message };
    } finally {
        if (typeof db.closePool === 'function') await db.closePool().catch(() => {});
        else if (db.pool && typeof db.pool.end === 'function') await db.pool.end().catch(() => {});
    }
}

/**
 * The --at-block value as a height, or a usage refusal (exit 2) before any database work.
 * @param {string} raw the argument as typed
 * @returns {number}
 */
function blockHeight(raw) {
    const height = Number(raw);
    // Verify decimal digits only: Number() reads '' as 0, '0x10' as 16 and '1e3' as 1000, so a typo would read another block.
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(height)) {
        throw new CliUsageError(`--at-block requires a non-negative integer height, got ${JSON.stringify(raw)}`);
    }
    return height;
}

function parseArgs(argv) {
    const opts = { json: false, stateHash: false, network: 'regtest', chain: 'BTC', assertNoAbsent: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const takeValue = () => {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith('-')) {
                throw new CliUsageError(`${arg} requires a value`);
            }
            i += 1;
            return value;
        };

        if (arg === '--json') opts.json = true;
        else if (arg === '--state-hash') opts.stateHash = true;
        else if (arg === '--network') opts.network = takeValue();
        else if (arg === '--chain') opts.chain = takeValue();
        else if (arg === '--db') opts.db = takeValue();
        else if (arg === '--at-block') { opts.atBlock = blockHeight(takeValue()); opts.stateHash = true; }
        else if (arg === '--assert-no-absent') opts.assertNoAbsent = true;
        else if (arg === '--compare') opts.compare = path.resolve(takeValue());
        else if (arg === '--out') opts.out = path.resolve(takeValue());
        else if (arg === '--help' || arg === '-h') opts.help = true;
        else throw new CliUsageError(`unknown flag: ${arg}`);
    }
    return opts;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return; }

    const identity = codeIdentity(opts.network);
    if (opts.compare) {
        runComparison(opts.compare, identity);
        return;
    }
    // Absent rather than null when the read was not asked for, so a pin can
    // never be mistaken for a tip that read back empty.
    if (opts.stateHash) identity.tip = await readStateHash(opts);

    // Checked before either output branch, so --json, --out and the human summary
    // all carry the same exit code: matching the hub's --assert-no-absent, the check
    // a restructure that moves a gate carrier out from under this build has to
    // survive, not just the ability to print a lower resolved count.
    if (opts.assertNoAbsent && identity.absent_gates.length) {
        console.error(`ABSENT GATES (${identity.absent_gates.length}): the digest is over a rules set `
            + 'this build has lost:');
        for (const key of identity.absent_gates) console.error(`  ${key}`);
        process.exitCode = 1;
    }
    // Fail an unresolvable armed map like an unread tip, so a sentinel pin never reads as a pass.
    if (identity.armed_map_fingerprint_unreadable_reason !== null) {
        console.error(`armed_map_fingerprint UNREADABLE: ${identity.armed_map_fingerprint_unreadable_reason}`);
        process.exitCode = 1;
    }
    // Fail an unread tip in every output mode, so a scripted --json reading never takes a missing ledger read for a pass.
    if (identity.tip && identity.tip.error) {
        console.error(`tip state_hash UNREAD: ${identity.tip.error}`);
        process.exitCode = 1;
    }

    if (opts.out) {
        fs.mkdirSync(path.dirname(opts.out), { recursive: true });
        fs.writeFileSync(opts.out, `${JSON.stringify(identity, null, 2)}\n`);
    }

    if (opts.json) {
        console.log(JSON.stringify(identity, null, 2));
        return;
    }
    console.log(`network:                       ${identity.network}`);
    console.log(`coin_registry_consensus_hash:  ${identity.coin_registry_consensus_hash}`);
    for (const tick of Object.keys(identity.coin_registry_consensus_hashes).sort()) {
        console.log(`  ${tick.padEnd(29)}${identity.coin_registry_consensus_hashes[tick]}`);
    }
    console.log(`armed_map_fingerprint:         ${identity.armed_map_fingerprint} (version ${identity.armed_map_fingerprint_version})`);
    if (identity.armed_map_fingerprint_unreadable_reason !== null) {
        console.log(`  unreadable because:          ${identity.armed_map_fingerprint_unreadable_reason}`);
    }
    console.log(`armed_map_row_count:           ${identity.armed_map_row_count}`);
    console.log(`carrier_logic_digest:          ${identity.carrier_logic_digest}`);
    console.log(`consensus_rules_digest:        ${identity.consensus_rules_digest}`);
    console.log(`gates_field:                   ${identity.gates_field}`);
    console.log(`gates_field_hash:              ${identity.gates_field_hash}`);
    console.log(`  shared gates:                ${identity.gate_key_count - identity.absent_gates.length} resolved, `
                + `${identity.absent_gates.length} absent`);
    // Named, not just counted: an absent gate is a legitimate reading of a build that
    // lacks the carrier, so the reader has to be able to tell that from a wrong one.
    for (const key of identity.absent_gates) {
        console.log(`    absent:                    ${key}`);
    }
    if (!opts.stateHash) {
        console.log('tip state_hash:                not read (pass --state-hash with the service .env loaded)');
        return;
    }
    if (identity.tip.error) {
        console.log(`tip state_hash:                UNREAD: ${identity.tip.error}`);
        process.exitCode = 1;
        return;
    }
    console.log(`tip block_index:               ${identity.tip.block_index}`);
    console.log(`tip state_hash:                ${identity.tip.state_hash}`);
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e instanceof CliUsageError ? e.message : `consensus-identity: ${e.message}`);
        process.exitCode = 2;
    });
}

module.exports = {
    codeIdentity,
    parseArgs,
    readStateHash,
    compareIdentity,
    selectedPinBlock,
    armingEnv,
    REPO_ROOT,
};
