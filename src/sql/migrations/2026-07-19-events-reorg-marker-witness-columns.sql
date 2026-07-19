-- xchain:migration mode=auto
-- Migration: ledger the events reorg-marker witness columns.
--
-- WHY
-- ---
-- getReorgsSince(afterId) matched decoder reorgs by bare events.id. The existing RE-1
-- guard only fires on the OVER-cursor case (results empty AND maxId<afterId). A decoder
-- rebuilt/restored out-of-band, whose fresh AUTO_INCREMENT id space already overtook a
-- stranded cursor, returns NON-empty results for id>afterId and silently drops any
-- new-incarnation REORG event at/below the cursor (under-cursor skip). To close that,
-- the indexer now WITNESSES the cursor row: createReorg records the decoder event's
-- `time` and a sha256 of its `data` payload alongside the marker, and getReorgsSince
-- verifies the live decoder row still matches (fail-loud RE-1 on mismatch/absence).
--
-- events.sql now declares two nullable columns for that witness:
--   witness_time DATETIME   -- the decoder event's time when the marker was recorded
--   witness_hash CHAR(64)   -- sha256 of the decoder event's data payload
-- A DB converged by replaying the dated migrations alone (operator-managed / rebuilt
-- replica) never gains them, so old markers there would carry no witness. Additive +
-- back-compatible: a legacy marker (NULL witness) falls back to the old one-directional
-- guard, so upgrades keep working.
--
-- NOT consensus-visible: the columns are on the indexer's own events / reorg-marker
-- table, never in the block-hash preimage. Throws-on-mismatch is a fail-loud safety
-- halt, not a ledger-hash change. Additive + idempotent: ADD COLUMN IF NOT EXISTS
-- re-runs as a no-op; the AFTER anchors match events.sql (witness_time after data,
-- witness_hash after witness_time) so a migrated and a fresh table agree under
-- SHOW CREATE TABLE.
--
-- HOW TO RUN
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-07-19-events-reorg-marker-witness-columns.sql

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS witness_time DATETIME  AFTER data,
  ADD COLUMN IF NOT EXISTS witness_hash CHAR(64)  AFTER witness_time;
