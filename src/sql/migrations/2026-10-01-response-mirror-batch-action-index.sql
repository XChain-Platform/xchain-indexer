-- xchain:migration mode=auto
-- Migration: attestation_responses.batch_action_index.
--
-- WHY
-- ---
-- The column was added in place to 2026-09-03-attestation-responses.sql after databases
-- had applied that file, so a database that ran an earlier revision of it only gains the
-- column when the boot-time drift reconciler runs. A replica converged from migrations
-- alone (migrate.js, never verifyTables) never does, and the mirror's consensus read of
-- attestation_responses selects the column. This file is that database's convergence.
-- The same file's uq_attest_response widen converges through
-- 2026-09-06-attestation-responses-identity-effective-time.sql.
--
-- Purely additive and nullable, guarded by IF NOT EXISTS, so it is a no-op on a fresh
-- database and on any node whose reconciler already added the column. Position matches
-- src/sql/attestation_responses.sql: between widen and finalized_at.

ALTER TABLE attestation_responses
  ADD COLUMN IF NOT EXISTS batch_action_index BIGINT UNSIGNED DEFAULT NULL AFTER widen;
