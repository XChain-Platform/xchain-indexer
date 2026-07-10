CREATE TABLE price_snapshots (
    id                  BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    round_number        BIGINT NOT NULL,
    coin_pair           VARCHAR(20) NOT NULL,
    price               VARCHAR(40),
    reference_block     BIGINT NOT NULL DEFAULT 0,
    reference_chain     VARCHAR(10) NOT NULL DEFAULT 'BTC',
    block_timestamp     BIGINT NOT NULL DEFAULT 0,
    validator_count     INT NOT NULL,
    consensus_round     INT DEFAULT 1,
    consensus_proof     TEXT NOT NULL,
    status              ENUM('finalized','skipped','disputed') NOT NULL,
    source_chain        VARCHAR(10) NOT NULL DEFAULT 'DOGE',  -- which chain carried the PRICE v0 tx; mirrored from the hub so a reorg row:deleted (keyed on source_chain + source_action_index) can be applied to this copy. See xchain-hub/src/sql/price_snapshots.sql.
    source_action_index BIGINT,                                -- action_index of the PRICE tx on source_chain (NULL for hub-finalized); the reorg-retraction key (RETRACTION_COLUMNS.price_snapshots in hub_db_sync.js).
    push_generation     BIGINT NOT NULL DEFAULT 0,     -- source-chain reorg fence (item 5308); mirrored from the hub. See xchain-hub/src/sql/price_snapshots.sql.
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY idx_round_pair (round_number, coin_pair),
    KEY idx_pair_block (coin_pair, reference_block),
    KEY idx_pair_timestamp (coin_pair, block_timestamp),
    KEY idx_status (status),
    KEY idx_source_chain (source_chain),
    -- Oracle snapshot preload: WHERE status + reference_block range, ORDER BY round_number DESC.
    KEY idx_status_block_round (status, reference_block, round_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
