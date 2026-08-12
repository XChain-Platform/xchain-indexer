-- xchain:migration mode=auto
-- Migration: add the six binding-poll / callback-on-finalize columns to polls.
--
-- WHY
-- ---
-- The binding-poll feature (VOTE callback EXECUTE, commit 6d32313) added
-- callback_contract_index / callback_method / callback_params / callback_on /
-- gas_escrow / callback_execute_action_index to polls.sql but shipped no
-- migration, so a polls table created before that commit never gains them (the
-- startup drift reconciler handles nullability and indexes, not new columns).
-- On such a DB the FIRST reorg rollback hard-wedges the indexer: the polls
-- re-open reset (rollback.js) unconditionally SETs
-- callback_execute_action_index and throws ER_BAD_FIELD_ERROR, crash-looping
-- block processing (found 2026-07-05 when the LTC-regtest actions sweep's first
-- reorg test wedged the LTC indexer; DOGE had the same drift).
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS re-runs as a no-op, and the
-- definitions + placement match polls.sql exactly so a migrated table and a
-- freshly created one agree. Snapshot-bootstrapped sync replicas inherit the
-- full schema from the source's SHOW CREATE TABLE, so only live indexer DBs
-- created between the VOTE Phase-1 push and the binding-poll commit need this.

ALTER TABLE polls
  ADD COLUMN IF NOT EXISTS callback_contract_index BIGINT UNSIGNED AFTER deposit_resolved,
  ADD COLUMN IF NOT EXISTS callback_method VARCHAR(64) AFTER callback_contract_index,
  ADD COLUMN IF NOT EXISTS callback_params MEDIUMTEXT AFTER callback_method,
  ADD COLUMN IF NOT EXISTS callback_on ENUM('pass','always') AFTER callback_params,
  ADD COLUMN IF NOT EXISTS gas_escrow VARCHAR(60) AFTER callback_on,
  ADD COLUMN IF NOT EXISTS callback_execute_action_index BIGINT UNSIGNED AFTER gas_escrow;
