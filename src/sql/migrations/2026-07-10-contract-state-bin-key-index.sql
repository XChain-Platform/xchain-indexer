-- xchain:migration mode=manual
-- Migration: add the binary-collation state_key shadow column + reload index.
--
-- At/after the state_key_collation flag-day (state_key_collation_activation.js)
-- db.getContractState() groups the full-history VM reload with binary key
-- semantics. `GROUP BY state_key COLLATE utf8_bin` cannot use the
-- utf8_general_ci idx_latest loose-index-scan and degrades to a full range
-- read + filesort per EXECUTE on hot contracts. `state_key_bin` is state_key
-- under utf8_bin (VIRTUAL, zero storage for the column itself), and
-- idx_latest_bin restores the loose-index-scan for the armed reload.
-- `GROUP BY state_key_bin` returns a row set byte-identical to
-- `GROUP BY state_key COLLATE utf8_bin`, so consensus/reload results are
-- unchanged; this is throughput-only.
--
-- NOTE: the startup drift reconciler (verifyTables -> alterTableForDrift /
-- reconcileTableIndexes) already auto-adds this column+index from the updated
-- contract_state.sql on any node running the new code, so both clauses are
-- IF NOT EXISTS: this file exists to LEDGER the change and to cover DBs that
-- are not started through the indexer (operator-managed / rebuilt replicas).
-- Apply fleet-wide BEFORE the armed heights (BTC 962500 / LTC 3160000 /
-- DOGE 6335000; testnets late July). If a node reaches the height without
-- it, the reload runs the filesort (correct, only slow).
--
-- HOW TO RUN (manual path)
--   node src/migrate.js   (inside the indexer container / service env)

ALTER TABLE contract_state
  ADD COLUMN IF NOT EXISTS state_key_bin VARCHAR(256) CHARACTER SET utf8 COLLATE utf8_bin
    GENERATED ALWAYS AS (state_key) VIRTUAL,
  ADD INDEX IF NOT EXISTS idx_latest_bin (contract_index, state_key_bin, id DESC);
