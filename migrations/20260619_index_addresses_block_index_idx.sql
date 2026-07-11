-- Migration: index_addresses.block_index secondary index
--
-- SUPERSEDED: do NOT hand-run this. The equivalent statement now ships as the
-- runner-tracked, ledger-recorded migration
-- src/sql/migrations/2026-06-21-index-tables-block-index-secondary-idx.sql
-- (mode=auto, applied at boot). This legacy copy is inert (runMigrations never
-- reads this directory) and is retained only for history. Its header note about
-- schema reconciliation adding columns but not indexes is also stale: verifyTables
-- has since gained reconcileTableIndexes (src/db.js).
--
-- Adds a secondary index on index_addresses(block_index). It supports the advisory
-- index-map parity checksum (xchain-sync BlockHasher.computeIndexMapChecksum), which
-- selects the deterministic subset `WHERE block_index IS NOT NULL AND block_index <= ?`
-- and is computed once per /status poll on the server and once per parity check on the
-- client. Without the index that predicate is a full table scan of index_addresses,
-- which is why INDEX_MAP_PARITY_CHECK ships default-off; run this before enabling it on
-- any high-volume chain. The same predicate shape is used by rollback's per-block delete,
-- so the index helps reorg handling too.
--
-- The indexer's schema reconciliation (src/db.js verifyTables/alterTableForDrift) adds
-- missing columns but NOT indexes, and snapshot-bootstrapped sync replicas do not run it
-- at all (they mirror the source's SHOW CREATE TABLE, so a freshly bootstrapped replica
-- inherits this index once the source carries it). Run this once on any indexer DB, and
-- on any existing sync replica DB, created before this shipped. Purely additive: no data
-- change, safe to re-run.
-- IF NOT EXISTS makes the DDL idempotent on a DB that already has the index.

ALTER TABLE index_addresses
  ADD INDEX IF NOT EXISTS block_index (block_index);
