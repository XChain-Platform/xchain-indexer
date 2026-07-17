-- xchain:migration mode=auto
-- Migration: ledger the cross_chain_matches reorg-fence / view columns.
--
-- WHY
-- ---
-- cross_chain_matches.sql declares three post-release columns with no dated
-- migration behind them:
--   finalizing_view   INT    NOT NULL DEFAULT 0  -- PBFT view the round finalized at (WI-2 bump 2), signed into the EQUIV canonical
--   a_push_generation BIGINT NOT NULL DEFAULT 0  -- A-leg source-chain reorg fence (item 5308), mirrored from the hub
--   b_push_generation BIGINT NOT NULL DEFAULT 0  -- B-leg source-chain reorg fence (item 5308), mirrored from the hub
-- The startup drift reconciler adds all three (they carry DEFAULTs) on
-- indexer-booted nodes, so schema-from-definitions converges; a DB converged by
-- replaying the dated migrations alone (operator-managed / rebuilt replica) never
-- gains them, so the generation-fenced retraction they exist for silently
-- degrades there -- hub_db_sync fences deletes conditionally on column presence
-- (`... WHERE a_push_generation ...`, `fenced ? ' AND push_generation <= ?' : ''`),
-- so the fence just no-ops on a table missing the column. Same
-- definition-without-ledger class as the sibling 2026-06-09 partial-fill and
-- 2026-07-07 payout-legs migrations for this table.
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS re-runs as a no-op; the specs
-- and AFTER anchors match cross_chain_matches.sql exactly (finalizing_view after
-- effective_time; a_push_generation after anchor_txid; b_push_generation after
-- a_push_generation) so a migrated table and a freshly created one agree
-- byte-for-byte under SHOW CREATE TABLE.
--
-- HOW TO RUN
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-07-17-cross-chain-matches-reorg-fence-columns.sql

ALTER TABLE cross_chain_matches
  ADD COLUMN IF NOT EXISTS finalizing_view   INT    NOT NULL DEFAULT 0 AFTER effective_time,
  ADD COLUMN IF NOT EXISTS a_push_generation BIGINT NOT NULL DEFAULT 0 AFTER anchor_txid,
  ADD COLUMN IF NOT EXISTS b_push_generation BIGINT NOT NULL DEFAULT 0 AFTER a_push_generation;
