DROP TABLE IF EXISTS index_coins;
CREATE TABLE index_coins (
    id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    coin VARCHAR(250) NOT NULL
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX coin on index_coins (coin);

-- Create record for blank/empty transaction
INSERT INTO index_coins (id,coin) values (1,'');