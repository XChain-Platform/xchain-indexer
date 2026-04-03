DROP TABLE IF EXISTS contract_state;
CREATE TABLE contract_state (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    contract_index      BIGINT UNSIGNED NOT NULL,
    state_key           VARCHAR(256) NOT NULL,
    state_value         MEDIUMTEXT,
    block_index         BIGINT UNSIGNED NOT NULL,
    action_index        BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- Read current: SELECT ... WHERE contract_index=? AND state_key=? ORDER BY id DESC LIMIT 1
-- Rollback:     DELETE FROM contract_state WHERE block_index >= ?
CREATE INDEX idx_latest ON contract_state (contract_index, state_key, id DESC);
CREATE INDEX idx_block  ON contract_state (block_index);
