DROP TABLE IF EXISTS index_addresses;
CREATE TABLE index_addresses (
    id      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    address VARCHAR(120) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX address on index_addresses (address(62));