-- xchain:migration mode=auto
-- Migration: the mirror-admission height columns on the seven hub-mirrored tables,
-- so a row finalized above the producer activation is admitted by HEIGHT, not by clock.
--
-- WHY
-- ---
-- Every hub-mirrored row binds to a block by `effective_time <= t(B)`, a wall-clock
-- rule that holds the block loop up to two hours behind a future-stamped row and, on
-- the anchor-attest member, a whole day. The time-keyed mirror admission barrier
-- family replaces that with admission by height: the hub stamps each row with the block on every reading chain
-- at or above which the row is readable, the indexer's per-table per-chain height
-- watermark certifies the mirror is complete to that height, and the consuming select
-- admits the row the moment B reaches it. The columns here are the indexer's copy of
-- the hub's stamp, mirrored down with the row exactly as the hub wrote it.
--
-- SEVEN tables, in the manifest's order (test/unit/db/mirror_admission_schema.test/
-- helpers/manifest.js, which generates these statements and against which this file
-- is checked byte for byte):
--   attestation_responses  admit_block_btc only: read on BTC alone by its call-site guard
--   cross_chain_matches    btc, ltc, doge: the row's read set is a_chain OR b_chain
--   cross_chain_calls      btc, ltc, doge: target_chain OR source_chain
--   bridge_transfers       btc, ltc, doge: dest_chain alone is set, the rest uniform
--   policy_snapshots       btc, ltc, doge: every chain reads every row (no chain clause)
--   price_snapshots        btc, ltc, doge: every chain (members 2 and 3), signed via consensus_proof
--   oracle_prices          admit_block, ONE unqualified column: the unsigned rail admits by its
--                          PUBLISHING chain's height (R5 (a), B13), which source_chain names
-- The hub DDL also carries anchor_reward_attestations.admit_block_btc; it has no writer
-- and no indexer reader (that member keys on snapshot_block + 144), so it is hub-only
-- and deliberately NOT mirrored here.
--
-- NULLABLE, NO DEFAULT, and that is the consensus rule rather than a convenience. NULL is
-- the LEGACY row: finalized below the producer activation, or signed with a map that never
-- named this chain. It binds by effective_time <= t(B) at EVERY height, so the consuming
-- select is always
--   (admit_block_<c> IS NULL AND effective_time <= ?) OR (admit_block_<c> IS NOT NULL AND admit_block_<c> <= ?)
-- and never a bare `admit_block_<c> <= ?`, which evaluates to NULL for legacy rows, drops
-- them, and is a silent consensus change (family C33; db.js has the case study). Every row
-- that exists before this migration runs is a legacy row by construction, which is what
-- makes the migration old-code-safe: old code never names these columns on INSERT and they
-- take NULL, and old reads never touch them.
--
-- CONSENSUS-VISIBLE above the activation only. Below MIRROR_ADMISSION_CONSUMER_ACTIVATION
-- for (network, coin) the select is `effective_time <= ?` byte for byte and the column is
-- not read at all, so a from-genesis replay is unchanged; above it the mirrored stamp
-- decides which rows are in scope at B, and every node reads the same stamp.
--
-- POSITION. Each block is anchored with AFTER on its predecessor in the src/sql definition,
-- chained column to column, so SHOW CREATE TABLE converges between a migrated DB and a
-- fresh install (the column-parity guard compares position, not just shape). Four tables
-- take the hub's own position (after effective_time on attestation_responses and
-- bridge_transfers, after network on policy_snapshots, after push_generation on
-- oracle_prices). Three sit ONE column later than the hub: cross_chain_matches and
-- cross_chain_calls after finalizing_view, price_snapshots after batch_block_time, because
-- an earlier dated migration anchored that neighbour on the hub's slot and a column
-- inserted between them would leave the earlier anchor stale. Position is transport only:
-- the mirror writes and reads every column by NAME.
--
-- DATE. Apply order is lexical, and two of these tables are CREATEd by
-- 2026-09-12-bridge-tables.sql; a 2026-09-12-admission-height name would sort ahead of
-- that file and ALTER a table that does not yet exist on a host behind both. The file
-- carries its authoring date, which sorts after every migration it depends on.
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS throughout, a no-op on any install whose
-- boot-time alterTableForDrift has already healed the columns in from src/sql/. No index:
-- every consuming select already pins its table by (network, status, effective_time) and
-- the admission clause is a filter on the rows that index returns.
--
-- HOW TO RUN (manual path)
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-09-16-admission-height.sql

ALTER TABLE attestation_responses
  ADD COLUMN IF NOT EXISTS admit_block_btc BIGINT UNSIGNED DEFAULT NULL AFTER effective_time;

ALTER TABLE cross_chain_matches
  ADD COLUMN IF NOT EXISTS admit_block_btc BIGINT UNSIGNED DEFAULT NULL AFTER finalizing_view,
  ADD COLUMN IF NOT EXISTS admit_block_ltc BIGINT UNSIGNED DEFAULT NULL AFTER admit_block_btc,
  ADD COLUMN IF NOT EXISTS admit_block_doge BIGINT UNSIGNED DEFAULT NULL AFTER admit_block_ltc;

ALTER TABLE cross_chain_calls
  ADD COLUMN IF NOT EXISTS admit_block_btc BIGINT UNSIGNED DEFAULT NULL AFTER finalizing_view,
  ADD COLUMN IF NOT EXISTS admit_block_ltc BIGINT UNSIGNED DEFAULT NULL AFTER admit_block_btc,
  ADD COLUMN IF NOT EXISTS admit_block_doge BIGINT UNSIGNED DEFAULT NULL AFTER admit_block_ltc;

ALTER TABLE bridge_transfers
  ADD COLUMN IF NOT EXISTS admit_block_btc BIGINT UNSIGNED DEFAULT NULL AFTER effective_time,
  ADD COLUMN IF NOT EXISTS admit_block_ltc BIGINT UNSIGNED DEFAULT NULL AFTER admit_block_btc,
  ADD COLUMN IF NOT EXISTS admit_block_doge BIGINT UNSIGNED DEFAULT NULL AFTER admit_block_ltc;

ALTER TABLE policy_snapshots
  ADD COLUMN IF NOT EXISTS admit_block_btc BIGINT UNSIGNED DEFAULT NULL AFTER network,
  ADD COLUMN IF NOT EXISTS admit_block_ltc BIGINT UNSIGNED DEFAULT NULL AFTER admit_block_btc,
  ADD COLUMN IF NOT EXISTS admit_block_doge BIGINT UNSIGNED DEFAULT NULL AFTER admit_block_ltc;

ALTER TABLE price_snapshots
  ADD COLUMN IF NOT EXISTS admit_block_btc BIGINT UNSIGNED DEFAULT NULL AFTER batch_block_time,
  ADD COLUMN IF NOT EXISTS admit_block_ltc BIGINT UNSIGNED DEFAULT NULL AFTER admit_block_btc,
  ADD COLUMN IF NOT EXISTS admit_block_doge BIGINT UNSIGNED DEFAULT NULL AFTER admit_block_ltc;

ALTER TABLE oracle_prices
  ADD COLUMN IF NOT EXISTS admit_block BIGINT UNSIGNED DEFAULT NULL AFTER push_generation;
