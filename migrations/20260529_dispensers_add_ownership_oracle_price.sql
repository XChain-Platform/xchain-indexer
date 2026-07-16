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
-- The `dispensers` table gained four columns that have no historical presence
-- in older databases:
--   * `give_ownership`    — 1 = dispenser sells GIVE_TICK ownership (single-shot)
--   * `fiat_id`           — id of record in index_fiats table
--   * `fiat_amount`       — amount of FIAT required to trigger a dispense
--   * `oracle_address_id` — id of record in index_addresses (user oracle SOURCE address)
-- See src/sql/dispensers.sql for the canonical definition.
--
-- The indexer reconciles its own schema on startup (src/db.js verifyTables)
-- and will auto-add any nullable column declared in src/sql/dispensers.sql but
-- missing from the live table. However the reconciliation deliberately SKIPS a
-- NOT NULL column with no DEFAULT, and does not run at all on replica/validator
-- databases that are bootstrapped from a SQL snapshot rather than created by the
-- indexer. `give_ownership` is NOT NULL (it does carry a DEFAULT 0 so the live
-- backfill would succeed), but snapshot-bootstrapped replicas still need this.
-- Run this once on any database created before these columns shipped to bring it
-- fully in line; without it, the first DISPENSER action (createDispenser names
-- all four columns in its INSERT) and any streamed dispensers snapshot row fail
-- with `Unknown column`.
--
-- Column types/nullability mirror src/sql/dispensers.sql exactly. Indexes match
-- the canonical source (give_ownership, fiat_id, oracle_address_id are indexed).
-- IF NOT EXISTS makes it safe to run on a database that has already been
-- partially reconciled.

ALTER TABLE dispensers
  ADD COLUMN IF NOT EXISTS give_ownership    TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fiat_id           BIGINT UNSIGNED,
  ADD COLUMN IF NOT EXISTS fiat_amount       VARCHAR(250),
  ADD COLUMN IF NOT EXISTS oracle_address_id BIGINT UNSIGNED,
  ADD INDEX  IF NOT EXISTS give_ownership    (give_ownership),
  ADD INDEX  IF NOT EXISTS fiat_id           (fiat_id),
  ADD INDEX  IF NOT EXISTS oracle_address_id (oracle_address_id);
