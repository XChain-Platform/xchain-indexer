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

-- Migration: index_addresses.block_index secondary index
--
-- SUPERSEDED: do NOT hand-run this. The equivalent statement now ships as the
-- runner-tracked, ledger-recorded migration
-- src/sql/migrations/2026-06-21-index-tables-block-index-secondary-idx.sql
-- (mode=auto, applied at boot). This legacy copy is inert (runMigrations never reads
-- this directory) and is retained only for history. Its note about schema
-- reconciliation adding columns but not indexes is also stale: verifyTables has since
-- gained reconcileTableIndexes (src/db.js).
--
-- Adds a secondary index on index_addresses(block_index), supporting the advisory
-- index-map parity checksum (xchain-sync BlockHasher.computeIndexMapChecksum), whose
-- deterministic subset predicate is otherwise a full table scan; INDEX_MAP_PARITY_CHECK
-- ships default-off for that reason. The same predicate shape backs rollback's
-- per-block delete, so the index helps reorg handling too.
--
-- The indexer's schema reconciliation adds missing columns but not indexes, and
-- snapshot-bootstrapped sync replicas don't run it at all (they mirror SHOW CREATE
-- TABLE, so a freshly bootstrapped replica inherits this index once the source carries
-- it). Run this once on any indexer or existing sync replica DB created before this
-- shipped; purely additive and safe to re-run.

ALTER TABLE index_addresses
  ADD INDEX IF NOT EXISTS block_index (block_index);
