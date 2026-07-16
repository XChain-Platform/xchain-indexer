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
-- Migration: secondary index `block_index` on validator_rewards.
--
-- WHY
-- ---
-- rollback.js deletes validator_rewards in the blockTables loop
-- (DELETE FROM validator_rewards WHERE block_index >= ?). The table has three
-- existing indexes (reward_unique, source_id, signing_pubkey_id) but none on
-- block_index, so every reorg-delete is a full table scan. On a large chain or a
-- deep reorg this scans the entire reward history. Adding a secondary index on
-- block_index makes the reorg-delete a bounded range scan.
--
-- Idempotent (ADD INDEX IF NOT EXISTS) and additive; the InnoDB secondary-index
-- build is online (INPLACE) and does not block DML. On a freshly reindexed DB the
-- table is empty and the build is instant. Snapshot-bootstrapped sync replicas do
-- not run this runner, so existing replica indexer DBs need it applied separately
-- (a fresh bootstrap inherits it from the source's SHOW CREATE TABLE).

ALTER TABLE validator_rewards
  ADD INDEX IF NOT EXISTS block_index (block_index);
