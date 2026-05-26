DROP TABLE IF EXISTS slash_events;
CREATE TABLE slash_events (
    id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    execution_index        BIGINT UNSIGNED NOT NULL,        -- FK to contract_executions.action_index (the EXECUTE that triggered the slash)
    target_contract_index  BIGINT UNSIGNED NOT NULL,        -- FK to contracts.action_index
    signing_pubkey_id      BIGINT UNSIGNED NOT NULL,        -- FK to index_pubkeys (the staker that was slashed)
    tick_id                BIGINT UNSIGNED NOT NULL,        -- FK to index_tickers (which token)
    amount                 VARCHAR(250) NOT NULL,           -- Amount slashed (may be less than requested if available balance is lower)
    destination_id         BIGINT UNSIGNED NOT NULL,        -- FK to index_addresses (where slashed funds were routed; BURN sentinel resolved at DEPLOY time)
    block_index            BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX execution_index       ON slash_events (execution_index);
CREATE INDEX target_contract_index ON slash_events (target_contract_index);
CREATE INDEX signing_pubkey_id     ON slash_events (signing_pubkey_id);
CREATE INDEX tick_id               ON slash_events (tick_id);
CREATE INDEX destination_id        ON slash_events (destination_id);
CREATE INDEX block_index           ON slash_events (block_index);
