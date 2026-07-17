-- xchain:migration mode=auto
-- Migration: ledger the two VOTE-callback timelock columns on polls.
--
-- WHY
-- ---
-- polls.sql declares callback_delay_blocks / callback_due_block (the v0
-- CALLBACK_DELAY_BLOCKS timelock and the resolved due-block stamp, added after
-- the binding-poll release), but no dated migration ever ledgered them. The
-- startup drift reconciler (alterTableForDrift, db.js) adds them on
-- indexer-booted nodes, so schema-from-definitions converges; a DB converged by
-- replaying src/sql/migrations/ alone (operator-managed / rebuilt replica) never
-- gains them. Consumers reference them unconditionally -- the poll re-open reset
-- (rollback.js sets callback_due_block = NULL) and the callback-due UPDATE
-- (db.js: `polls SET callback_due_block=?`) -- so such a DB hits the same
-- ER_BAD_FIELD_ERROR crash class the 2026-07-05 binding-callback migration was
-- written to close.
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS re-runs as a no-op, and the
-- specs + AFTER anchors match polls.sql exactly (callback_execute_action_index
-- is the definition-order predecessor) so a migrated table and a freshly created
-- one agree byte-for-byte under SHOW CREATE TABLE.
--
-- HOW TO RUN
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-07-17-polls-callback-delay-columns.sql

ALTER TABLE polls
  ADD COLUMN IF NOT EXISTS callback_delay_blocks BIGINT UNSIGNED AFTER callback_execute_action_index,
  ADD COLUMN IF NOT EXISTS callback_due_block    BIGINT UNSIGNED AFTER callback_delay_blocks;
