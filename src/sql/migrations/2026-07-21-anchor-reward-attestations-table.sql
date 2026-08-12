-- xchain:migration mode=auto
-- Migration: create the anchor_reward_attestations table (Option C: derive on the BTC side).
--
-- WHY
-- ---
-- ANCHOR is DOGE-only, but the anchor/archive publisher reward is a COLLECT-spendable
-- validator_rewards row and COLLECT + capability staking are BTC-only, so the DOGE
-- indexer can never resolve the stake source and silently drops the reward. Option C
-- relocates derivation to the BTC indexer: the hub publishes the XANCPUB publisher-
-- attestation quorum to this append-only, hub-mirrored table (HUB_STATE_TABLES), and
-- the BTC indexer re-verifies the sigs against its own oracle_publish set and derives
-- validator_rewards at block_index = snapshot_block. verifyTables auto-creates this on a
-- fresh install; a DB converged by replaying the dated migrations alone (operator-managed
-- or rebuilt replica) never gains it without this migration.
--
-- NOT consensus-visible: the table is pure transport for the quorum; the derived
-- validator_rewards row (not this table) is what COLLECT reads, and validator_rewards is
-- not in the block-hash preimage. Additive + idempotent: CREATE TABLE IF NOT EXISTS
-- re-runs as a no-op and matches src/sql/anchor_reward_attestations.sql under
-- SHOW CREATE TABLE.
--
-- HOW TO RUN
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-07-21-anchor-reward-attestations-table.sql

CREATE TABLE IF NOT EXISTS anchor_reward_attestations (
    id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    chain                  VARCHAR(10)  NOT NULL,
    network                VARCHAR(20)  NOT NULL,
    reward_type            VARCHAR(32)  NOT NULL,
    round_reference        BIGINT UNSIGNED NOT NULL,
    snapshot_block         BIGINT UNSIGNED NOT NULL,
    publisher              VARCHAR(64)  NOT NULL,
    reward_amount          VARCHAR(32)  NOT NULL,
    publisher_attestations TEXT         NOT NULL,
    created_at             TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_reward_tuple (chain, network, reward_type, round_reference, snapshot_block, publisher),
    KEY idx_snapshot_block (network, snapshot_block)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
