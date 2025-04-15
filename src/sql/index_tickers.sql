DROP TABLE IF EXISTS index_tickers;
CREATE TABLE index_tickers (
    id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tick VARCHAR(250) NOT NULL
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX tick on index_tickers (tick);

-- Create record for blank/empty transaction
INSERT INTO index_tickers (id,tick) values (1,'');
INSERT INTO index_tickers (id,tick) values (2,'GAS');
