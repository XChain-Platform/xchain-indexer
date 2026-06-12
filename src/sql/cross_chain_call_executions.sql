DROP TABLE IF EXISTS cross_chain_call_executions;
CREATE TABLE cross_chain_call_executions (
    action_index       BIGINT UNSIGNED NOT NULL, -- internal XEXEC action_index (rollback-able; minted when the call is injected)
    call_id            VARCHAR(80)     NOT NULL, -- the cross_chain_calls dispatch this execution applied
    execute_action_index BIGINT UNSIGNED,        -- the injected EXECUTE's action_index (the actual contract run)
    result_status      VARCHAR(20)     NOT NULL, -- ok|reverted|out_of_gas|no_contract|not_callable|payload_too_large|error
    return_payload_b64 TEXT,                     -- base64 return payload (capped; empty on failure)
    gas_used           BIGINT UNSIGNED NOT NULL DEFAULT 0,
    block_index        BIGINT UNSIGNED NOT NULL  -- block height at which this call was injected
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- One execution per call on this chain (idempotency: the injection pass skips a
-- call already present here). Dropped on reorg by action_index so the call re-applies.
CREATE UNIQUE INDEX call_id      ON cross_chain_call_executions (call_id);
CREATE        INDEX action_index ON cross_chain_call_executions (action_index);
CREATE        INDEX block_index  ON cross_chain_call_executions (block_index);
