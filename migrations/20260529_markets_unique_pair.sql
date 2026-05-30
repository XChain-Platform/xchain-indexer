-- Migration: markets unique (tick1_id, tick2_id) pair
--
-- The `markets` table holds derived DEX summary data, one row per traded pair.
-- It had no uniqueness guarantee on (tick1_id, tick2_id), so two inserts that
-- raced past the createMarket() existence check could both create a row for the
-- same pair, leaving duplicate rows. getMarketInfo()'s lookup would then pick
-- one arbitrarily, so different nodes could report different snapshots for the
-- same pair, and the AUTO_INCREMENT id assigned to a pair was non-deterministic.
-- See src/sql/markets.sql for the canonical definition.
--
-- The indexer reconciles its own schema on startup (src/db.js verifyTables) but
-- that reconciliation only adds missing COLUMNS, never indexes, and does not run
-- on replica/validator databases bootstrapped from a SQL snapshot. Run this once
-- on any database created before the unique key shipped.
--
-- Step 1 removes existing duplicate pairs, keeping the lowest id for each pair.
-- Step 2 adds the unique key. IF NOT EXISTS makes step 2 safe to re-run.

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
