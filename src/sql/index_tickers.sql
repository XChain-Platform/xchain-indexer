DROP TABLE IF EXISTS index_tickers;
CREATE TABLE index_tickers (
    id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tick TEXT NOT NULL
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE INDEX tick on index_tickers (tick(200));

-- Create record for blank/empty transaction
INSERT INTO index_tickers (id,tick) values (1,'');
INSERT INTO index_tickers (id,tick) values (2,'GAS');
