-- xchain:migration mode=auto
-- Migration: composite index (status_id, cooldown_end_block) on unstakes and
-- contract_unstakes.
--
-- WHY
-- ---
-- The per-block cooldown sweep selects maturing unstakes with
--   WHERE cooldown_end_block <= ? AND status_id IN (?) AND CAST(amount AS DECIMAL) > 0
-- (db.js getMaturedUnstakes / contract equivalents). Both tables carry status_id
-- and cooldown_end_block only as SEPARATE single-column indexes, so the optimizer
-- can use just one and filters the rest by row scan. A composite on
-- (status_id, cooldown_end_block) lets the sweep range-scan exactly the maturing,
-- still-active rows. The CAST(amount > 0) guard stays non-sargable but only
-- filters the already-narrow composite result.
--
-- Idempotent (ADD INDEX IF NOT EXISTS) and additive; the InnoDB secondary-index
-- build is online (INPLACE) and does not block DML. On a freshly reindexed DB the
-- tables are small and the build is instant. Snapshot-bootstrapped sync replicas do
-- not run this runner, so existing replica indexer DBs need it applied separately
-- (a fresh bootstrap inherits it from the source's SHOW CREATE TABLE).

ALTER TABLE unstakes
  ADD INDEX IF NOT EXISTS status_cooldown (status_id, cooldown_end_block);

ALTER TABLE contract_unstakes
  ADD INDEX IF NOT EXISTS status_cooldown (status_id, cooldown_end_block);
