-- xchain:migration mode=auto
-- Migration: secondary index `block_index` on index_addresses and index_tickers.
--
-- WHY
-- ---
-- The block_index column (added by 2026-06-19-index-tables-add-block-index.sql) is
-- filtered by block, not just read by id, in three hot paths: rollback.js deletes per
-- orphaned block (DELETE FROM index_<table> WHERE block_index >= ?), the advisory
-- index-map parity checksum selects WHERE block_index IS NOT NULL AND block_index <= ?,
-- and the P4 state_hash class hashes the rows first assigned at a block
-- (WHERE block_index = ?). Without a secondary index each of those is a full table scan.
--
-- The 2026-06-19 migration added the COLUMN but no index. index_addresses received a
-- block_index index out of band, but index_tickers did not, so the ticker path is
-- unindexed fleet-wide. This adds both in the migration runner's own directory so a
-- freshly reindexed DB gets them deterministically (the addresses ALTER is a no-op where
-- the index already exists).
--
-- Idempotent (ADD INDEX IF NOT EXISTS) and additive; the InnoDB secondary-index build is
-- online (INPLACE) and does not block DML. It still runs synchronously at startup before
-- indexing resumes, so on a large already-populated table it takes time; it is effectively
-- instant on a freshly reindexed DB (the pre-launch standard). Snapshot-bootstrapped sync
-- replicas do not run this runner, so existing replica indexer DBs need it applied
-- separately (a fresh bootstrap inherits it from the source's SHOW CREATE TABLE).

ALTER TABLE index_addresses ADD INDEX IF NOT EXISTS block_index (block_index);
ALTER TABLE index_tickers   ADD INDEX IF NOT EXISTS block_index (block_index);
