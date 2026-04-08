DROP TABLE IF EXISTS stakes;
CREATE TABLE stakes (
    action_index        BIGINT UNSIGNED NOT NULL,
    source_id           BIGINT UNSIGNED NOT NULL,       -- FK to index_addresses (staking address)
    tier                TINYINT UNSIGNED NOT NULL,       -- 1=oracle, 2=cross-chain, 3=oracle publisher
    chains              VARCHAR(50),                     -- e.g. 'BTC,DOGE' (Tier 2 only)
    signing_pubkey_id   BIGINT UNSIGNED NOT NULL,        -- FK to index_pubkeys (Ed25519 hot key)
    doge_address        VARCHAR(50),                     -- DOGE broadcast address (Tier 3 only)
    amount              VARCHAR(250) NOT NULL,           -- XCHAIN staked
    status_id           BIGINT UNSIGNED,                 -- active/cooldown/suspended
    block_index         BIGINT UNSIGNED NOT NULL,
    activation_block    BIGINT UNSIGNED NOT NULL DEFAULT 0,  -- block when stake becomes active (block_index + ACTIVATION_DELAY_BLOCKS)
    deactivation_block  BIGINT UNSIGNED                       -- block when stake becomes inactive (set on UNSTAKE)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index       ON stakes (action_index);
CREATE        INDEX source_id          ON stakes (source_id);
CREATE        INDEX signing_pubkey_id  ON stakes (signing_pubkey_id);
CREATE        INDEX status_id          ON stakes (status_id);
CREATE        INDEX activation_block   ON stakes (activation_block);
CREATE        INDEX deactivation_block ON stakes (deactivation_block);
