DROP TABLE IF EXISTS contract_delegations;
CREATE TABLE contract_delegations (
    action_index           BIGINT UNSIGNED NOT NULL,
    source_id              BIGINT UNSIGNED NOT NULL,        -- staking address
    signing_pubkey_id      BIGINT UNSIGNED NOT NULL,        -- FK to index_pubkeys (the NEW pubkey)
    target_contract_index  BIGINT UNSIGNED NOT NULL,        -- FK to contracts.action_index
    tick_id                BIGINT UNSIGNED,                 -- FK to index_tickers (which contract-stake context); NULL on invalid actions with an unresolvable TICK
    status_id              BIGINT UNSIGNED,                 -- active/revoked
    block_index            BIGINT UNSIGNED NOT NULL,
    activation_block       BIGINT UNSIGNED NOT NULL DEFAULT 0,  -- block when delegation becomes active
    deactivation_block     BIGINT UNSIGNED                       -- block when delegation becomes inactive
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index          ON contract_delegations (action_index);
CREATE        INDEX source_id             ON contract_delegations (source_id);
CREATE        INDEX signing_pubkey_id     ON contract_delegations (signing_pubkey_id);
CREATE        INDEX target_contract_index ON contract_delegations (target_contract_index);
CREATE        INDEX tick_id               ON contract_delegations (tick_id);
CREATE        INDEX status_id             ON contract_delegations (status_id);
CREATE        INDEX activation_block      ON contract_delegations (activation_block);
CREATE        INDEX deactivation_block    ON contract_delegations (deactivation_block);
