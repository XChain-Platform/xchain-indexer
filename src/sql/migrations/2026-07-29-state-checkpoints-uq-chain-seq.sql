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

-- xchain:migration mode=manual
-- (manual, and deliberately NOT auto: this TIGHTENS a unique key, so it can both
--  FAIL on pre-existing duplicates and REJECT writes from code that has not yet
--  been upgraded. Applying it at boot, under a running old-code hub still
--  mirroring rows, risks a live duplicate-insert failure with no maintenance
--  window open to recover in. It applies INSIDE the deploy window, after the
--  halt and BEFORE the hub code deploy, and is verified directly on every
--  host. Run with `node src/migrate.js`.)
--
-- Migration: mirror the split-brain fence onto the indexer's
--            state_checkpoints copy
--
-- WHY
-- ---
-- The hub tightened the checkpoint unique key so a same-seq split-brain collapses
-- to exactly one admitted row. That fence was applied ON THE HUB ONLY:
--
--   xchain-hub/src/sql/state_checkpoints.sql
--     UNIQUE INDEX uq_chain_seq       (chain, network, checkpoint_seq)
--   xchain-indexer/src/sql/state_checkpoints.sql   <-- the MIRROR, pre-fix
--     UNIQUE KEY   uq_chain_block_seq (chain, network, block_index, checkpoint_seq)
--
-- The mirror kept the older, WIDER key, so it happily admits two rows at one
-- checkpoint_seq as long as their block_index differs. That is precisely the
-- split-brain the fence exists to stop, surviving on the side that most readers
-- actually query. The hub-side comment reasons that "the anchor publisher's
-- MAX(checkpoint_seq) selection can never see two rows at one seq and
-- double-spend a DOGE anchor for one logical checkpoint" -- true of the hub's
-- own DB, and NOT true of any consumer reading the mirrored table on an indexer.
-- A one-sided fence is not a fence; it just moves where the fork is visible.
--
-- ORDER MATTERS: DROP BEFORE ADD
-- ------------------------------
-- The two keys are not independent. (chain, network, checkpoint_seq) is a strict
-- prefix of (chain, network, block_index, checkpoint_seq) only in content, not in
-- column order, so both can coexist and the old one would keep admitting nothing
-- extra -- but leaving it costs a redundant index on every insert and, worse,
-- leaves a second definition of "unique" for the next reader to reason about.
-- Drop it.
--
-- PRE-EXISTING DUPLICATES
-- -----------------------
-- Adding the tighter key FAILS if the table already holds two rows at one
-- (chain, network, checkpoint_seq). Under a fleet-wide rebase this cannot happen:
-- every indexer DB is rebuilt from the base schema and replayed (spec §3.1), so
-- the table is empty when this runs and the base schema below already carries the
-- tightened key. This migration therefore exists for schema PARITY and for any
-- third-party DB that was not rebuilt. If it fails here with a duplicate-key
-- error, that is a REAL split-brain to adjudicate in the deploy report, not
-- something to force past: inspect with
--
--   SELECT chain, network, checkpoint_seq, COUNT(*) c, GROUP_CONCAT(block_index)
--     FROM state_checkpoints
--    GROUP BY chain, network, checkpoint_seq HAVING c > 1;
--
-- IDEMPOTENCE
-- -----------
-- Both statements are guarded so a re-run is a no-op, matching the ungated,
-- idempotent discipline every migration in this batch follows.

-- Drop the old wider key, only if it is actually present.
SET @drop_sql = (
    SELECT IF(COUNT(*) > 0,
              'ALTER TABLE state_checkpoints DROP INDEX uq_chain_block_seq',
              'DO 0')
      FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = 'state_checkpoints'
       AND INDEX_NAME   = 'uq_chain_block_seq'
);
PREPARE stmt FROM @drop_sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Add the tightened fence, only if it is not already there.
SET @add_sql = (
    SELECT IF(COUNT(*) = 0,
              'CREATE UNIQUE INDEX uq_chain_seq ON state_checkpoints (chain, network, checkpoint_seq)',
              'DO 0')
      FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = 'state_checkpoints'
       AND INDEX_NAME   = 'uq_chain_seq'
);
PREPARE stmt FROM @add_sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
