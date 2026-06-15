CREATE TABLE cross_chain_matches (
    id                   BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,       -- mirror cursor (matches hub id)
    match_id             VARCHAR(80)  NOT NULL,                   -- deterministic hash of both order refs + snapshot_block
    snapshot_block       BIGINT NOT NULL,                         -- BTC-anchored block; selects the cross_chain validator set
    network              VARCHAR(20)  NOT NULL,                    -- mainnet/testnet/regtest; signed into the canonical so a match can never settle off-network
    a_chain              VARCHAR(10)  NOT NULL,                    -- canonical-lower side; payout addr = A's receive addr on B's chain
    a_action_index       BIGINT NOT NULL,
    a_kind               VARCHAR(10)  NOT NULL DEFAULT 'swap',     -- 'swap' (full, single-fill) | 'order' (partial-fillable)
    a_tick               VARCHAR(255),
    a_amount             VARCHAR(250) NOT NULL,                    -- FILL amount settled in THIS match (== full offer for a swap)
    a_filled_before      VARCHAR(250) NOT NULL DEFAULT '0',       -- A's cumulative committed fill BEFORE this match
    a_ownership          TINYINT(1)   NOT NULL DEFAULT 0,
    a_payout_addr        VARCHAR(255) NOT NULL,
    b_chain              VARCHAR(10)  NOT NULL,
    b_action_index       BIGINT NOT NULL,
    b_kind               VARCHAR(10)  NOT NULL DEFAULT 'swap',
    b_tick               VARCHAR(255),
    b_amount             VARCHAR(250) NOT NULL,                    -- FILL amount settled in THIS match
    b_filled_before      VARCHAR(250) NOT NULL DEFAULT '0',
    b_ownership          TINYINT(1)   NOT NULL DEFAULT 0,
    b_payout_addr        VARCHAR(255) NOT NULL,
    effective_time       BIGINT NOT NULL,                         -- wall-clock instant the indexer applies at (shared clock)
    finalizing_view      INT          NOT NULL DEFAULT 0,         -- PBFT view the round finalized at; signed into the EQUIV canonical (WI-2 bump 2) so the indexer rebuilds the exact view
    validator_signatures TEXT         NOT NULL,                   -- JSON [{pubkey,sig}] — 2f+1 over the canonical match
    status               VARCHAR(20)  NOT NULL DEFAULT 'finalized',
    batch_root           VARCHAR(64),
    anchor_txid          VARCHAR(64),
    created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_match_id (match_id),
    KEY idx_effective (effective_time),
    KEY idx_a_ref (a_chain, a_action_index),
    KEY idx_b_ref (b_chain, b_action_index),
    KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
