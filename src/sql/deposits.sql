DROP TABLE IF EXISTS deposits;
CREATE TABLE deposits (
    action_index        BIGINT UNSIGNED NOT NULL,
    contract_index      BIGINT UNSIGNED NOT NULL,
    source_id           BIGINT UNSIGNED NOT NULL,
    tick_id             BIGINT UNSIGNED NOT NULL,
    amount              VARCHAR(250) NOT NULL,
    status_id           BIGINT UNSIGNED,
    block_index         BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON deposits (action_index);
CREATE        INDEX contract_index ON deposits (contract_index);
CREATE        INDEX source_id      ON deposits (source_id);
