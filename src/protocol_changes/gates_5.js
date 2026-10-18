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

// host_fault_halt_heights
// Per-chain height on the processing chain's own block_index. At or after it the VM
// halts deterministically when a host fault escapes the execution boundary. Below it
// the prior host-fault behavior replays exactly as before. Unarmed on mainnet and
// testnet until a release names heights. MUST equal xchain-vm
// HOST_FAULT_HALT_ACTIVATION, whose null is this row's UNARMED.
addGate('host_fault_halt_heights.HOST_FAULT_HALT_ACTIVATION', 'height', {
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

// token_supply_representation_activation
// Height on the chain's own block_index. From it an ISSUE whose MINT_SUPPLY (first issue or
// reissue) or a MINT whose AMOUNT would carry the token's total supply past MAX_TOKEN_SUPPLY is
// refused whether or not the token declares MAX_SUPPLY, so no supply or balance outgrows the
// 42 integer digits of the DECIMAL(60,18) ledger sums the per-block sanity check compares. From
// the same height the per-block supply refresh writes tokens.supply in fixed notation, the form
// the rollback rebuild writes, instead of the exponent form a bignumber stringifies to from 1e21
// up and below 1e-7. Below it both replay as before. Unarmed on mainnet and testnet. The regtest
// entry is UNPINNED: a venue arms it with XC_TOKEN_SUPPLY_REPRESENTATION_REGTEST_ACTIVATION
// (shared_rows.js).
addGate('token_supply_representation_activation.TOKEN_SUPPLY_REPRESENTATION_ACTIVATION', 'height', {
    mainnet: UNARMED,
    testnet: UNARMED,
    regtest: UNPINNED,   // ARMS by XC_TOKEN_SUPPLY_REPRESENTATION_REGTEST_ACTIVATION at read
});

// dispenser_fiat_pricing_activation
// Height on the chain's own block_index. From it FIAT dispenser settlement, and the DISPENSER
// create and oracle-fee reads beside it, read validator rounds bound the way the fee read and
// the VM preload are bound (reference_block on the reference chain, the signed admission height
// on the others, and the landed-batch clause where that row is armed), so a round stamped inside
// the window but anchored above the block cannot be read. Mode A counts fills as
// floor(COIN_AMOUNT x price / FIAT_AMOUNT) exactly; a non-batch coin-payment tally runs at the
// exact tally scale and charges a Mode A fill its exact cost, so sub-satoshi fills drain the
// shared payment; and an oracle_prices tie on (effective_at, action_index) resolves on
// source_chain. Below it all four replay as before. Unarmed on mainnet and testnet. The regtest
// entry is UNPINNED: a venue arms it with XC_DISPENSER_FIAT_PRICING_REGTEST_ACTIVATION
// (shared_rows.js).
addGate('dispenser_fiat_pricing_activation.DISPENSER_FIAT_PRICING_ACTIVATION', 'height', {
    mainnet: UNARMED,
    testnet: UNARMED,
    regtest: UNPINNED,   // ARMS by XC_DISPENSER_FIAT_PRICING_REGTEST_ACTIVATION at read
});

// bridge_policy_apply_order_activation
// Height on the chain's own block_index. From it the bridge settle pass selects token policy
// snapshots only for ticks with a bridged copy on this chain (a local token row, or a due lock
// in-leg that creates one), before the XPOLICY_MAX_PER_BLOCK cap, so snapshots for ticks bridged
// elsewhere stop taking every slot. From the same height a tick's snapshots apply in contiguous
// policy_seq order: a seq waits while an earlier one is neither applied nor recorded refused, a
// seq at or below the applied one never applies, and a seq still waiting
// XPOLICY_SEQ_GAP_BOUND_S of block time past its own effective_time applies over the gap. Below
// it the pass replays as before. Unarmed on mainnet and testnet. The regtest entry is UNPINNED: a
// venue arms it with XC_BRIDGE_POLICY_APPLY_ORDER_REGTEST_ACTIVATION (shared_rows.js). The
// selection and the bound live in src/consensus/bridge_settle/policy_order.js.
addGate('bridge_policy_apply_order_activation.BRIDGE_POLICY_APPLY_ORDER_ACTIVATION', 'height', {
    mainnet: UNARMED,
    testnet: UNARMED,
    regtest: UNPINNED,   // ARMS by XC_BRIDGE_POLICY_APPLY_ORDER_REGTEST_ACTIVATION at read
});

// vm_emission_amount_format_activation
// Height on the chain's own block_index. From it an amount a contract emits must be a plain
// unsigned decimal numeral with at most AMOUNT_MAX_INTEGER_DIGITS integer digits before it is
// rounded to its tick's decimals, the shape the user path's amount rule accepts; anything else refuses the emission, which fails the EXECUTE and rolls it back
// whole. Below it the rounding coerces the text as before: NaN and Infinity become 0, and hex,
// exponent and bare-point forms ('0x10', '1e-9', '1.', '.5') are read as numbers. Unarmed on
// mainnet and testnet. The regtest entry is UNPINNED: a venue arms it with
// XC_VM_EMISSION_AMOUNT_FORMAT_REGTEST_ACTIVATION (shared_rows.js).
addGate('vm_emission_amount_format_activation.VM_EMISSION_AMOUNT_FORMAT_ACTIVATION', 'height', {
    mainnet: UNARMED,
    testnet: UNARMED,
    regtest: UNPINNED,   // ARMS by XC_VM_EMISSION_AMOUNT_FORMAT_REGTEST_ACTIVATION at read
});

// execute_fee_cap_activation
// Height on the chain's own block_index. From it an EXECUTE's XCHAIN-balance fee debit is
// capped at the GAS the caller holds when the run settles, floored at zero, so the debit never
// leaves the caller's balance negative; the run's outcome and its metered gas stand. Below it
// the full metered fee is debited, as before: the state commitment reads end-of-block nets, so
// a block whose later action re-credits the caller commits with the uncapped debit, and below
// STATE_COMMITMENT_ACTIVATION a negative balance commits, so capping without a height would
// change committed balances. Unarmed on mainnet and testnet. The regtest entry is UNPINNED: a
// venue arms it with XC_EXECUTE_FEE_CAP_REGTEST_ACTIVATION (shared_rows.js).
addGate('execute_fee_cap_activation.EXECUTE_FEE_CAP_ACTIVATION', 'height', {
    mainnet: UNARMED,
    testnet: UNARMED,
    regtest: UNPINNED,   // ARMS by XC_EXECUTE_FEE_CAP_REGTEST_ACTIVATION at read
});

// vote_v3_tick_existence_activation
// Height on the chain's own block_index. From it a VOTE v3 delegation names an issued
// TICK: the false result getTokenInfo returns for an unknown ticker is refused instead of
// passing the null-only legacy check and storing a delegation row. Below it the old verdict
// replays exactly. Unarmed on mainnet and testnet. The regtest entry is UNPINNED: a venue
// arms it with XC_VOTE_V3_TICK_EXISTENCE_REGTEST_ACTIVATION (shared_rows.js).
addGate('vote_v3_tick_existence_activation.VOTE_V3_TICK_EXISTENCE_ACTIVATION', 'height', {
    mainnet: UNARMED,
    testnet: UNARMED,
    regtest: UNPINNED,   // ARMS by XC_VOTE_V3_TICK_EXISTENCE_REGTEST_ACTIVATION at read
});

// match_origin_open_activation
// Height on the chain's own block_index. From it ORDER_MATCH and SWAP_MATCH re-read the
// originating offer and return before candidate lookup unless its latest status is open.
// This covers a LIST rematch plan whose earlier step made a later planned origin terminal
// and the match an ORDER or SWAP cancel dispatches from the offer it just cancelled, so
// escrow already settled or refunded is not settled again. Below it both handlers replay
// as before. Unarmed on mainnet and testnet. The regtest entry is UNPINNED: a venue arms
// it with XC_MATCH_ORIGIN_OPEN_REGTEST_ACTIVATION (shared_rows.js).
addGate('match_origin_open_activation.MATCH_ORIGIN_OPEN_ACTIVATION', 'height', {
    mainnet: UNARMED,
    testnet: UNARMED,
    regtest: UNPINNED,   // ARMS by XC_MATCH_ORIGIN_OPEN_REGTEST_ACTIVATION at read
});

// reassemble_chunk_parent_status_activation
// Height on the completing continuation chunk's DOGE block_index. From it chunk-side
// archive reassembly runs only when its parent head has the same valid or gated-unverified
// status the head-side path admits. Below it the continuation's own status remains the only
// status guard. Unarmed on mainnet and testnet. The regtest entry is UNPINNED: a venue arms
// it with XC_REASSEMBLE_CHUNK_PARENT_STATUS_REGTEST_ACTIVATION (shared_rows.js).
addGate('reassemble_chunk_parent_status_activation.REASSEMBLE_CHUNK_PARENT_STATUS_ACTIVATION', 'height', {
    mainnet: UNARMED,
    testnet: UNARMED,
    regtest: UNPINNED,   // ARMS by XC_REASSEMBLE_CHUNK_PARENT_STATUS_REGTEST_ACTIVATION at read
});

// unstake_delegated_row_journal_activation
// Height on the processing chain's own block_index. From it a contract UNSTAKE written under a
// materialized delegated key appends rotation history for its cooldown row and any partial-stake
// residual, so a later delegation revert restores the slot's original key on every surviving
// row. Below it those new rows remain on the request key with no journal entry. Unarmed on
// mainnet and testnet. The regtest entry is UNPINNED: a venue arms it with
// XC_UNSTAKE_DELEGATED_ROW_JOURNAL_REGTEST_ACTIVATION (shared_rows.js).
addGate('unstake_delegated_row_journal_activation.UNSTAKE_DELEGATED_ROW_JOURNAL_ACTIVATION', 'height', {
    mainnet: UNARMED,
    testnet: UNARMED,
    regtest: UNPINNED,   // ARMS by XC_UNSTAKE_DELEGATED_ROW_JOURNAL_REGTEST_ACTIVATION at read
});

// active_stake_collation_activation
// Height on the reading chain's own block_index. From it validator-set reads pin the binary
// collation. Below it they use the legacy collation. Unarmed on mainnet and testnet; regtest
// is active from genesis with no venue arming overlay.
addGate('active_stake_collation_activation.ACTIVE_STAKE_COLLATION_ACTIVATION', 'height', {
    mainnet: UNARMED,
    testnet: UNARMED,
    regtest: 0,
});
