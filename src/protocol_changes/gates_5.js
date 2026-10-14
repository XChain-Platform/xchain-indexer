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
 * Indexer-only registry rows, part 5: mainnet launch and later rows
 *
 * The launch instant and the prelaunch seed source map read by
 * src/consensus/gates/prelaunch_seed_sources.js, then the rows registered
 * after them. Opened after gates_4.js reached the file-size limit.
 *
 ********************************************************************/

'use strict';

const { addGate, UNARMED } = require('./shared_rows.js');

// mainnet_launch_activation
// MAINNET_LAUNCH_ACTIVATION: the block time from which mainnet admits every transaction.
// Before it only validator wire actions and pinned seed sources are admitted. Testnet and
// regtest are open networks and never consult it, so testnet stays UNARMED.
addGate('mainnet_launch_activation.MAINNET_LAUNCH_ACTIVATION', 'time', {
    mainnet: 1798761600,
    testnet: UNARMED,
    regtest: 0,
});

// prelaunch_seed_sources
// PRELAUNCH_SEED_SOURCES: '<COIN>:mainnet' -> the source addresses admitted before launch.
// Empty until a release pins the seed sources, so before launch nothing but a validator
// wire action is admitted.
addGate('prelaunch_seed_sources.PRELAUNCH_SEED_SOURCES', 'constant', {});

// gas_ceiling_exhausted_heights
// Per-chain height on the processing chain's own block_index. At or after it the
// VM settles a run whose gas tracker crossed the ceiling as out_of_gas at the
// ceiling on every path, and the DEPLOY constructor settle clamps the
// constructor's gasUsed to GAS_CEILING on every path, as the EXECUTE settle
// already does. Below it both replay exactly as before. Unarmed on mainnet and
// testnet until a release names heights. MUST equal xchain-vm
// GAS_CEILING_EXHAUSTED_ACTIVATION, whose null is this row's UNARMED.
addGate('gas_ceiling_exhausted_heights.GAS_CEILING_EXHAUSTED_ACTIVATION', 'height', {
    'BTC:mainnet': UNARMED,
    'LTC:mainnet': UNARMED,
    'DOGE:mainnet': UNARMED,
    'BTC:testnet': UNARMED,
    'LTC:testnet': UNARMED,
    'DOGE:testnet': UNARMED,
    testnet: UNARMED,
    regtest: 0,
});

// resource_fault_signal_heights
// Per-chain height on the processing chain's own block_index. At or after it the VM
// settles a run as out_of_stack only when an in-isolate depth guard reported the trip
// to the host, so a contract that throws the guard's text or a RangeError of its own
// no longer settles at the gas ceiling, and a memory-limit disposal of the isolate
// settles as out_of_memory instead of timeout. Below it both replay exactly as before.
// Unarmed on mainnet and testnet until a release names heights. MUST equal xchain-vm
// RESOURCE_FAULT_SIGNAL_ACTIVATION, whose null is this row's UNARMED.
addGate('resource_fault_signal_heights.RESOURCE_FAULT_SIGNAL_ACTIVATION', 'height', {
    'BTC:mainnet': UNARMED,
    'LTC:mainnet': UNARMED,
    'DOGE:mainnet': UNARMED,
    'BTC:testnet': UNARMED,
    'LTC:testnet': UNARMED,
    'DOGE:testnet': UNARMED,
    testnet: UNARMED,
    regtest: 0,
});

// host_error_stack_strip_heights
// Per-chain height on the processing chain's own block_index. At or after it the VM
// rethrows an error a host gateway function threw as a fresh in-isolate error of the
// same constructor and message, whose stack is "", so a contract can no longer store
// the harness position and isolated-vm frame text in hashed state. Below it the error
// reaches the contract as before. Unarmed on mainnet and testnet until a release names
// heights. MUST equal xchain-vm HOST_ERROR_STACK_STRIP_ACTIVATION, whose null is this
// row's UNARMED.
addGate('host_error_stack_strip_heights.HOST_ERROR_STACK_STRIP_ACTIVATION', 'height', {
    'BTC:mainnet': UNARMED,
    'LTC:mainnet': UNARMED,
    'DOGE:mainnet': UNARMED,
    'BTC:testnet': UNARMED,
    'LTC:testnet': UNARMED,
    'DOGE:testnet': UNARMED,
    testnet: UNARMED,
    regtest: 0,
});

// json_stringify_reentry_heights
// Per-chain height on the processing chain's own block_index. At or after it the VM
// gives each nested JSON.stringify call (from a toJSON, replacer or getter) its own frame
// pool and key list and restores the outer ones when it returns, so the outer call no
// longer returns the inner result, and charges a frame first allocated in a nested pool.
// Below it both replay exactly as before. Unarmed on mainnet and testnet until a release
// names heights. MUST equal xchain-vm JSON_STRINGIFY_REENTRY_ACTIVATION, whose null is
// this row's UNARMED.
addGate('json_stringify_reentry_heights.JSON_STRINGIFY_REENTRY_ACTIVATION', 'height', {
    'BTC:mainnet': UNARMED,
    'LTC:mainnet': UNARMED,
    'DOGE:mainnet': UNARMED,
    'BTC:testnet': UNARMED,
    'LTC:testnet': UNARMED,
    'DOGE:testnet': UNARMED,
    testnet: UNARMED,
    regtest: 0,
});

// native_stack_terminal_heights
// Per-chain height on the processing chain's own block_index. At or after it the VM
// settles a native stack overflow a contract catch or finally would handle as the
// deterministic depth fault, charges each frame its weight against the structural depth
// bound, and holds the arguments a native apply, spread or bind pushes against the same
// bound. Below it every execution replays exactly as before. Unarmed on mainnet and
// testnet until a release names heights. MUST equal xchain-vm
// NATIVE_STACK_TERMINAL_ACTIVATION, whose null is this row's UNARMED.
addGate('native_stack_terminal_heights.NATIVE_STACK_TERMINAL_ACTIVATION', 'height', {
    'BTC:mainnet': UNARMED,
    'LTC:mainnet': UNARMED,
    'DOGE:mainnet': UNARMED,
    'BTC:testnet': UNARMED,
    'LTC:testnet': UNARMED,
    'DOGE:testnet': UNARMED,
    testnet: UNARMED,
    regtest: 0,
});
