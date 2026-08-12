-- xchain:migration mode=auto
-- Migration: composite index (status_id, action_index) on order_statuses,
-- swap_statuses and dispenser_statuses, replacing their redundant single-column
-- status_id indexes.
--
-- WHY
-- ---
-- getExpiredItems (db.js) runs the per-block expiry sweep over every open
-- order/swap/dispenser. For each type it joins the *_statuses table to
-- index_statuses to keep only 'open' rows and checks the latest-status row:
--   INNER JOIN <t>_statuses s1 ON (s1.<t>_action_index = m.action_index)
--   INNER JOIN index_statuses s2 ON (s2.id = s1.status_id)
--   WHERE s1.action_index = (SELECT MAX(...) ...) AND s2.status='open'
-- The status filter enters *_statuses by status_id, and the query also needs
-- s1.action_index. With only a single-column status_id index the trailing
-- action_index came from a row lookup; the composite (status_id, action_index)
-- lets the 'open'-status probe range-scan and stay covering for the check.
--
-- The composite covers `WHERE status_id = ?` as a leading-column prefix, so the
-- old single-column status_id index is redundant and dropped. verifyTables ->
-- reconcileTableIndexes runs BEFORE this migration at every boot and ADDs the
-- composite declared in the base schema (order_statuses.sql / swap_statuses.sql /
-- dispenser_statuses.sql), so the covering index is in place before the DROP; the
-- ADD IF NOT EXISTS below is belt-and-suspenders for the same effect. The DROP
-- cannot fail on data (it is not UNIQUE), so it belongs on the auto path.
--
-- This is the pure-index leg of the scan-bounding work; pushing the expiration<?
-- predicate into SQL and the latest-status denormalization are deliberately left
-- to a follow-up consensus-trap fix.
--
-- Idempotent (ADD/DROP INDEX IF [NOT] EXISTS) and additive. The InnoDB secondary-
-- index build is online (INPLACE) and does not block DML. On a freshly reindexed DB
-- the tables are small and the build is instant. Snapshot-bootstrapped sync replicas
-- do not run this runner, so existing replica indexer DBs need it applied separately
-- (a fresh bootstrap inherits it from the source's SHOW CREATE TABLE).

ALTER TABLE order_statuses
  ADD INDEX IF NOT EXISTS status_action (status_id, action_index);

ALTER TABLE order_statuses
  DROP INDEX IF EXISTS status_id;

ALTER TABLE swap_statuses
  ADD INDEX IF NOT EXISTS status_action (status_id, action_index);

ALTER TABLE swap_statuses
  DROP INDEX IF EXISTS status_id;

ALTER TABLE dispenser_statuses
  ADD INDEX IF NOT EXISTS status_action (status_id, action_index);

ALTER TABLE dispenser_statuses
  DROP INDEX IF EXISTS status_id;
