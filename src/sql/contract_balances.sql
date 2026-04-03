DROP TABLE IF EXISTS contract_balances;
CREATE TABLE contract_balances (
    contract_index      BIGINT UNSIGNED NOT NULL,
    tick_id             BIGINT UNSIGNED NOT NULL,
    amount              VARCHAR(250) NOT NULL,
    PRIMARY KEY (contract_index, tick_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
