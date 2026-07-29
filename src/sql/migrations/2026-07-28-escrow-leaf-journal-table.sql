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
-- Migration: create escrow_leaf_journal
--
-- WHY
-- ---
-- SPV sub-tree spec Stage B (claude/specs/spv-state-subtree-extension.md, )
-- commits a locked-balance leaf per (address, tick) inside balances_root under the
-- XCHAIN_ESC key domain. The `escrows` ledger cannot answer "how much does this
-- address have locked": it is a per-tick conservation ledger whose releases key to
-- whoever RECEIVES the funds (nine of the 26 escrow write sites), so a per-key sum
-- leaves the locker stale-positive and the recipient negative. This table records
-- each locker's own total instead, computed once when a block changes it.
--
-- CONSENSUS IS NOT AFFECTED BY THIS MIGRATION. The table is created EMPTY, nothing
-- writes it yet (the B1 writer is not landed), and nothing reads it until the
-- escrow leaf is armed via ESCROW_LOCKED_LEAF_ACTIVATION, which is inert on every
-- chain. Creating it early is deliberate: it is a replicated table, so it has to
-- exist on every replica before the first row is ever streamed.
--
-- IDEMPOTENT: every statement is IF NOT EXISTS. The CREATE TABLE is kept
-- character-for-character equivalent to src/sql/escrow_leaf_journal.sql, indexes
-- declared separately afterwards exactly as the definition does, because the
-- schema-parity gate compares the two normalised forms: a migrated replica and a
-- fresh install must converge on the same table, not merely a compatible one.

CREATE TABLE IF NOT EXISTS escrow_leaf_journal (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    address_id    BIGINT UNSIGNED NOT NULL,      -- id in index_addresses: the LOCKER, never a recipient
    tick_id       BIGINT UNSIGNED NOT NULL,      -- id in index_tickers
    locked_amount VARCHAR(250),                  -- total open-remaining for this key; NULL = tombstone
    block_index   BIGINT UNSIGNED NOT NULL,      -- block whose processing produced this value
    action_index  BIGINT UNSIGNED                -- causing action, provenance only (NULL for multi-action folds)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX IF NOT EXISTS idx_block  ON escrow_leaf_journal (block_index);
CREATE INDEX IF NOT EXISTS idx_latest ON escrow_leaf_journal (address_id, tick_id, id DESC);
