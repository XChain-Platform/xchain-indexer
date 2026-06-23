-- xchain:migration mode=auto
-- Migration: secondary index `block_index` on validator_rewards.
--
-- WHY
-- ---
-- rollback.js deletes validator_rewards in the blockTables loop
-- (DELETE FROM validator_rewards WHERE block_index >= ?). The table has three
-- existing indexes (reward_unique, source_id, signing_pubkey_id) but none on
-- block_index, so every reorg-delete is a full table scan. On a large chain or a
-- deep reorg this scans the entire reward history. Adding a secondary index on
-- block_index makes the reorg-delete a bounded range scan.
--
-- Idempotent (ADD INDEX IF NOT EXISTS) and additive; the InnoDB secondary-index
-- build is online (INPLACE) and does not block DML. On a freshly reindexed DB the
-- table is empty and the build is instant. Snapshot-bootstrapped sync replicas do
-- not run this runner, so existing replica indexer DBs need it applied separately
-- (a fresh bootstrap inherits it from the source's SHOW CREATE TABLE).

ALTER TABLE validator_rewards
  ADD INDEX IF NOT EXISTS block_index (block_index);
