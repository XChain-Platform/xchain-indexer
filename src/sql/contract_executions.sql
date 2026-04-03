DROP TABLE IF EXISTS contract_executions;
CREATE TABLE contract_executions (
    action_index        BIGINT UNSIGNED NOT NULL,
    contract_index      BIGINT UNSIGNED NOT NULL,
    caller_id           BIGINT UNSIGNED NOT NULL,
    method_name         VARCHAR(250),
    input_params        TEXT,
    gas_used            BIGINT UNSIGNED NOT NULL,
    gas_limit           BIGINT UNSIGNED NOT NULL,
    status_id           BIGINT UNSIGNED NOT NULL,
    error_message       TEXT,
    emitted_count       INT UNSIGNED NOT NULL DEFAULT 0,
    block_index         BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON contract_executions (action_index);
CREATE        INDEX contract_index ON contract_executions (contract_index);
CREATE        INDEX caller_id      ON contract_executions (caller_id);
CREATE        INDEX block_index    ON contract_executions (block_index);
