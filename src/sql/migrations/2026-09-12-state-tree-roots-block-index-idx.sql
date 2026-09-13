-- xchain:migration mode=auto
-- Migration: secondary index `block_index` on state_tree_roots.
--
-- WHY
-- ---
-- tableLifecycle registers state_tree_roots with rollback:'block', so the generic
-- block loop in rollback.js deletes it with
-- DELETE FROM state_tree_roots WHERE block_index >= ?, and ClientRollback runs the
-- identical predicate on a replica. The table declares only
-- UNIQUE KEY uq_chain_net_block (chain, network, block_index) and a non-unique
-- idx_chain_net_block over the same three columns. block_index leads neither, so
-- neither index serves that predicate and every reorg scans the whole root history.
-- The table takes one row per block and is never pruned by the rollback path, so the
-- scan grows with the chain.
--
-- Additive and idempotent (ADD INDEX IF NOT EXISTS); the InnoDB secondary-index build
-- is INPLACE and does not block DML. One row per block means one extra index entry per
-- block, not per action. The delete predicates are untouched, so reorg semantics are
-- unchanged. Same shape as 2026-06-23-validator-rewards-block-index-idx.sql, which
-- fixed the identical gap on validator_rewards.
--
-- Snapshot-bootstrapped sync replicas never run this runner; they get the index from
-- ensureReplicaSecondaryIndexes() in xchain-sync/src/db.js, extended in the same change.

ALTER TABLE state_tree_roots
  ADD INDEX IF NOT EXISTS block_index (block_index);
