-- xchain:migration mode=auto
-- Migration: composite index (status, reference_block, round_number) on price_snapshots.
--
-- WHY
-- ---
-- The oracle snapshot preload run on contract executions does
--   SELECT ... FROM price_snapshots
--   WHERE status = 'finalized' AND price IS NOT NULL AND reference_block <= ?
--   ORDER BY round_number DESC LIMIT 50000
-- (db.js getPriceAtRound preload). Existing indexes (idx_round_pair,
-- idx_pair_block, idx_pair_timestamp, idx_status) do not cover this predicate plus
-- ordering, so it runs a filesort over the finalized set. A composite on
-- (status, reference_block, round_number) lets the WHERE prune by index and the
-- round_number DESC traversal avoid the filesort.
--
-- Idempotent (ADD INDEX IF NOT EXISTS) and additive; the InnoDB secondary-index
-- build is online (INPLACE) and does not block DML. On a freshly reindexed DB the
-- table is small and the build is instant. Snapshot-bootstrapped sync replicas do
-- not run this runner, so existing replica indexer DBs need it applied separately
-- (a fresh bootstrap inherits it from the source's SHOW CREATE TABLE).

ALTER TABLE price_snapshots
  ADD INDEX IF NOT EXISTS idx_status_block_round (status, reference_block, round_number);
