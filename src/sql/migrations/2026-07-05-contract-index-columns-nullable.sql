-- xchain:migration mode=auto
-- Migration: allow NULL in the contract-index columns of the five VM/staking
-- detail tables (deposits, withdrawals, contract_executions, contract_stakes,
-- contract_unstakes).
--
-- WHY
-- ---
-- These handlers write their detail row even when the action is invalid, and
-- storage normalization (config NUMBER_FIELDS) nulls a non-numeric wire value
-- (e.g. a broadcast DEPOSIT|0|null|...) for the row write. With NOT NULL on the
-- column that write throws ER_BAD_NULL_ERROR and the block-processing retry
-- loop hard-wedges the indexer: the same liveness hole the junk value itself
-- caused before it was normalized (2026-07-05, LTC-regtest sweep). Valid
-- actions always carry a real integer index, so NULL only ever appears on
-- invalid rows.
--
-- Additive + idempotent: MODIFY COLUMN to the same nullable definition is a
-- no-op on re-run; existing row values are untouched.

ALTER TABLE deposits            MODIFY COLUMN contract_index        BIGINT UNSIGNED;
ALTER TABLE withdrawals         MODIFY COLUMN contract_index        BIGINT UNSIGNED;
ALTER TABLE contract_executions MODIFY COLUMN contract_index        BIGINT UNSIGNED;
ALTER TABLE contract_stakes     MODIFY COLUMN target_contract_index BIGINT UNSIGNED;
ALTER TABLE contract_unstakes   MODIFY COLUMN target_contract_index BIGINT UNSIGNED;
