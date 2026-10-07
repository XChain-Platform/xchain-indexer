-- xchain:migration mode=auto
-- Migration: secondary indexes on resolved_block for attests, xcalls and polls, and on
-- polls.callback_due_block.
--
-- WHY
-- ---
-- The per-block state-hash collectors select every terminal flip at block B:
--   attests, xcalls: WHERE version = 0 AND resolved_block BETWEEN ? AND ?
--   polls:           WHERE resolved_block BETWEEN ? AND ?
-- and the reorg resets in rollback/in_place_flips.js filter on resolved_block >= ?. No
-- index on any of the three tables contains resolved_block, so each of those reads scanned
-- every v0 request (attests, through the version prefix of version_status) or the whole
-- table (xcalls, polls) on every block, a cost that grows with lifetime row count. The
-- sibling collectors' key columns (deactivation_block, cooldown_end_block, settled_block,
-- ...) are already indexed; these were the gaps. callback_due_block has the same shape:
-- the per-block due query (callback_due_block = ?) and its reorg reset scanned all polls.
--
-- Additive and idempotent (ADD INDEX IF NOT EXISTS); the InnoDB secondary-index build is
-- INPLACE and does not block DML. Query text, ORDER BY and the hashed preimage are
-- untouched, so state-hash output is unchanged.
--
-- Snapshot-bootstrapped sync replicas never run this runner; a replica bootstrapped after
-- this lands inherits the indexes from the source's SHOW CREATE TABLE.

ALTER TABLE attests
  ADD INDEX IF NOT EXISTS version_resolved (version, resolved_block);

ALTER TABLE xcalls
  ADD INDEX IF NOT EXISTS version_resolved (version, resolved_block);

ALTER TABLE polls
  ADD INDEX IF NOT EXISTS resolved_block (resolved_block);

ALTER TABLE polls
  ADD INDEX IF NOT EXISTS callback_due_block (callback_due_block);
