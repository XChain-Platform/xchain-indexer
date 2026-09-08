-- xchain:migration mode=auto
-- Migration: ROLLCALL v1 gates (one new table, one new column).
--
-- WHY
-- ---
-- ROLLCALL v1 carries a GATES field: the consensus-gate keys the publisher's
-- build knows, re-signed by every present validator. The DOGE-side first-seen
-- index keeps that string beside each signature (rollcall_signers.gates) so the
-- BTC-side epoch close can rebuild the v1 canonical, which appends sha256(GATES),
-- and re-verify the signature. The close then records each verified signer's
-- list on the BTC side (rollcall_gates), where the attestation capability set is
-- derived and where rollcall_signers is otherwise empty.
--
-- rollcall_signers.gates is NULL for every v0 row, which is every row written
-- before ROLLCALL_GATES_ACTIVATION. Declared LAST in the definition with an
-- AFTER anchor so SHOW CREATE TABLE stays byte-equal between a migrated DB and a
-- fresh install.
--
-- NOT consensus-visible by itself: neither object enters a block-hash preimage.
-- What the rows record is decided by the gated code path, never by the DDL.
--
-- Additive + idempotent: CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, a
-- no-op on any install whose boot-time reconcile has already healed the
-- definitions in from src/sql/rollcall_gates.sql and src/sql/rollcall_signers.sql.
--
-- HOW TO RUN
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-09-07-rollcall-gates.sql

CREATE TABLE IF NOT EXISTS rollcall_gates (
    epoch_height  BIGINT UNSIGNED NOT NULL,
    pubkey        CHAR(64)        NOT NULL,
    close_block   BIGINT UNSIGNED NOT NULL,
    gates_json    LONGTEXT        NOT NULL,
    PRIMARY KEY (epoch_height, pubkey),
    KEY idx_rollcall_gates_close (close_block)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

ALTER TABLE rollcall_signers
    ADD COLUMN IF NOT EXISTS gates TEXT DEFAULT NULL AFTER block_index;
