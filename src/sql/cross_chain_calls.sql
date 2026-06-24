CREATE TABLE cross_chain_calls (
    id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, -- mirror cursor (per-hub id; provenance only, not the injection order, which is (snapshot_block, call_id))
    call_id               VARCHAR(80)  NOT NULL,                   -- deterministic id derived in the source-chain VM run
    phase                 VARCHAR(10)  NOT NULL,                   -- 'dispatch' | 'result'
    snapshot_block        BIGINT UNSIGNED NOT NULL,                -- BTC-anchored block; selects the cross_chain validator set for sig verification
    network               VARCHAR(20)  NOT NULL,                   -- mainnet/testnet/regtest; signed into the canonical
    source_chain          VARCHAR(10)  NOT NULL,
    source_action_index   BIGINT UNSIGNED NOT NULL,                -- the XCALL v0 request row on the source chain (retraction key)
    source_contract_index BIGINT UNSIGNED NOT NULL,
    target_chain          VARCHAR(10)  NOT NULL,
    target_contract_index BIGINT NOT NULL,
    method                VARCHAR(64)  NOT NULL,
    params_json           TEXT         NOT NULL,                   -- JSON array of string params (sha256'd into the canonical)
    gas_limit             BIGINT NOT NULL,                         -- caller-funded target-side gas ceiling
    cross_hops            INT          NOT NULL DEFAULT 0,         -- X→Y→X ping-pong bound (signed into the canonical)
    effective_time        BIGINT NOT NULL,                         -- apply at first block_time >= this (dispatch: target chain; result: source chain)
    finalizing_view       INT          NOT NULL DEFAULT 0,         -- PBFT view the round finalized at; signed into the EQUIV canonical (WI-2 bump 2) so the indexer rebuilds the exact view
    status                VARCHAR(20)  NOT NULL DEFAULT 'finalized',-- row lifecycle: finalized / retracted
    result_status         VARCHAR(20),                             -- result phase only: ok|reverted|out_of_gas|no_contract|not_callable|payload_too_large|error
    return_payload_b64    TEXT,                                    -- result phase only (sha256'd into the canonical)
    validator_signatures  TEXT         NOT NULL,                   -- JSON [{pubkey, sig}], 2f+1 Ed25519 over the phase canonical
    push_generation       BIGINT       NOT NULL DEFAULT 0,         -- source-chain reorg fence (item 5308); mirrored from the hub
    created_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX call_phase     ON cross_chain_calls (call_id, phase);
CREATE        INDEX source_ref     ON cross_chain_calls (source_chain, source_action_index);
CREATE        INDEX target_ref     ON cross_chain_calls (target_chain, phase, status, effective_time);
CREATE        INDEX effective_time ON cross_chain_calls (effective_time);
