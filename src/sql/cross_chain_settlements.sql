DROP TABLE IF EXISTS cross_chain_settlements;
CREATE TABLE cross_chain_settlements (
    action_index       BIGINT UNSIGNED NOT NULL, -- internal settlement action_index (rollback-able; minted when the leg is applied)
    match_id           VARCHAR(80)     NOT NULL, -- the cross_chain_matches.match_id this leg settled
    local_action_index BIGINT UNSIGNED NOT NULL, -- the local ORDER/SWAP that was released from escrow
    block_index        BIGINT UNSIGNED NOT NULL, -- block height at which this leg was applied
    -- Both leg references, captured from the signed match at settle time. The mirror row
    -- can be deleted later (reorg retraction), so the VM's crossChain.isSettled snapshot
    -- must read from THIS table (local, reorg-rollback-able) — never from the mirror.
    a_chain            VARCHAR(10)     NULL,     -- canonical-lower leg chain
    a_action_index     BIGINT UNSIGNED NULL,     -- canonical-lower leg ORDER/SWAP action_index
    b_chain            VARCHAR(10)     NULL,     -- counterpart leg chain
    b_action_index     BIGINT UNSIGNED NULL      -- counterpart leg ORDER/SWAP action_index
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- One settlement per match per chain (idempotency: the settlement pass skips a match
-- already present here). Dropped on reorg by action_index so the match re-applies.
CREATE UNIQUE INDEX match_id           ON cross_chain_settlements (match_id);
CREATE        INDEX action_index       ON cross_chain_settlements (action_index);
CREATE        INDEX local_action_index ON cross_chain_settlements (local_action_index);
