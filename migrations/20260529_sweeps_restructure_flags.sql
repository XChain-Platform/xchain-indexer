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

-- Migration: SWEEP three-flag restructure
--
-- The `sweeps` table's single `escrows` flag was replaced by three independent
-- per-primitive flags: `orders`, `swaps`, `dispensers` (a SWEEP can now target
-- open ORDERs, SWAPs and DISPENSERs separately rather than a single combined
-- escrow flag). See src/sql/sweeps.sql for the canonical definition.
--
-- The indexer reconciles its own schema on startup (src/db.js verifyTables)
-- and will auto-add any column declared in src/sql/sweeps.sql but missing from
-- the live table. However it never DROPs the now-unused `escrows` column, and
-- the reconciliation does not run on replica/validator databases that are
-- bootstrapped from a SQL snapshot rather than created by the indexer. Run this
-- once on any database created before the restructure to bring it fully in line.
--
-- Column types/nullability mirror src/sql/sweeps.sql exactly (nullable
-- BIGINT UNSIGNED, no DEFAULT). IF EXISTS / IF NOT EXISTS make it safe to run
-- on a database that has already been partially reconciled.

ALTER TABLE sweeps
  ADD COLUMN IF NOT EXISTS orders     BIGINT UNSIGNED,
  ADD COLUMN IF NOT EXISTS swaps      BIGINT UNSIGNED,
  ADD COLUMN IF NOT EXISTS dispensers BIGINT UNSIGNED,
  DROP COLUMN IF EXISTS escrows;
