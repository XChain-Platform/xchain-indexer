-- xchain:migration mode=auto
-- Migration: prices.batch_first_round / batch_last_round / round_count / rounds_json.
--
-- WHY
-- ---
-- PRICE v2 replaces the per-round DOGE publication with one hourly BATCH action that
-- carries the full bodies of every finalized round in the window under ONE quorum
-- signature set. The prices table had no columns to hold a batch: pair_count / pairs_json
-- / sig_count / sigs_json are shaped for exactly one round's pairs and one round's
-- signatures, and a v2 row needs the window bounds plus every round it carries.
--
-- round_number is set to FIRST_ROUND on a v2 row (the column is indexed and every
-- existing read treats it as "the round this action is about"); sigs_json is reused
-- for the batch signature set; pair_count/pairs_json/sig_count stay NULL on a v2 row.
-- See src/sql/prices.sql for the full column-by-column rationale.
--
-- Additive and idempotent (IF NOT EXISTS on every ADD COLUMN), which is what makes it
-- safe to apply unattended fleet-wide: existing v0/v1 rows keep every new column NULL,
-- which is exactly what createPrice writes for a non-batch row, so there is nothing to
-- backfill.
--
-- POSITION matters here, not just presence: all four columns land AFTER sigs_json, in
-- the same order src/sql/prices.sql declares them, so a fresh install (definition path)
-- and a long-lived DB (this ledger path) converge on a byte-identical SHOW CREATE TABLE.
-- test/unit/sql-schema-column-parity.test.js fails CI on any divergence.
--
-- The startup drift reconciler (alterTableForDrift) converges a fresh or aged install
-- from src/sql/prices.sql independently, so a node that never replays this file still
-- ends up with the same schema. This file exists for replicas converged by replaying
-- migrations alone.
--
-- HOW TO RUN
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-08-26-prices-add-v2-batch-columns.sql

ALTER TABLE prices
  ADD COLUMN IF NOT EXISTS batch_first_round BIGINT UNSIGNED AFTER sigs_json,
  ADD COLUMN IF NOT EXISTS batch_last_round  BIGINT UNSIGNED AFTER batch_first_round,
  ADD COLUMN IF NOT EXISTS round_count       SMALLINT UNSIGNED AFTER batch_last_round,
  ADD COLUMN IF NOT EXISTS rounds_json       TEXT AFTER round_count;
