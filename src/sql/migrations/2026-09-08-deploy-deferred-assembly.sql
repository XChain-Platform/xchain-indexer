-- xchain:migration mode=auto
-- Migration: deferred assembly of chunked DEPLOY groups (two columns, two indexes).
--
-- WHY
-- ---
-- A chunked DEPLOY is N format-4 carriers plus one assembling DEPLOY, each its own
-- transaction with no on-chain ordering between them. Today the assembler must land
-- after every carrier or it is permanently 'invalid: CODE_HASH (no chunks)'; a reorg
-- can reorder a correctly sequenced group the same way. From DEPLOY_DEFERRED_ASSEMBLY
-- on, an early assembler lands 'pending: CODE_HASH (awaiting chunks)' and the first
-- action that completes the group runs the deployment at its own index.
--
-- contract_executions.assembler_action_index marks the pending assembler a constructor
-- row consumed (NULL for inline and self-completed deploys). It is the consumption
-- predicate: an assembler is consumed iff an execution row names it, and the execution
-- row is written unconditionally and never deleted, so a failed constructor, a hash
-- mismatch and a fee failure all consume it. Indexed for the pending lookup's NOT
-- EXISTS and the explorer's reverse lookup.
--
-- contract_executions.fee_payment_mode records the mode the assembler paid its base
-- fee in (1 native, 2 XCHAIN), read at the completing carrier to decide whether
-- constructor gas is debited there.
--
-- contracts (source_id, code_hash) serves the per-carrier pending-assembler point read;
-- only single-column indexes existed.
--
-- NOT consensus-visible by itself: neither column enters a block-hash preimage
-- (getBlockHashes selects fixed columns), so no pre-activation hash moves. What the
-- columns record is decided by the gated code path, never by the DDL.
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, a
-- no-op on any install whose boot-time reconcile has already healed the definition in
-- from src/sql/contract_executions.sql and src/sql/contracts.sql. Both columns are
-- declared LAST in the definition; the AFTER anchors keep SHOW CREATE TABLE byte-equal
-- between a migrated DB and a fresh install (the column-parity test checks position).
-- Neither column nor index is baselined: they ship through this migration only.
--
-- HOW TO RUN
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-09-08-deploy-deferred-assembly.sql

ALTER TABLE contract_executions
  ADD COLUMN IF NOT EXISTS assembler_action_index BIGINT UNSIGNED  AFTER block_index,
  ADD COLUMN IF NOT EXISTS fee_payment_mode       TINYINT UNSIGNED AFTER assembler_action_index;

CREATE INDEX IF NOT EXISTS assembler_action_index ON contract_executions (assembler_action_index);
CREATE INDEX IF NOT EXISTS source_code_hash       ON contracts (source_id, code_hash);
