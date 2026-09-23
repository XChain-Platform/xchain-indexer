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
 * The five numbers that say whether this build still applies the same rules and
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
 *                                  measures the tree. Answers "same logic?".
 *   consensus_rules_digest        sha256 over the DECIDED HEIGHTS of the gates
 *                                  the hub also evaluates. Comparable across
 *                                  repos, and it answers "same rules?".
 *   state_hash                     the stored hash at the regtest tip, or at a
 *                                  named height. The only one of the five that
 *                                  needs a database, and the only one that
 *                                  speaks for the LEDGER rather than the code.
 *
 * WHY A SCRIPT AND NOT AN RPC. The health RPC already returns the fingerprint
 * and the digest, but only from a RUNNING server against a reachable database,
 * and there is no RPC at all for the coin hash or the state hash. A restructure
 * has to take the same reading from a checkout, before and after, with nothing
 * deployed. So the four code-derived values are computed here exactly as the
 * server computes them, from the same modules, with no process to start.
 *
 * THE FIFTH NUMBER IS OPT-IN for that reason: without --state-hash this script
 * opens no socket and reads no configuration beyond the source tree.
 *
 * TWO OF THE FOUR ARE NOT PURE, AND IT MATTERS FOR ANY PIN. The rules digest
 * hashes gate VALUES, and a regtest venue arms some gates from its own
 * environment rather than from a committed height, so the same build reports one
 * digest in a bare checkout and another inside a configured container. The
 * armed-map fingerprint moves with it too, because like the digest it hashes
 * resolved values; the carrier logic digest does not, because it reads a
 * committed pin. Two readings of the two that move
 * therefore have to be taken with the same environment to be comparable, and
 * `consensus_rules_gates` in the JSON output is what turns a mismatch into a
 * named gate instead of two opaque hashes.
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
 *   node bin/consensus-identity.js --json             the four code values
 *   node bin/consensus-identity.js --state-hash       adds the tip read
 *   node bin/consensus-identity.js --at-block 4210    the same read at a height,
 *                                                     which is how a reindex is
 *                                                     compared against its pin
 *   node bin/consensus-identity.js --network testnet  default regtest
 *   node bin/consensus-identity.js --assert-no-absent exit 1 if any shared gate
 *                                                     reads the absent sentinel;
 *                                                     a missing registry row is
 *                                                     an exit-2 refusal naming
 *                                                     the key, flag or no flag
 *   node bin/consensus-identity.js --compare <pin>    compare the selected pin
 *                                                     block field by field
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

/**
 * The four numbers that come from the source tree alone, with the shape fields
 * that make a mismatch diagnosable beside them.
 * @returns {{network: string, coin_registry_consensus_hash: string, coin_registry_consensus_hashes: object,
 *            armed_map_fingerprint: string, armed_map_fingerprint_unreadable_reason: ?string,
 *            armed_map_fingerprint_version: number, armed_map_rows: ?object, armed_map_row_count: ?number,
 *            consensus_rules_digest: string, consensus_rules_gates_resolved: number,
 *            consensus_rules_gates_absent: number, consensus_rules_gates_absent_keys: string[],
 *            consensus_rules_gates: object, gates_field: string, gates_field_hash: string,
 *            carrier_logic_digest: string}}
 */
