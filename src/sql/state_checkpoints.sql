CREATE TABLE state_checkpoints (
    id                   BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,        -- mirror cursor (matches hub id)
    chain                VARCHAR(10)  NOT NULL,                    -- checkpointed chain: BTC/LTC/DOGE
    network              VARCHAR(20)  NOT NULL,                    -- mainnet/testnet/regtest
    block_index          BIGINT UNSIGNED NOT NULL,                 -- checkpointed height on `chain`
    block_hash           VARCHAR(64)  NOT NULL,                    -- chain block hash at block_index
    ledger_hash          VARCHAR(64)  NOT NULL,                    -- indexer blocks.ledger_hash (chained)
    actions_hash         VARCHAR(64)  NOT NULL,                    -- indexer blocks.actions_hash (chained)
    contract_hash        VARCHAR(64)  NOT NULL,                    -- indexer blocks.contract_hash (chained)
    checkpoint_seq       BIGINT UNSIGNED NOT NULL,                 -- monotonic per (chain, network)
    snapshot_block       BIGINT UNSIGNED NOT NULL,                 -- BTC block selecting the oracle_publish set
    validator_signatures TEXT         NOT NULL,                    -- JSON [{pubkey,sig}] — 2f+1 over the XCHECKPOINT canonical
    created_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Hub-mirrored (hub_db_sync), like capability_snapshots: INSERT-IGNORE apply,
    -- never retracted. Append-only: a reorged height is superseded by a NEW row
    -- with a higher checkpoint_seq (readers take MAX(checkpoint_seq) per height).
    -- The hub-side anchor_txid audit column is NOT mirrored.
    UNIQUE KEY uq_chain_block_seq (chain, network, block_index, checkpoint_seq),
    KEY idx_checkpoint_seq (chain, network, checkpoint_seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
