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
-- Migration: secondary index `action_index` on tokens.
--
-- WHY
-- ---
-- rollback.js deletes tokens in the dataTables loop
-- (DELETE FROM tokens WHERE action_index >= ?). The table has ten existing indexes
-- (tick_id, owner_id, escrow_action_index, plus the ten lock_* and callback
-- columns) but none on action_index, so every reorg-delete is a full table scan of
-- the entire token registry. Adding a secondary index on action_index makes the
-- reorg-delete a bounded range scan.
--
-- Idempotent (ADD INDEX IF NOT EXISTS) and additive; the InnoDB secondary-index
-- build is online (INPLACE) and does not block DML. On a freshly reindexed DB the
-- table is small and the build is instant. Snapshot-bootstrapped sync replicas do
-- not run this runner, so existing replica indexer DBs need it applied separately
-- (a fresh bootstrap inherits it from the source's SHOW CREATE TABLE).

ALTER TABLE tokens
  ADD INDEX IF NOT EXISTS action_index (action_index);
