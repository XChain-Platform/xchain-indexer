-- xchain:migration mode=auto
-- Migration: ledger the price_snapshots and cross_chain_calls reorg-fence / view columns.
--
-- WHY
-- ---
-- Two mirror tables declare post-release columns in their definition (src/sql/*.sql)
-- with no dated migration behind them, so a DB converged by replaying the dated
-- migrations alone (operator-managed / rebuilt replica) never gains them:
--   price_snapshots.push_generation    BIGINT NOT NULL DEFAULT 0  -- source-chain reorg fence (item 5308), mirrored from the hub
--   cross_chain_calls.finalizing_view  INT    NOT NULL DEFAULT 0  -- PBFT view the round finalized at (WI-2 bump 2), signed into the EQUIV canonical
--   cross_chain_calls.push_generation  BIGINT NOT NULL DEFAULT 0  -- source-chain reorg fence (item 5308), mirrored from the hub
-- The startup drift reconciler adds them (they carry DEFAULTs) on indexer-booted
-- nodes, so schema-from-definitions converges there; a replay-only replica does not.
--
-- Unlike the 2026-07-17 sibling headers claim, this is NOT a silent no-op on a short
-- table: hub_db_sync derives `fenced` from the incoming event alone (the retraction
-- carries a generation), not from local column presence, and the retraction DELETE
-- then appends `AND push_generation <= ?` unconditionally. On a replica missing the
-- column that DELETE fails with ER_BAD_FIELD_ERROR rather than degrading. For
-- cross_chain_calls (quorum-class) hub_db_sync refuses UNfenced retractions outright,
-- so every retraction it accepts is fenced and the error is guaranteed there.
-- This finishes the item-5308 family (oracle_prices and cross_chain_matches were
-- ledgered on 2026-07-17; these two were the remaining members).
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS re-runs as a no-op; the specs and
-- AFTER anchors match the definition files exactly (price_snapshots.push_generation
-- after source_action_index; cross_chain_calls.finalizing_view after effective_time;
-- cross_chain_calls.push_generation after validator_signatures) so a migrated table
-- and a freshly created one agree byte-for-byte under SHOW CREATE TABLE. Types match
-- the definitions: cross_chain_calls.push_generation is signed BIGINT (not UNSIGNED)
-- and finalizing_view is INT.
--
-- HOW TO RUN
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-07-19-price-snapshots-cross-chain-calls-reorg-fence-columns.sql

ALTER TABLE price_snapshots
  ADD COLUMN IF NOT EXISTS push_generation BIGINT NOT NULL DEFAULT 0 AFTER source_action_index;

ALTER TABLE cross_chain_calls
  ADD COLUMN IF NOT EXISTS finalizing_view INT    NOT NULL DEFAULT 0 AFTER effective_time,
  ADD COLUMN IF NOT EXISTS push_generation BIGINT NOT NULL DEFAULT 0 AFTER validator_signatures;
