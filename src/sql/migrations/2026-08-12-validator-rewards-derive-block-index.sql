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
-- spendable and is replicated to validators by xchain-sync (stream:block). It is
-- byte-neutral while ANCHOR_REWARD_DERIVE_ACTIVATION is inert: no derived reward exists,
-- so every column added here stays NULL and every new rollback predicate is a no-op.
-- Snapshot-bootstrapped replicas inherit the columns from the source's SHOW CREATE TABLE.
--
-- HOW THE SCHEMA ACTUALLY ARRIVES. Every object this file adds is also declared in
-- src/sql/validator_rewards.sql (derive_block_index + its index) and
-- src/sql/anchor_reward_reconcile_log.sql (reward_derive_block_index), as
-- nullable-with-DEFAULT columns and a non-unique index. verifyTables() runs BEFORE
-- runMigrations() at startup, so the drift reconciler converges all three on any node
-- that boots this build, whether or not anyone runs this file. mode=manual therefore
-- does NOT hold the change back across the fleet, and must not be read as if it did:
-- it keeps this file the explicit, auditable apply path for a database an operator
-- converges by replaying migrations alone. Where the converged shape is already
-- present, Database.MIGRATION_PRECONDITIONS baselines this file - the runner records
-- it as applied without executing a statement, so the ledger states what is true
-- instead of listing a permanent no-op as outstanding work.
--
-- WHAT THE FLEET ACTUALLY HAS TO AGREE ON, before any ANCHOR_REWARD_DERIVE_ACTIVATION
-- height is ratified on mainnet/testnet, is a BINARY property, not a ledger row: every
-- node must run a build whose reorg rollback scopes the reward delete on BOTH
-- block_index and derive_block_index. A node on an older build has the columns (the
-- reconciler gave them to it) and still scopes the delete on the earn-block alone. No
-- migration ledger ever enforced that, and this file cannot; the deploy is what does.
--
-- HOW TO RUN
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-08-12-validator-rewards-derive-block-index.sql

ALTER TABLE validator_rewards
  ADD COLUMN IF NOT EXISTS derive_block_index BIGINT UNSIGNED DEFAULT NULL AFTER block_index;

ALTER TABLE validator_rewards
  ADD INDEX IF NOT EXISTS derive_block_index (derive_block_index);

ALTER TABLE anchor_reward_reconcile_log
  ADD COLUMN IF NOT EXISTS reward_derive_block_index BIGINT UNSIGNED DEFAULT NULL AFTER reward_block_index;
