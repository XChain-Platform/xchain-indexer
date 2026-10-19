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
// Height on the completing continuation chunk's DOGE block_index. From it chunk-side archive reassembly runs only when its parent head has the same valid or gated-unverified status the head-side path admits. Below it the continuation's own status remains the only status guard. Unarmed on mainnet and testnet. The regtest entry is UNPINNED: a venue arms it with XC_REASSEMBLE_CHUNK_PARENT_STATUS_REGTEST_ACTIVATION (shared_rows.js).
addGate('reassemble_chunk_parent_status_activation.REASSEMBLE_CHUNK_PARENT_STATUS_ACTIVATION', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 157073,
    'LTC:testnet': 4928460,
    'DOGE:testnet': 68009330,
    testnet: 68009330,
    regtest: UNPINNED,   // ARMS by XC_REASSEMBLE_CHUNK_PARENT_STATUS_REGTEST_ACTIVATION at read
});

// unstake_delegated_row_journal_activation
// Height on the processing chain's own block_index. From it a contract UNSTAKE under a delegated key journals its rows so a delegation revert restores the original key. Unarmed live; regtest arms by XC_UNSTAKE_DELEGATED_ROW_JOURNAL_REGTEST_ACTIVATION (shared_rows.js).
addGate('unstake_delegated_row_journal_activation.UNSTAKE_DELEGATED_ROW_JOURNAL_ACTIVATION', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 157073,
    'LTC:testnet': 4928460,
    'DOGE:testnet': 68009330,
    testnet: UNARMED,
    regtest: UNPINNED,   // ARMS by XC_UNSTAKE_DELEGATED_ROW_JOURNAL_REGTEST_ACTIVATION at read
});

// anchor_checkpoint_seq_bind_activation
// From its ANCHOR DOGE height each sequence equals its canonical safe-integer snapshot block. Unarmed live.
addGate('anchor_checkpoint_seq_bind_activation.ANCHOR_CHECKPOINT_SEQ_BIND_ACTIVATION', 'height', {
    mainnet: UNARMED,
    'BTC:testnet': 157073,
    'LTC:testnet': 4928460,
    'DOGE:testnet': 68009330,
    testnet: UNARMED,
    regtest: UNPINNED,   // ARMS by XC_ANCHOR_CHECKPOINT_SEQ_BIND_REGTEST_ACTIVATION at read
});

// active_stake_collation_activation
// Height on the reading chain's own block_index. From it validator-set reads pin the binary collation. Below it they use the legacy collation. Unarmed on mainnet and testnet; regtest is active from genesis with no venue arming overlay.
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
// Height on the processing chain's own block_index. From it a non-BATCH multi-leg AIRDROP pays native fees from one action tally, and a fee probe quotes the summed fee without drawing it. Below it each leg reads the output independently. Unarmed on mainnet and testnet; regtest from genesis.
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
