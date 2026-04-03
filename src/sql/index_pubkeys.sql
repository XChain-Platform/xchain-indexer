DROP TABLE IF EXISTS index_pubkeys;
CREATE TABLE index_pubkeys (
    id      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    pubkey  CHAR(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX pubkey ON index_pubkeys (pubkey);
