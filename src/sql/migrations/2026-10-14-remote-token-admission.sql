-- xchain:migration mode=auto
-- Migration: signed admission heights on the mirrored remote-token pins.
--
-- Additive and idempotent. The columns match src/sql/remote_token_snapshots.sql and sit
-- after source_action_index so migrated and fresh databases converge. Rows signed below
-- remote_token_admission_activation carry all three as NULL.

ALTER TABLE remote_token_snapshots
  ADD COLUMN IF NOT EXISTS admit_block_btc BIGINT UNSIGNED DEFAULT NULL AFTER source_action_index,
  ADD COLUMN IF NOT EXISTS admit_block_ltc BIGINT UNSIGNED DEFAULT NULL AFTER admit_block_btc,
  ADD COLUMN IF NOT EXISTS admit_block_doge BIGINT UNSIGNED DEFAULT NULL AFTER admit_block_ltc;
