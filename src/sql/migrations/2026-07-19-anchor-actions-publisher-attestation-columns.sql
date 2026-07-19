-- xchain:migration mode=auto
-- Migration: ledger the anchor_actions v4/v5/v6 publisher-attestation columns.
--
-- WHY
-- ---
-- anchor.js parses and quorum-verifies the v4/v5/v6 publisher-attestation tail
-- (the elected PUBLISHER pubkey + a SECOND 2f+1 oracle_publish XANCPUB attestation),
-- but createAnchorAction never persisted it, so a full-chain parse could not recover
-- the anchor-reward re-derivation inputs. anchor_actions.sql now declares two nullable
-- columns for it:
--   publisher              VARCHAR(64)  -- elected PUBLISHER pubkey (v4/v5/v6), NULL for v0-v3
--   publisher_attestations MEDIUMTEXT   -- JSON [{pubkey,sig}] XANCPUB tail, NULL for v0-v3
-- Same definition-without-ledger class as the sibling reorg-fence / payout-legs
-- migrations: a DB converged by replaying the dated migrations alone (operator-managed
-- or rebuilt replica) never gains the columns, so the publisher tail silently fails to
-- persist there.
--
-- NOT consensus-visible: anchor_actions is a derived local table, not part of the
-- block-hash preimage. Additive + idempotent: ADD COLUMN IF NOT EXISTS re-runs as a
-- no-op; anchor after validator_signatures matches anchor_actions.sql so a migrated
-- table and a freshly created one agree under SHOW CREATE TABLE.
--
-- HOW TO RUN
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-07-19-anchor-actions-publisher-attestation-columns.sql

ALTER TABLE anchor_actions
  ADD COLUMN IF NOT EXISTS publisher              VARCHAR(64) AFTER validator_signatures,
  ADD COLUMN IF NOT EXISTS publisher_attestations MEDIUMTEXT  AFTER publisher;
