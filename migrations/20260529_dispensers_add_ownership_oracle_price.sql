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

-- Migration: DISPENSER ownership + oracle-price columns
--
-- Adds four columns absent from older databases: give_ownership (1 = dispenser sells
-- GIVE_TICK ownership, single-shot), fiat_id, fiat_amount, and oracle_address_id (user
-- oracle SOURCE address). See src/sql/dispensers.sql for the canonical definition.
--
-- The indexer's startup schema reconciliation (src/db.js verifyTables) auto-adds
-- missing nullable columns, but skips NOT NULL columns with no DEFAULT and never runs
-- on replica/validator databases bootstrapped from a SQL snapshot. give_ownership is
-- NOT NULL with a DEFAULT so live backfill succeeds, but snapshot-bootstrapped
-- replicas still need this migration; without it, createDispenser's INSERT and any
-- streamed dispensers snapshot row fail with `Unknown column`. IF NOT EXISTS makes it
-- safe to re-run on a partially-reconciled database.

ALTER TABLE dispensers
  ADD COLUMN IF NOT EXISTS give_ownership    TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fiat_id           BIGINT UNSIGNED,
  ADD COLUMN IF NOT EXISTS fiat_amount       VARCHAR(250),
  ADD COLUMN IF NOT EXISTS oracle_address_id BIGINT UNSIGNED,
  ADD INDEX  IF NOT EXISTS give_ownership    (give_ownership),
  ADD INDEX  IF NOT EXISTS fiat_id           (fiat_id),
  ADD INDEX  IF NOT EXISTS oracle_address_id (oracle_address_id);
