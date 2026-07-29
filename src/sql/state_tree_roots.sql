--********************************************************************
--
-- Copyright © 2025-2026 Dankest, LLC
-- Based on XChain Platform by Dankest, LLC - https://dankest.llc
--
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- This file is part of XChain Platform. Licensed under the GNU Affero
-- General Public License v3.0 or later; see LICENSE.md. A commercial
-- license (without AGPL source-disclosure terms) is available -
-- contact legal@dankest.llc.
--
--********************************************************************

CREATE TABLE state_tree_roots (
    id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    chain             VARCHAR(10)  NOT NULL,               -- BTC/LTC/DOGE (constant per indexer instance)
    network           VARCHAR(20)  NOT NULL,               -- mainnet/testnet/regtest
    block_index       BIGINT UNSIGNED NOT NULL,            -- the block these roots commit
    balances_root     CHAR(64) NOT NULL,                   -- SMT over balance + escrow leaves
    stakes_root       CHAR(64) NOT NULL,                   -- BTC-only; EMPTY_SMT_ROOT on LTC/DOGE
    state_root        CHAR(64) NOT NULL,                   -- fixedMerkleRoot([balances, stakes, EMPTY,EMPTY,EMPTY])
    block_merkle_root CHAR(64) NOT NULL,                   -- per-block content root (SPV spec §5)
    -- Reserved sub-tree slot 4, armed per chain by state_subtree_activation.js.
    -- NULL means the slot committed EMPTY_SMT_ROOT at this height, which is what
    -- every historical row means, so this column needs no backfill. Written by
    -- the same statement that writes state_root, from the same gated value, so
    -- it can never go stale against the root it reassembles to. NULLable is
    -- deliberate and load-bearing: it is also how the boot-time column-drift
    -- reconciler is allowed to add it to an aged table.
    contract_state_root CHAR(64) NULL,
    -- Shadow-compute window (SPV sub-tree spec §7 step 1): the WOULD-BE sub-root
    -- at a height where the slot is not committed, recorded so the two twins can
    -- be compared before a flag day. It deliberately does NOT share the committed
    -- column: the explorer reassembles state_root from that one, so a below-arming
    -- value there would reassemble to a state_root nobody signed and break every
    -- proof at that height. Nothing outside the derivation reads this column.
    contract_state_root_shadow CHAR(64) NULL,
    -- Stage B's shadow (SPV sub-tree spec §7 step 1, amended): the WOULD-BE
    -- balances_root with the XCHAIN_ESC locked leaves applied, recorded below
    -- the escrow leaf's armed height for cross-twin comparison. The escrow leaf
    -- changes the CONTENTS of balances_root rather than a slot, so its shadow
    -- cannot share the committed balances_root column (the follower compares
    -- that one every block); it threads through this column instead, exactly as
    -- the contract-state shadow threads through its own. Nothing outside the
    -- derivation reads it.
    balances_root_escrow_shadow CHAR(64) NULL,
    computed_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_chain_net_block (chain, network, block_index)
    -- Per-block light-client commitments (SPV spec §4/§5), written atomically with
    -- the block. Reorg deletes rows >= the orphan height inside the rollback txn;
    -- the surviving tip row is the fork-point root the new chain builds forward on.
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX idx_chain_net_block ON state_tree_roots (chain, network, block_index);
