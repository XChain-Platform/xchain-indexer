DROP TABLE IF EXISTS index_transactions;
CREATE TABLE index_transactions (
    id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    hash VARCHAR(250) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX hash on index_transactions (hash(64));