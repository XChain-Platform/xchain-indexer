-- xchain:migration mode=auto
-- Migration: composite index (source_id, block_index) on validator_rewards and
-- reward_claims, replacing their redundant single-column source_id indexes.
--
-- WHY
-- ---
-- getUnclaimedRewardTotal (db.js) runs on every COLLECT and re-sums a source's
-- reward and claim ledgers from scratch:
--   SELECT SUM(amount) FROM validator_rewards WHERE source_id = ? [AND block_index <= ?]
--   SELECT SUM(amount) FROM reward_claims rc JOIN index_statuses s ...
--                      WHERE rc.source_id = ? AND s.status='valid' [AND rc.block_index <= ?]
-- Both tables carried only a single-column source_id index, so the block-scoped
-- form (COLLECT passes its BLOCK_INDEX for replay determinism) filtered
-- block_index by row scan over every reward/claim a source has ever accrued, with
-- no archive/claimed-row pruning to bound the set. A composite on
-- (source_id, block_index) lets the scoped SUM range-scan exactly the source's
-- at-or-before-block rows.
--
-- The composite covers `WHERE source_id = ?` as a leading-column prefix, so the
-- old single-column source_id index is redundant and dropped. verifyTables ->
-- reconcileTableIndexes runs BEFORE this migration at every boot and ADDs the
-- composite declared in the base schema (validator_rewards.sql / reward_claims.sql),
-- so the covering index is in place before the DROP; the ADD IF NOT EXISTS below is
-- belt-and-suspenders for the same effect. The DROP cannot fail on data (it is not
-- UNIQUE), so it belongs on the auto path.
--
-- Idempotent (ADD/DROP INDEX IF [NOT] EXISTS) and additive. The InnoDB secondary-
-- index build is online (INPLACE) and does not block DML. On a freshly reindexed DB
-- the tables are small and the build is instant. Snapshot-bootstrapped sync replicas
-- do not run this runner, so existing replica indexer DBs need it applied separately
-- (a fresh bootstrap inherits it from the source's SHOW CREATE TABLE).

ALTER TABLE validator_rewards
  ADD INDEX IF NOT EXISTS source_block (source_id, block_index);

ALTER TABLE validator_rewards
  DROP INDEX IF EXISTS source_id;

ALTER TABLE reward_claims
  ADD INDEX IF NOT EXISTS source_block (source_id, block_index);

ALTER TABLE reward_claims
  DROP INDEX IF EXISTS source_id;
