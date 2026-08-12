-- xchain:migration mode=manual
-- Migration: validator_rewards.derive_block_index +
--            anchor_reward_reconcile_log.reward_derive_block_index.
--
-- WHY
-- ---
-- A derived anchor/archive reward is stamped block_index = the checkpoint's
-- SNAPSHOT_BLOCK S (that is where its stake source resolves and where a replay must
-- credit it), but the row is CREATED while the BTC indexer processes a later block B.
-- rollback.js deletes validator_rewards on block_index >= H, so a reorg to any H in
-- (S, B] orphans the block that minted the row and still leaves it in place: the node
-- keeps a COLLECT-spendable reward that a clean replay to H-1 has not derived yet, so
-- the next COLLECT's SUM(validator_rewards) forks against a freshly-synced node.
--
-- reward_block_index in the RB-ANCHOR pre-image log has the same blind spot from the
-- other side: it records the loser's earn-block S, so the reorg restore re-INSERTs a
-- loser whose earn-block survives even when the block that MATERIALIZED that loser is
-- itself inside the orphaned range, leaving orphaned losers a replay never mints.
--
-- Both are fixed by persisting the materialization block: the reward row carries it
-- (derive_block_index), and the reconcile log pre-images it alongside the earn-block
-- (reward_derive_block_index) so the restore can require BOTH to survive.
--
-- CONSENSUS-RELEVANT SURFACE, NOT A CONSENSUS CHANGE. validator_rewards is COLLECT-
-- spendable and is replicated to validators by xchain-sync (stream:block), so this is a
-- coordinated FLEET migration: apply it everywhere BEFORE any ANCHOR_REWARD_DERIVE_
-- ACTIVATION height is ratified on mainnet/testnet. It is byte-neutral while that gate
-- is inert: no derived reward exists, so every column added here stays NULL and every
-- new rollback predicate is a no-op. Snapshot-bootstrapped replicas inherit the columns
-- from the source's SHOW CREATE TABLE; replicas converged by replaying migrations alone
-- need this file applied.
--
-- mode=manual on purpose. It is additive and idempotent (IF NOT EXISTS throughout), but
-- it retimes when a reward row disappears on reorg on a table validators replicate, so
-- the operator lands it deliberately across the fleet rather than having a rolling
-- restart apply it on some nodes and not others. The startup drift reconciler
-- (alterTableForDrift) converges a fresh/aged install from src/sql/*.sql independently,
-- so a node that never runs this file still ends up with the same schema.
--
-- HOW TO RUN
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-08-12-validator-rewards-derive-block-index.sql

ALTER TABLE validator_rewards
  ADD COLUMN IF NOT EXISTS derive_block_index BIGINT UNSIGNED DEFAULT NULL AFTER block_index;

ALTER TABLE validator_rewards
  ADD INDEX IF NOT EXISTS derive_block_index (derive_block_index);

ALTER TABLE anchor_reward_reconcile_log
  ADD COLUMN IF NOT EXISTS reward_derive_block_index BIGINT UNSIGNED DEFAULT NULL AFTER reward_block_index;
