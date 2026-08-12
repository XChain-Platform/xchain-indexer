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

-- xchain:migration mode=auto
--
-- Migration: state_tree_roots gains the contract_state_root extension column
--
-- WHY
-- ---
-- The SPV sub-tree design arms reserved state_root slot 4, contract_state_root. The derivation threads
-- incrementally from the previous block's sub-root, so that value has to be
-- persisted somewhere per block, and it belongs on the row that already holds the
-- state_root it is a component of: the column and its root are written by ONE
-- statement from ONE gated value, so no rewrite path (reorg, self-heal,
-- ON DUPLICATE KEY UPDATE) can leave them describing different leaf sets.
--
-- NULL MEANS EMPTY, WHICH IS WHY THERE IS NO BACKFILL
-- ---------------------------------------------------
-- Every block ever committed on every chain committed this slot as
-- EMPTY_SMT_ROOT (state_root_version 1). NULL is the stored spelling of exactly
-- that, so historical rows are already correct and a backfill would be writing a
-- constant nobody reads. An inert chain keeps writing NULL after this lands: the
-- activation maps in state_subtree_activation.js are all empty, and the block
-- paths do not even query contract_state until a height is armed.
--
-- CONSENSUS IS NOT AFFECTED BY THIS MIGRATION. The column is a persistence
-- surface, not a commitment: state_root is assembled from the gated sub-roots in
-- memory, and adding a place to store one of them changes no hash. What WOULD be
-- consensus-visible is arming a height, which is a separate code change that has
-- to deploy fleet-wide first (spec section 4, deploy order).
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS re-runs as a no-op, and the AFTER anchor
-- matches src/sql/state_tree_roots.sql so a migrated table and a fresh install
-- converge on the same column order.

-- The SHADOW column lands in the same migration because it is the same feature:
-- §7's dry-run window derives the sub-root for N blocks below the armed height and
-- records it here so the source and follower can be compared before the flag day.
-- It is deliberately NOT the committed column: the explorer reassembles state_root
-- from that one, so a below-arming value there would reassemble to a state_root
-- nobody signed and break every proof at that height.

ALTER TABLE state_tree_roots
  ADD COLUMN IF NOT EXISTS contract_state_root CHAR(64) NULL AFTER block_merkle_root,
  ADD COLUMN IF NOT EXISTS contract_state_root_shadow CHAR(64) NULL AFTER contract_state_root;
