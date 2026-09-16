/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * The gate-row queue: the wrapper every row part file writes into.
 *
 * The rows themselves live in the part files beside this one. shared_rows_N.js
 * hold the SHARED block, the gate rows every consumer of this platform judges:
 * the region between their `// SHARED-GATES BEGIN` and `// SHARED-GATES END`
 * markers is BYTE-TWINNED into the registry of xchain-sync, xchain-hub,
 * xchain-explorer and xchain-sdk, each of which wraps the same bytes in its own
 * copy of this queue and replaces only the require line above the markers.
 * gates_N.js hold the rows no other repo twins. Every part file calls
 * `addGate(key, unit, table)` at column zero, with literal values only, so the
 * calls are queued here as the parts load and replayed into the registry the
 * assembler hands registerRows(); a function body around 300 rows would grow
 * past the readability limit, and column-zero bytes are what the consumers
 * can twin without a shared receiver name.
 *
 * REGTEST ARMING. Five rows let a regtest venue arm their regtest entry from
 * an environment variable (the modules' own resolvers document the grammar;
 * regtest_env.js carries it for the registry). The block writes those entries
 * UNPINNED, the inert default, so it stays data that every consumer can copy;
 * the registry stores that committed table and this wrapper arms the entry
 * WHEN THE ROW IS READ, from the environment as it stands at that moment. A
 * module reading its table at require time therefore sees what its own
 * literal saw (a test that sets the variable and re-requires the module sees
 * the new value, with no registry purge), and the fingerprint sees the
 * environment as it stands when it runs. The bare reading is the block
 * literal and the armed reading is the venue's, exactly what the fingerprint
 * pinned bare and armed before the rows moved here.
 *
 ********************************************************************/

'use strict';

const { UNARMED, UNPINNED } = require('./core.js');
const { regtestHeight } = require('./regtest_env.js');

const queued = [];
function addGate(key, unit, table) { queued.push([key, unit, table]); }

// key -> { env, label, armedHeight, keys }: the regtest entries a venue arms.
const REGTEST_ARMING = {
    'rollcall_activation.ROLLCALL_ACTIVATION':
        { env: 'XC_ROLLCALL_REGTEST_ACTIVATION', label: 'ROLLCALL', armedHeight: 0, keys: ['regtest'] },
    'rollcall_gates_activation.ROLLCALL_GATES_ACTIVATION':
        { env: 'XC_ROLLCALL_GATES_REGTEST_ACTIVATION', label: 'ROLLCALL gates', armedHeight: 0, keys: ['regtest'] },
    'mirror_admission_activation.MIRROR_ADMISSION_ACTIVATION':
        { env: 'XC_MIRROR_ADMISSION_ACTIVATION', label: 'MIRROR ADMISSION', armedHeight: 0,
          keys: ['BTC:regtest', 'LTC:regtest', 'DOGE:regtest'] },
    'mirror_admission_activation.MIRROR_ADMISSION_CONSUMER_ACTIVATION':
        { env: 'XC_MIRROR_ADMISSION_ACTIVATION', label: 'MIRROR ADMISSION', armedHeight: 0,
          keys: ['BTC:regtest', 'LTC:regtest', 'DOGE:regtest'] },
    'anchor_reward_activation.ANCHOR_ATTEST_BARRIER_ACTIVATION':
        { env: 'XC_MIRROR_ADMISSION_ACTIVATION', label: 'MIRROR ADMISSION', armedHeight: 0, keys: ['regtest'] },
};

// env name -> its reader. Each variable is read BY NAME, once, here: the
// documentation coverage gate resolves `env.NAME` to a doc row and counts a
// computed `env[name]` as a blind spot it ratchets, so the rule's `env` string
// (kept for the warning text) selects a reader instead of indexing the object.
// A rule naming a variable with no reader here is a defect, not an inert row.
const ENV_READERS = {
    XC_ROLLCALL_REGTEST_ACTIVATION:       (env) => env.XC_ROLLCALL_REGTEST_ACTIVATION,
    XC_ROLLCALL_GATES_REGTEST_ACTIVATION: (env) => env.XC_ROLLCALL_GATES_REGTEST_ACTIVATION,
    XC_MIRROR_ADMISSION_ACTIVATION:       (env) => env.XC_MIRROR_ADMISSION_ACTIVATION,
};

// The raw value of the rule's env variable, through its named reader.
function readRuleEnv(rule, env) {
    const read = ENV_READERS[rule.env];
    if (!read) throw new Error('REGTEST_ARMING names ' + rule.env + ' but ENV_READERS has no reader for it');
    return read(env);
}

// The table with its regtest entries armed from `raw`, one env variable's
// value, or the table itself when the venue named nothing (an unset or refused
// value leaves UNPINNED in place). Frozen like the committed row it stands for.
function armed(rule, table, raw) {
    const height = regtestHeight(raw, rule.armedHeight, rule.label, rule.env);
    if (height === null) return table;
    const out = Object.assign({}, table);
    for (const k of rule.keys) out[k] = height;
    return Object.freeze(out);
}

// The read overlay: `env` is read at every call, so it follows the process
// environment as it changes, and the result is cached per key against the raw
// string it was armed from, so a refused value warns once per value and a
// steady environment costs one property read per get().
function regtestArming(env) {
    const cache = new Map();
    return function armAtRead(key, table) {
        const rule = REGTEST_ARMING[key];
        if (!rule) return table;
        const raw = readRuleEnv(rule, env);
        const hit = cache.get(key);
        if (hit && hit.raw === raw) return hit.value;
        const value = armed(rule, table, raw);
        cache.set(key, { raw, value });
        return value;
    };
}

/**
 * Registers every queued row into `registry`, in part-file order, as the block
 * commits it, and installs the read overlay that arms the regtest entries from
 * `env` at the time of each read.
 * @param {{addGate: Function, setReadOverlay: Function}} registry
 * @param {object} env  the process environment (the assembler passes it), or
 *                      a stand-in; read by reference, never copied
 */
function registerRows(registry, env) {
    if (env === null || typeof env !== 'object') throw new Error('registerRows: env must be the environment object to arm from');
    for (const [key, unit, table] of queued) registry.addGate(key, unit, table);
    registry.setReadOverlay(regtestArming(env));
}

module.exports = { addGate, UNARMED, UNPINNED, registerRows, REGTEST_ARMING };
