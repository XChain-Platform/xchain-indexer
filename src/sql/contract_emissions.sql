DROP TABLE IF EXISTS contract_emissions;
CREATE TABLE contract_emissions (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    execution_index     BIGINT UNSIGNED NOT NULL,
    emitted_action      VARCHAR(20) NOT NULL,
    action_index        BIGINT UNSIGNED NOT NULL,
    position            INT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX execution_index ON contract_emissions (execution_index);
CREATE INDEX action_index    ON contract_emissions (action_index);
