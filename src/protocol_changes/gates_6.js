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
 * Indexer-only registry rows, part 6: the rows registered after gates_5.js
 *
 * The entry loads this part right after gates_5.js, so these rows keep the
 * registration order they had at the end of that file. Opened after
 * gates_5.js neared the file-size limit; a new row goes at the end here.
 *
 ********************************************************************/

'use strict';

const { addGate, UNARMED, UNPINNED } = require('./shared_rows.js');

// reassemble_chunk_parent_status_activation
// Height on the completing continuation chunk's DOGE block_index. From it chunk-side archive reassembly runs only when its parent head has the same valid or gated-unverified status the head-side path admits. Below it the continuation's own status remains the only status guard. Unarmed on mainnet, armed on testnet at the row's heights. The regtest entry is UNPINNED: a venue arms it with XC_REASSEMBLE_CHUNK_PARENT_STATUS_REGTEST_ACTIVATION (shared_rows.js).
addGate('reassemble_chunk_parent_status_activation.REASSEMBLE_CHUNK_PARENT_STATUS_ACTIVATION', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 157073,
    'LTC:testnet': 4928460,
    'DOGE:testnet': 68009330,
    testnet: 68009330,
    regtest: UNPINNED,   // ARMS by XC_REASSEMBLE_CHUNK_PARENT_STATUS_REGTEST_ACTIVATION at read
});

// unstake_delegated_row_journal_activation
// Height on the processing chain's own block_index. From it a contract UNSTAKE under a delegated key journals its rows so a delegation revert restores the original key. Unarmed on mainnet, armed on testnet per chain at the row's heights with the bare testnet entry UNARMED, and on regtest armed by XC_UNSTAKE_DELEGATED_ROW_JOURNAL_REGTEST_ACTIVATION (shared_rows.js).
addGate('unstake_delegated_row_journal_activation.UNSTAKE_DELEGATED_ROW_JOURNAL_ACTIVATION', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 157073,
    'LTC:testnet': 4928460,
    'DOGE:testnet': 68009330,
    testnet: UNARMED,
    regtest: UNPINNED,   // ARMS by XC_UNSTAKE_DELEGATED_ROW_JOURNAL_REGTEST_ACTIVATION at read
});

// anchor_checkpoint_seq_bind_activation
// From its ANCHOR DOGE height each sequence equals its canonical safe-integer snapshot block. Unarmed on mainnet, armed on testnet per chain at the row's heights with the bare testnet entry UNARMED, and on regtest armed by XC_ANCHOR_CHECKPOINT_SEQ_BIND_REGTEST_ACTIVATION (shared_rows.js).
addGate('anchor_checkpoint_seq_bind_activation.ANCHOR_CHECKPOINT_SEQ_BIND_ACTIVATION', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 157073,
    'LTC:testnet': 4928460,
    'DOGE:testnet': 68009330,
    testnet: UNARMED,
    regtest: UNPINNED,   // ARMS by XC_ANCHOR_CHECKPOINT_SEQ_BIND_REGTEST_ACTIVATION at read
});

// active_stake_collation_activation
// Height on the reading chain's own block_index. From it validator-set reads pin the binary collation. Below it they use the legacy collation. Unarmed on mainnet, armed on testnet per chain at the row's heights, and active from genesis on regtest with no venue arming overlay.
addGate('active_stake_collation_activation.ACTIVE_STAKE_COLLATION_ACTIVATION', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 157073,
    'LTC:testnet': 4928460,
    'DOGE:testnet': 68009330,
    testnet: UNARMED,
    regtest: 0,
});

// Copies a response's BATCH_POSITION into its callback EXECUTE context.
addGate('attest_callback_batch_position_activation.ATTEST_CALLBACK_BATCH_POSITION_ACTIVATION', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 157073,
    'LTC:testnet': 4928460,
    'DOGE:testnet': 68009330,
    testnet: UNARMED,
    regtest: 0,
});

// airdrop_native_fee_tally_activation
// Height on the processing chain's own block_index. From it a non-BATCH multi-leg AIRDROP pays native fees from one action tally, and a fee probe quotes the summed fee without drawing it. Below it each leg reads the output independently. Unarmed on mainnet, armed on testnet per chain at the row's heights, and active from genesis on regtest.
addGate('airdrop_native_fee_tally_activation.AIRDROP_NATIVE_FEE_TALLY_ACTIVATION', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 157073,
    'LTC:testnet': 4928460,
    'DOGE:testnet': 68009330,
    testnet: UNARMED,
    regtest: 0,
});

