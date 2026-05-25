DROP TABLE IF EXISTS attestation_validator_signatures;
CREATE TABLE attestation_validator_signatures (
    id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    response_action_index   BIGINT UNSIGNED NOT NULL,        -- joins to attestation_responses.action_index
    validator_pubkey        CHAR(64) NOT NULL,               -- 64-hex Ed25519 pubkey of the signer
    signature               CHAR(128) NOT NULL,              -- 128-hex Ed25519 signature
    block_index             BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX response_action_index ON attestation_validator_signatures (response_action_index);
CREATE        INDEX validator_pubkey      ON attestation_validator_signatures (validator_pubkey);
CREATE        INDEX block_index           ON attestation_validator_signatures (block_index);
