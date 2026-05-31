-- Migration: actions.source_id — persist each action's TRUE source
--
-- The `actions` table gained a `source_id` column (id of record in index_addresses): the
-- action's true source — tx sender for user actions, the contract's derived address for VM
-- emissions, NULL for system/synthetic actions. Source is now read from here
-- (actions.source_id) instead of re-derived from transactions.source_id, which
-- mis-attributed contract emissions to the EXECUTE caller — a fund-custody bug on
-- order/swap/dispenser refunds, token ownership, and cancel/sweep authorization. See
-- src/sql/actions.sql for the canonical definition.
--
-- The indexer reconciles its schema on startup (src/db.js verifyTables/alterTableForDrift)
-- and will auto-add the nullable column. However that reconciliation (a) does NOT add the
-- index, and (b) does NOT backfill existing rows — which would then be NULL and dropped by
-- the INNER JOIN on a1.source_id in getOrderInfo/getSwapInfo/getDispenserInfo/getTokenInfo,
-- breaking lookups for any token/order/dispenser created before this shipped (e.g. the gas
-- token), and on snapshot-bootstrapped replicas the reconciliation does not run at all.
-- Run this once on any database created before source_id shipped.
--
-- Backfill source: transactions.source_id — correct for every user-submitted action (the
-- vast majority). Pre-existing VM-emission actions backfill to their EXECUTE caller, which
-- matches their original (pre-fix) attribution, so this introduces no regression; new
-- emissions are recorded correctly by createActionIndex going forward. System/synthetic
-- actions (no tx, or null tx source) stay NULL.
-- IF NOT EXISTS makes the DDL safe to run on a database that verifyTables already reconciled.

ALTER TABLE actions
  ADD COLUMN IF NOT EXISTS source_id BIGINT UNSIGNED,
  ADD INDEX  IF NOT EXISTS source_id (source_id);

UPDATE actions a
  JOIN transactions t ON t.tx_index = a.tx_index
  SET a.source_id = t.source_id
  WHERE a.source_id IS NULL AND t.source_id IS NOT NULL;
