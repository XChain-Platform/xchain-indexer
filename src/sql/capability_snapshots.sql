CREATE TABLE capability_snapshots (
    id             BIGINT AUTO_INCREMENT PRIMARY KEY,        -- mirror cursor (matches hub id)
    snapshot_block BIGINT NOT NULL,                          -- BTC-anchored block boundary
    capability     VARCHAR(20)  NOT NULL,                    -- e.g. 'cross_chain'
    signing_pubkey VARCHAR(64)  NOT NULL,                    -- Ed25519 validator pubkey (64 hex)
    amount         VARCHAR(250) NOT NULL,                    -- aggregate active stake (informational)
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Presence of a row = that pubkey QUALIFIED for `capability` at `snapshot_block`
    -- (the hub only mirrors pubkeys already filtered by min_stake). Lets a non-BTC
    -- indexer verify cross-chain match signatures without local capability stakes.
    UNIQUE KEY uq_cap_snap (snapshot_block, capability, signing_pubkey),
    KEY idx_cap_block (capability, snapshot_block)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
