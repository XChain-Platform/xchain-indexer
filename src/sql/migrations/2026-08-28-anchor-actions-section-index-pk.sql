-- xchain:migration mode=auto
-- Migration: anchor_actions.section_index + PRIMARY KEY (action_index, section_index).
--
-- WHY
-- ---
-- ANCHOR v7 bundles every checkpointed chain into ONE anchor per network per cycle, so
-- one action_index now carries N per-chain sections instead of exactly one checkpoint.
-- The table stores one ROW per section (each with its own chain, block_index,
-- checkpoint_seq, roots and signature list, plus the bundle's network, publisher and
-- publisher_attestations denormalized onto every row), which is what keeps
-- idx_anchor_checkpoint and every existing per-chain reader working with no query change.
-- Neither the old PRIMARY KEY (action_index) nor the old upsert on action_index alone can
-- hold that shape: the second section of a bundle would collide with the first.
--
-- OLD-CODE COMPATIBLE
-- -------------------
-- The column is NOT NULL with DEFAULT 0, so an old writer's INSERT (which names no
-- section_index) still lands, on section 0, exactly where its single-body row belongs.
-- Every pre-v7 row is a single body (v1 archive head, v2 continuation chunk, v6 archive
-- anchor, and the retired v0/v3/v4/v5 rows), so backfilling every existing row to 0 is
-- correct by construction and the widened key is a strict superset of the old one: no
-- row that was unique before can become ambiguous now.
--
-- The key WIDENS rather than tightens, which is the safe direction: DROP PRIMARY KEY +
-- ADD PRIMARY KEY over an already-unique action_index cannot fail on duplicates and
-- cannot reject a row the old key admitted. That is also why mode=auto is right here:
-- _destructiveAutoStatement admits DROP PRIMARY (structural, no row data lost) alongside
-- DROP INDEX/KEY, and nothing in this file can lose, truncate or rename data.
--
-- IDEMPOTENT, AND WHY THE PK SWAP IS UNGUARDED
-- --------------------------------------------
-- ADD COLUMN IF NOT EXISTS is a no-op on a fresh install (src/sql/anchor_actions.sql
-- already declares the column and the composite key). The PK swap needs no
-- information_schema guard: the table always has a PRIMARY KEY, so DROP PRIMARY KEY
-- always has a target, and re-adding the SAME composite key it just dropped is a no-op
-- either way. Do not "harden" this into the SET @sql / PREPARE / EXECUTE form the
-- state_checkpoints fence uses: _destructiveAutoStatement (src/db.js) treats dynamic SQL
-- as non-auto-eligible on sight, because a prefix classifier cannot see what a prepared
-- string does, and the file would have to be re-tagged mode=manual.
--
-- AFTER action_index matches the definition's column position, so both schema-construction
-- paths produce a byte-identical SHOW CREATE TABLE (pinned by
-- test/unit/sql-schema-column-parity.test.js).
--
-- HOW TO RUN
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-08-28-anchor-actions-section-index-pk.sql

ALTER TABLE anchor_actions
  ADD COLUMN IF NOT EXISTS section_index TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER action_index;

-- Swap PRIMARY KEY (action_index) for PRIMARY KEY (action_index, section_index). One
-- statement, so the table is never momentarily keyless.
ALTER TABLE anchor_actions
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (action_index, section_index);
