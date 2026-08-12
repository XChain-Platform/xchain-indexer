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

-- Migration: actions.source_id, persist each action's TRUE source
--
-- Adds source_id (id in index_addresses): tx sender for user actions, the contract's
-- derived address for VM emissions, NULL for system/synthetic actions. Source is now read
-- from here instead of re-derived from transactions.source_id, which mis-attributed
-- contract emissions to the EXECUTE caller, a fund-custody bug on order/swap/dispenser
-- refunds, token ownership, and cancel/sweep authorization. See src/sql/actions.sql for
-- the canonical definition.
--
-- The indexer's startup schema reconciliation (src/db.js verifyTables/alterTableForDrift)
-- auto-adds the nullable column but does not add the index or backfill existing rows,
-- which would then be NULL and dropped by the INNER JOIN on a1.source_id in
-- getOrderInfo/getSwapInfo/getDispenserInfo/getTokenInfo, breaking lookups for anything
-- created before this shipped (e.g. the gas token); snapshot-bootstrapped replicas don't
-- run the reconciliation at all. Run this once on any database created before source_id
-- shipped.
--
-- Backfill source is transactions.source_id, correct for the vast majority of
-- user-submitted actions. Pre-existing VM-emission actions backfill to their EXECUTE
-- caller (matching their original pre-fix attribution, so no regression); new emissions
-- are recorded correctly going forward. System/synthetic actions with no tx source stay
-- NULL. IF NOT EXISTS makes the DDL safe to re-run.

ALTER TABLE actions
  ADD COLUMN IF NOT EXISTS source_id BIGINT UNSIGNED,
  ADD INDEX  IF NOT EXISTS source_id (source_id);

UPDATE actions a
  JOIN transactions t ON t.tx_index = a.tx_index
  SET a.source_id = t.source_id
  WHERE a.source_id IS NULL AND t.source_id IS NOT NULL;
