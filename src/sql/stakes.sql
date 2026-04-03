DROP TABLE IF EXISTS stakes;
CREATE TABLE stakes (
    action_index        BIGINT UNSIGNED NOT NULL,
    source_id           BIGINT UNSIGNED NOT NULL,       -- FK to index_addresses (staking address)
    tier                TINYINT UNSIGNED NOT NULL,       -- 1=oracle, 2=cross-chain
    chains              VARCHAR(50),                     -- e.g. 'BTC,DOGE' (Tier 2 only)
    signing_pubkey_id   BIGINT UNSIGNED NOT NULL,        -- FK to index_pubkeys (Ed25519 hot key)
    amount              VARCHAR(250) NOT NULL,           -- XCHAIN staked
    status_id           BIGINT UNSIGNED,                 -- active/cooldown/suspended
    block_index         BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON stakes (action_index);
CREATE        INDEX source_id         ON stakes (source_id);
CREATE        INDEX signing_pubkey_id ON stakes (signing_pubkey_id);
CREATE        INDEX status_id         ON stakes (status_id);
