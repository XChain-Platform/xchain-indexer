DROP TABLE IF EXISTS withdrawals;
CREATE TABLE withdrawals (
    action_index        BIGINT UNSIGNED NOT NULL,
    contract_index      BIGINT UNSIGNED,                -- NULL when the action is invalid with a non-numeric wire value (storage normalization)
    source_id           BIGINT UNSIGNED NOT NULL,
    tick_id             BIGINT UNSIGNED,                -- NULL when the action is invalid with an unresolvable TICK (e.g. a ^<id> ref to a non-existent tick); storage normalization, never on a valid row
    amount              VARCHAR(250) NOT NULL,
    status_id           BIGINT UNSIGNED,
    block_index         BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON withdrawals (action_index);
CREATE        INDEX contract_index ON withdrawals (contract_index);
CREATE        INDEX source_id      ON withdrawals (source_id);
