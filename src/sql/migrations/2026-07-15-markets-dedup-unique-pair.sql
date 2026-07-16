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
-- Migration: dedup duplicate market pairs, then enforce uq_markets_pair.
--
-- markets.sql declares `CREATE UNIQUE INDEX uq_markets_pair (tick1_id,
-- tick2_id)` on the fresh path, but the dedup-then-UNIQUE that reconciles an
-- aged DB lived only in the legacy, never-executed migrations/ directory
-- (20260529_markets_unique_pair.sql), which runMigrations() does not scan.
-- reconcileTableIndexes() adds the UNIQUE automatically on most aged DBs,
-- but markets is NOT on the AUTO_DEDUP_TABLES allow-list (db.js), so any DB
-- carrying duplicate (tick1_id, tick2_id) rows (createMarket() race, the
-- exact rows the legacy script existed to remove) skips the build and never
-- gains the index a fresh install has.
--
-- mode=manual because step 1 DELETEs rows: an operator runs it deliberately
-- via `node src/migrate.js`. markets holds DERIVED DEX summary data (one row
-- per traded pair); the survivor is the lowest id per pair, matching the
-- legacy script, so no consensus state is touched. Idempotent: the DELETE
-- matches nothing once deduped and IF NOT EXISTS no-ops the index add.

DELETE m FROM markets m
JOIN (
    SELECT tick1_id, tick2_id, MIN(id) AS keep_id
    FROM markets
    GROUP BY tick1_id, tick2_id
    HAVING COUNT(*) > 1
) dup
  ON m.tick1_id = dup.tick1_id
 AND m.tick2_id = dup.tick2_id
 AND m.id <> dup.keep_id;

ALTER TABLE markets
  ADD UNIQUE INDEX IF NOT EXISTS uq_markets_pair (tick1_id, tick2_id);
