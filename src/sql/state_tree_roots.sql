CREATE TABLE state_tree_roots (
    id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    chain             VARCHAR(10)  NOT NULL,               -- BTC/LTC/DOGE (constant per indexer instance)
    network           VARCHAR(20)  NOT NULL,               -- mainnet/testnet/regtest
    block_index       BIGINT UNSIGNED NOT NULL,            -- the block these roots commit
    balances_root     CHAR(64) NOT NULL,                   -- SMT over balance + escrow leaves
    stakes_root       CHAR(64) NOT NULL,                   -- BTC-only; EMPTY_SMT_ROOT on LTC/DOGE
    state_root        CHAR(64) NOT NULL,                   -- fixedMerkleRoot([balances, stakes, EMPTY,EMPTY,EMPTY])
    block_merkle_root CHAR(64) NOT NULL,                   -- per-block content root (SPV spec §5)
    computed_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_chain_net_block (chain, network, block_index)
    -- Per-block light-client commitments (SPV spec §4/§5), written atomically with
    -- the block. Reorg deletes rows >= the orphan height inside the rollback txn;
    -- the surviving tip row is the fork-point root the new chain builds forward on.
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX idx_chain_net_block ON state_tree_roots (chain, network, block_index);
