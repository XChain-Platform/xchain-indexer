-- xchain:migration mode=auto
-- Migration: contract meta manifest columns on `contracts`, plus the meta search index.
--
-- WHY
-- ---
-- A deployed contract was known only by its derived address (C:<CHAIN>:<action_index>):
-- the row carried code, code hash, status and the staking fields and nothing a person can
-- read. Under CONTRACT_META_REQUIRED a contract exports its own identity (meta.name,
-- meta.description, optional meta.version), the deploy path reads it off the permissions
-- manifest the isolate already returns, and these four columns are where it lands.
--
-- meta_json holds the isolate's serialized meta byte for byte. Re-deriving it from `code`
-- needs an isolate the explorer does not run on its hot path, and holding it is what lets
-- a later display field appear without a reindex.
--
-- The widths are CHARACTERS and the consensus rule caps BYTES (64 / 512 / 32), so a
-- conforming value can never overflow its column. createContract writes the four only for
-- a valid deploy whose meta conforms and NULL otherwise, so a rejected 10 KB name never
-- reaches VARCHAR(64): on a node with a strict sql_mode that would be errno 1406, a
-- forever-retried block, and on a permissive one a silent truncation.
--
-- meta_search is the schema's first FULLTEXT index. The explorer's contract search matches
-- a WORD of the name or description, which a B-tree cannot serve (the house search is
-- LIKE '%term%'), and InnoDB's default innodb_ft_min_token_size of 3 equals the explorer's
-- own minimum search-term length, so the two agree on what is findable.
--
-- NOT consensus-visible: none of the four columns enters a block-hash preimage (the
-- contracts leg of contract_hash is a fixed four-column SELECT of action_index,
-- source_address, code_hash and status), so no pre-activation hash moves. What is stored
-- is decided by the gated deploy path, never by this DDL.
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS / ADD FULLTEXT INDEX IF NOT EXISTS, a
-- no-op on any install whose boot-time reconcile already healed the definition in from
-- src/sql/contracts.sql. The columns are declared LAST there; the AFTER anchors keep
-- SHOW CREATE TABLE byte-equal between a migrated DB and a fresh install (the
-- column-parity test checks position). Nothing here is baselined: the columns and the
-- index ship through this migration only.
--
-- HOW TO RUN
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-09-08-contract-meta-columns.sql

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS meta_name        VARCHAR(64)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL AFTER slash_destination_id,
  ADD COLUMN IF NOT EXISTS meta_description VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL AFTER meta_name,
  ADD COLUMN IF NOT EXISTS meta_version     VARCHAR(32)  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL AFTER meta_description,
  ADD COLUMN IF NOT EXISTS meta_json        TEXT         CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL AFTER meta_version;

ALTER TABLE contracts ADD FULLTEXT INDEX IF NOT EXISTS meta_search (meta_name, meta_description);
