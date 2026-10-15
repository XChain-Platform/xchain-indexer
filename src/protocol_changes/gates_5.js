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

const { addGate, UNARMED, UNPINNED } = require('./shared_rows.js');

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

// vote_settlement_exact_activation
// Height on the chain's own block_index. From it a VOTE create refuses a DEPOSIT or GAS_ESCROW
// past the 8 dp its escrow locks and releases at, a ballot needs its poll still open, and split
// portions are floored to 18 dp with the remainder on the largest share (lowest index on a tie),
// so they sum to the voter's weight. Create and ballot read their own block, the tally its measure
// block. Below it all three replay as before. Unarmed on mainnet and testnet; regtest from genesis.
addGate('vote_settlement_exact_activation.VOTE_SETTLEMENT_EXACT_ACTIVATION', 'height', {
    mainnet: UNARMED,
    testnet: UNARMED,
    regtest: 0,
});

// settlement_bounds_activation
// Height on the chain's own block_index. From it a CROSS_SETTLE leg settles only a match whose
// tick and ownership flag equal the local offer's own give side, and a swap leg releases at most
// the swap's own escrow, the bound the order leg already applies to its remaining give; a match
// that disagrees records a no-op settlement and moves nothing. From the same height a COINPAY
// obligation expires in the block whose time reaches its expiration, the instant from which a
// COINPAY paying it is refused. Below it both replay as before. Unarmed on mainnet and testnet;
// regtest from genesis.
addGate('settlement_bounds_activation.SETTLEMENT_BOUNDS_ACTIVATION', 'height', {
    mainnet: UNARMED,
    testnet: UNARMED,
    regtest: 0,
});

// pass_progress_retirement_activation
// Height on the chain's own block_index. From it the capped CROSS_SETTLE and XEXEC dispatch passes
// retire a mirrored row that is still unapplicable a grace of blocks after it became selectable
// (a short quorum with the snapshot present, a dismissed or missing local leg, cross_hops above the
// ceiling), recording an idempotency row that moves no value, so it stops holding a slot. From the
// same height the XCALL result pass ages an orphan result that carries an admission height by that
// height instead of by its effective_time. Below it all three passes replay as before. Unarmed on
// mainnet and testnet. The regtest entry is UNPINNED: a venue arms it with
// XC_PASS_PROGRESS_RETIREMENT_REGTEST_ACTIVATION (shared_rows.js), so the shared regtest rail
// and wallet CI keep today's passes unless they opt in. The grace and the age rule live in
// src/consensus/pass_retirement/index.js.
addGate('pass_progress_retirement_activation.PASS_PROGRESS_RETIREMENT_ACTIVATION', 'height', {
    mainnet: UNARMED,
    testnet: UNARMED,
    regtest: UNPINNED,   // ARMS by XC_PASS_PROGRESS_RETIREMENT_REGTEST_ACTIVATION at read
});

// slash_historical_set_activation
// Height on the chain's own block_index, judged at the height a capability set is read for.
// From it the effective signer set, the source stake weights and the per-key membership test
// read at height h add back every capability_slash_debits row on a stakes row whose slash
// block is above h, so the set at h depends only on the chain up to h for an active bond as it
// already did for a cooling one. A read at the tip sees no such debit and is unchanged. Below
// it the reads sum the current stakes.amount. Unarmed on mainnet and testnet. The regtest entry
// is UNPINNED: a venue arms it with XC_SLASH_HISTORICAL_SET_REGTEST_ACTIVATION (shared_rows.js).
addGate('slash_historical_set_activation.SLASH_HISTORICAL_SET_ACTIVATION', 'height', {
    mainnet: UNARMED,
    testnet: UNARMED,
    regtest: UNPINNED,   // ARMS by XC_SLASH_HISTORICAL_SET_REGTEST_ACTIVATION at read
});

// anchor_reward_copy_selection_activation
// Height on the BTC block the derive pass runs at. From it the pass reads every distinct copy of
// each pending anchor_reward_attestations tuple (the kept row and anchor_reward_attestation_copies)
// and mints the tuple when any copy passes its gates, meets quorum and proves on DOGE, taking the
// proven copy with the lowest doge_anchor_txid; it defers when none proves and a copy is still
// undecided, and pays nothing otherwise. The copies differ only in fields the XANCPUB signatures do
// not cover, and the reward row carries neither, so the tuple's outcome no longer depends on which
// copy arrived first. Below it the first copy received decides, as before. Unarmed on mainnet and
// testnet. The regtest entry is UNPINNED: a venue arms it with
// XC_ANCHOR_REWARD_COPY_SELECTION_REGTEST_ACTIVATION (shared_rows.js).
addGate('anchor_reward_copy_selection_activation.ANCHOR_REWARD_COPY_SELECTION_ACTIVATION', 'height', {
    mainnet: UNARMED,
    testnet: UNARMED,
    regtest: UNPINNED,   // ARMS by XC_ANCHOR_REWARD_COPY_SELECTION_REGTEST_ACTIVATION at read
});
