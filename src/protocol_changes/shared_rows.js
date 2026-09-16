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
 * this wrapper reads the venue's environment ONCE, at registration, and arms
 * the entry before the row is stored. The bare reading is therefore the block
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

// The table with its regtest entries armed from `env`, or the table itself when
// the venue named nothing (an unset or refused value leaves UNPINNED in place).
function armed(key, table, env) {
    const rule = REGTEST_ARMING[key];
    if (!rule) return table;
    const height = regtestHeight(env[rule.env], rule.armedHeight, rule.label, rule.env);
    if (height === null) return table;
    const out = Object.assign({}, table);
    for (const k of rule.keys) out[k] = height;
    return out;
}

/**
 * Registers every queued row into `registry`, in part-file order, with the
 * regtest arming of `env` applied to the rows that take it.
 * @param {{addGate: Function}} registry
 * @param {object} [env]  the process environment, or a stand-in
 */
function registerRows(registry, env) {
    const source = env || process.env;
    for (const [key, unit, table] of queued) registry.addGate(key, unit, armed(key, table, source));
}

module.exports = { addGate, UNARMED, UNPINNED, registerRows, REGTEST_ARMING };
