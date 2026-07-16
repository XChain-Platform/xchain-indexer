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
-- Migration: secondary index `block_index` on cross_chain_settlements.
--
-- WHY
-- ---
-- Every contract EXECUTE builds its settled-leg snapshot with
--   SELECT ... FROM cross_chain_settlements WHERE block_index < ? AND a_chain IS NOT NULL
-- (db.js, the cross-chain settlement exposure for getCallResult/settled set). The
-- table has indexes on match_id, action_index and local_action_index but none on
-- block_index, so the block-causality filter is a full table scan on every
-- execution. A secondary index on block_index makes it a bounded range scan.
--
-- Idempotent (ADD INDEX IF NOT EXISTS) and additive; the InnoDB secondary-index
-- build is online (INPLACE) and does not block DML. On a freshly reindexed DB the
-- table is small and the build is instant. Snapshot-bootstrapped sync replicas do
-- not run this runner, so existing replica indexer DBs need it applied separately
-- (a fresh bootstrap inherits it from the source's SHOW CREATE TABLE).

ALTER TABLE cross_chain_settlements
  ADD INDEX IF NOT EXISTS block_index (block_index);
