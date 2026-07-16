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

-- Migration: contract_emissions.action_index — allow NULL for internal emissions
--
-- A contract execution records one contract_emissions row per emitted action. For
-- on-wire emissions (ORDER/SWAP/etc.) action_index links to the on-chain action the
-- emission produced. SLASH emissions are internal-only: they deduct stake, credit the
-- slash destination, and write a slash_events row, but mint NO new on-wire action — so
-- they carry no resultActionIndex and execute.js inserts action_index = NULL
-- (see src/actions/execute.js, "SLASH rows carry no resultActionIndex").
--
-- The column was declared NOT NULL, so that insert failed with
-- "Column 'action_index' cannot be null", the emission savepoint rolled back, and the
-- whole EXECUTE was marked `failed` even though the contract ran successfully — making
-- every contract-emitted SLASH fail. See src/sql/contract_emissions.sql for the canonical
-- definition.
--
-- All readers (snapshot sync SELECT, rollback DELETE-by-execution_index) tolerate NULL;
-- nothing JOINs on action_index. Safe to run on any database created before this shipped.
--
-- NOTE: the indexer's startup schema reconciliation (db.js alterTableForDrift) already
-- relaxes NOT NULL -> NULL automatically, so any DB that runs the new indexer code self-heals
-- on first boot — no manual step needed there. This migration exists for environments that do
-- NOT run that reconciliation: snapshot-bootstrapped xchain-sync replicas, or to relax the
-- constraint ahead of the code roll.

ALTER TABLE contract_emissions
  MODIFY COLUMN action_index BIGINT UNSIGNED NULL;
