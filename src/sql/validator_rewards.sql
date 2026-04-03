DROP TABLE IF EXISTS validator_rewards;
CREATE TABLE validator_rewards (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    source_id           BIGINT UNSIGNED NOT NULL,        -- staking address
    signing_pubkey_id   BIGINT UNSIGNED NOT NULL,        -- FK to index_pubkeys
    reward_type         VARCHAR(20) NOT NULL,             -- 'oracle_round', 'cross_chain_attestation'
    round_reference     BIGINT UNSIGNED,                  -- round number or attestation ref
    amount              VARCHAR(250) NOT NULL,
    block_index         BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX reward_unique     ON validator_rewards (source_id, signing_pubkey_id, reward_type, round_reference);
CREATE        INDEX source_id         ON validator_rewards (source_id);
CREATE        INDEX signing_pubkey_id ON validator_rewards (signing_pubkey_id);
