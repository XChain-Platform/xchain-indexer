-- xchain:migration mode=auto
-- Migration: create the bet_cancels and bet_resolves tables.
--
-- WHY
-- ---
-- BET is one action name over four formats. Create (0) owns a bet_feeds row and place
-- (2) owns a bets row, and both are written whatever the parse status, so a rejected
-- create or place persists 'invalid: <reason>'. Cancel (1) and resolve (3) owned NO row
-- of their own: they only appended a bet_feed_statuses history row, and only on the
-- VALID path. A chain-REJECTED cancel or resolve therefore left no status anywhere in
-- the DB, the explorer served the action with a NULL status, and the SDK could not tell
-- a rejection from a success (it reports statusKnown:false / statusSource:assumed, an
-- honest-uncertainty fallback, which is the best a consumer can do with no record to read).
-- These two tables give both legs the typed row the ORDER (order_cancels/order_edits)
-- and DISPENSER (dispenser_cancels) legs already have.
--
-- NOT consensus-visible. Neither table enters any block-hash preimage (they are
-- deterministic projections of already-hashed actions, `hashed: DERIVED` in the
-- table-lifecycle registry) and neither is read by a validation or settlement path.
-- Rows are action-scoped: replicated stream:action and unwound by the generic
-- action_index delete on source and replica alike.
--
-- Additive + idempotent: CREATE TABLE IF NOT EXISTS re-runs as a no-op, and the block
-- matches src/sql/bet_cancels.sql / src/sql/bet_resolves.sql under SHOW CREATE TABLE.
-- verifyTables auto-creates both on a fresh install; a DB converged by replaying the
-- dated migrations alone (operator-managed or rebuilt replica) never gains them without
-- this migration. The declared indexes are re-added by reconcileTableIndexes at startup
-- from the definition files, so they are deliberately not restated here.
--
-- HOW TO RUN
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-07-26-bet-cancel-resolve-status-tables.sql

CREATE TABLE IF NOT EXISTS bet_cancels (
    action_index      BIGINT UNSIGNED NOT NULL,
    feed_action_index BIGINT UNSIGNED,
    memo_id           BIGINT UNSIGNED,
    status_id         BIGINT UNSIGNED
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE TABLE IF NOT EXISTS bet_resolves (
    action_index      BIGINT UNSIGNED NOT NULL,
    feed_action_index BIGINT UNSIGNED,
    outcome           INT UNSIGNED,
    memo_id           BIGINT UNSIGNED,
    status_id         BIGINT UNSIGNED
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
