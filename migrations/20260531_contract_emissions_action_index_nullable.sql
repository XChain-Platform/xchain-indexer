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

-- Migration: contract_emissions.action_index, allow NULL for internal emissions
--
-- A contract execution records one contract_emissions row per emitted action; on-wire
-- emissions (ORDER/SWAP/etc.) link action_index to the on-chain action produced, but SLASH
-- emissions are internal-only (deduct stake, credit the slash destination, write a
-- slash_events row) and mint no on-wire action, so execute.js inserts action_index = NULL
-- (see src/actions/execute.js). The column was declared NOT NULL, so that insert failed
-- with "Column 'action_index' cannot be null", rolling back the emission savepoint and
-- marking the whole EXECUTE `failed` even though the contract ran successfully, breaking
-- every contract-emitted SLASH. See src/sql/contract_emissions.sql for the canonical
-- definition.
--
-- All readers tolerate NULL and nothing JOINs on action_index, so this is safe on any
-- database created before the fix shipped. The indexer's startup schema reconciliation
-- (db.js alterTableForDrift) already relaxes NOT NULL -> NULL automatically, so most
-- databases self-heal on first boot; this migration is for environments that skip that
-- reconciliation (snapshot-bootstrapped xchain-sync replicas) or to relax the constraint
-- ahead of the code roll.

ALTER TABLE contract_emissions
  MODIFY COLUMN action_index BIGINT UNSIGNED NULL;