function codeIdentity(network) {
    const coins = require('../src/coins/index.js');
    const { computeArmedMapFingerprintV2, UNREADABLE } = require('../src/consensus/armed_map/fingerprint.js');
    const { computeConsensusRulesDigest, knownGateKeys, ABSENT } = require('../src/consensus_rules_digest.js');
    const logicPin = require('./lib/carrier_logic_pin.js');

    const hashes = coins.consensusHashes(network);
    const rules = computeConsensusRulesDigest();
    const armedMapV2 = computeArmedMapFingerprintV2();
    const gatesField = knownGateKeys().join(',');
    // The shape of the measurement, beside the number it produced. A digest taken over a
    // list in which some gate read ABSENT is a different question answered, and nothing
    // about the hash itself says so: 87637dfa and 26ba9cce are equally plausible on sight.
    const absent = Object.keys(rules.gates).filter(k => rules.gates[k] === ABSENT).sort();
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
        consensus_rules_gates_resolved: Object.keys(rules.gates).length - absent.length,
        consensus_rules_gates_absent: absent.length,
        consensus_rules_gates_absent_keys: absent,
        // The gate-by-gate preimage, kept beside the digest because two
        // mismatched hashes say nothing about what to fix. It is also what makes
        // an environment-shifted digest diagnosable in one read: see the header.
        consensus_rules_gates: rules.gates,
        gates_field: gatesField,
        gates_field_hash: crypto.createHash('sha256').update(gatesField, 'utf8').digest('hex'),
        carrier_logic_digest: logicPin.digest(logicPin.readPin(REPO_ROOT)),
    };
}

function selectedPinBlock(pin) {
    const armed = pin.armed_regtest_venue;
    const env = armed && armed.env ? armed.env : {};
    const armedNow = Object.keys(env).length > 0
        && Object.keys(env).every((key) => process.env[key] === String(env[key]));
    return armedNow ? armed : pin.bare_checkout;
}

function compareIdentity(pinBlock, fresh) {
    const results = [];
    for (const field of Object.keys(pinBlock)) {
        if (field === 'env') continue;
        const before = pinBlock[field];
        const after = fresh[field];
        if (before && typeof before === 'object' && !Array.isArray(before)) {
            const keys = Array.from(new Set(Object.keys(before).concat(Object.keys(after || {})))).sort();
            for (const key of keys) {
                results.push({ field: field + '.' + key, before: before[key], after: (after || {})[key],
                    same: before[key] === (after || {})[key] });
            }
        } else {
            results.push({ field, before, after, same: before === after });
        }
    }
    return results;
}

function printable(value) {
    return value === undefined ? '<missing>' : JSON.stringify(value);
}

function runComparison(pinPath, identity) {
    const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
    const results = compareIdentity(selectedPinBlock(pin), identity);
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
        else if (arg === '--at-block') { opts.atBlock = Number(takeValue()); opts.stateHash = true; }
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

    // Checked before either output branch, so --json and the human summary both
    // carry the same exit code: matching the hub's --assert-no-absent, the check
    // a restructure that moves a gate carrier out from under this build has to
    // survive, not just the ability to print a lower resolved count.
    if (opts.assertNoAbsent && identity.consensus_rules_gates_absent_keys.length) {
        console.error(`ABSENT GATES (${identity.consensus_rules_gates_absent}): the digest is over a rules set `
            + 'this build has lost:');
        for (const key of identity.consensus_rules_gates_absent_keys) console.error(`  ${key}`);
        process.exitCode = 1;
    }
    // Fail an unresolvable armed map like an unread tip, so a sentinel pin never reads as a pass.
    if (identity.armed_map_fingerprint_unreadable_reason !== null) {
        console.error(`armed_map_fingerprint UNREADABLE: ${identity.armed_map_fingerprint_unreadable_reason}`);
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
    console.log(`  shared gates:                ${identity.consensus_rules_gates_resolved} resolved, `
                + `${identity.consensus_rules_gates_absent} absent`);
    // Named, not just counted: an absent gate is a legitimate reading of a build that
    // lacks the carrier, so the reader has to be able to tell that from a wrong one.
    for (const key of identity.consensus_rules_gates_absent_keys) {
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
    main().then(() => process.exit(process.exitCode || 0), (e) => {
        console.error(e instanceof CliUsageError ? e.message : `consensus-identity: ${e.message}`);
        process.exit(2);
    });
}

module.exports = {
    codeIdentity,
    parseArgs,
    readStateHash,
    compareIdentity,
    selectedPinBlock,
    REPO_ROOT,
};