// capability_snapshot_proof_activation
// Height on the mirrored row's BTC snapshot_block. From it mirror-resolved capability rows require a checkpoint proof. Below it they apply as before.
addGate('capability_snapshot_proof_activation.CAPABILITY_SNAPSHOT_PROOF_ACTIVATION', 'height', {
    mainnet: UNARMED,
    testnet: UNARMED,
    regtest: 0,
});

// bridge_escrow_anchor_match_activation
// Height on the settling (destination) chain's own block_index. From it the escrow cross-check
// selects and binds a DOGE- or LTC-origin checkpoint by its BTC snapshot_block, the axis the
// transfer row's snapshot_block lives on, instead of comparing that BTC height to the origin
// chain's block_index. BTC-origin selection is unchanged at every height. Must be armed on a
// network at or before TOKEN_BRIDGE_ACTIVATION there, or no DOGE- or LTC-origin lock settles.
addGate('bridge_escrow_anchor_match_activation.BRIDGE_ESCROW_ANCHOR_MATCH_ACTIVATION', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 157235,
    'LTC:testnet': 4930600,
    'DOGE:testnet': 68012800,
    testnet: UNARMED,
    regtest: 0,
});

// batch_airdrop_leg_weight_activation
// Height on the processing chain's own block_index. From it a BATCH airdrop leg is weighted by its own amount when the action is split. Below it legs are weighted as before. Unarmed on mainnet and testnet, active from genesis on regtest.
addGate('batch_airdrop_leg_weight_activation.BATCH_AIRDROP_LEG_WEIGHT_ACTIVATION', 'height', {
    mainnet: UNARMED,
    testnet: UNARMED,
    regtest: 0,
});

// Height on the archive head's DOGE block_index. From it author-scoped chunk
// reads ignore orphan rows whose declared total_chunks differs from that head.
addGate('archive_orphan_geometry_activation.ARCHIVE_ORPHAN_GEOMETRY_ACTIVATION', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 157073,
    'LTC:testnet': 4928460,
    'DOGE:testnet': 68009330,
    testnet: 68009330,
    regtest: 0,
});

// Height on the processing chain's own block_index. Registers the BRIDGE_CHECKPOINT_V3 section activation. Unarmed on mainnet and testnet, active from genesis on regtest.
addGate('bridge_checkpoint_v3_section_activation.BRIDGE_CHECKPOINT_V3_SECTION_ACTIVATION', 'height', {
    mainnet: UNARMED,
    testnet: UNARMED,
    regtest: 0,
});

// tick_cache_null_prototype_activation
// Height on the processing chain's own block_index. From it AIRDROP, SEND and DESTROY keep their per-action TICK cache on a null-prototype object, so a TICK spelled like an Object.prototype member (constructor, __proto__) reads as unknown. Below it the cache is a plain object as before. Unarmed on mainnet and testnet, active from genesis on regtest.
addGate('tick_cache_null_prototype_activation.TICK_CACHE_NULL_PROTOTYPE_ACTIVATION', 'height', {
    mainnet: UNARMED,
    testnet: UNARMED,
    regtest: 0,
});

// airdrop_native_fee_tally_rollback_activation
// Height on the processing chain's own block_index. From it a multi-leg AIRDROP leg that fails its native coin fee check takes its fee and gas back out of the action tally, so the tally covers only the valid legs. Below it a failed leg's fee and gas stay in the tally. Kept apart from airdrop_native_fee_tally_activation, which is armed on testnet, so testnet fee replay stays identical. Unarmed on mainnet and testnet, active from genesis on regtest.
addGate('airdrop_native_fee_tally_rollback_activation.AIRDROP_NATIVE_FEE_TALLY_ROLLBACK_ACTIVATION', 'height', {
    mainnet: UNARMED,
    testnet: UNARMED,
    regtest: 0,
});

// guard_emitted_host_discriminator_activation
// Height on the processing chain's own block_index. From it a controller guard roots each guarded emitted host's emission subtree at its own request_id discriminator, so two guarded emitted hosts under one root derive distinct request_ids. Below it those ids are derived as before. Unarmed on mainnet and testnet with no testnet instant, active from genesis on regtest.
addGate('guard_emitted_host_discriminator_activation.GUARD_EMITTED_HOST_DISCRIMINATOR_ACTIVATION', 'height', {
    mainnet: UNARMED,
    testnet: UNARMED,
    regtest: 0,
});
