DROP TABLE IF EXISTS markets;
CREATE TABLE markets (
    id                 INTEGER UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tick1_id           BIGINT UNSIGNED,                 -- tick1 - id of record in index_tickers table
    tick1_price        VARCHAR(250) NOT NULL default 0, -- tick1 - last trade price
    tick1_bid          VARCHAR(250) NOT NULL default 0, -- tick1 - highest price buyers are paying
    tick1_ask          VARCHAR(250) NOT NULL default 0, -- tick1 - highest price sellers are accepting
    tick1_24hr_price   VARCHAR(250) NOT NULL default 0, -- tick1 - Price exactly 24 hours ago
    tick1_24hr_high    VARCHAR(250) NOT NULL default 0, -- tick1 - 24-hour high price
    tick1_24hr_low     VARCHAR(250) NOT NULL default 0, -- tick1 - 24-hour low price
    tick1_24hr_change  VARCHAR(250) NOT NULL default 0, -- tick1 - 24-hour percentage change
    tick1_24hr_volume  VARCHAR(250) NOT NULL default 0, -- tick1 - 24-hour volume
    tick2_id           BIGINT UNSIGNED,                 -- tick2 - id of record in index_tickers table
    tick2_price        VARCHAR(250) NOT NULL default 0, -- tick2 - last trade price
    tick2_bid          VARCHAR(250) NOT NULL default 0, -- tick2 - highest price buyers are paying
    tick2_ask          VARCHAR(250) NOT NULL default 0, -- tick2 - highest price sellers are accepting
    tick2_24hr_price   VARCHAR(250) NOT NULL default 0, -- tick2 - Price exactly 24 hours ago
    tick2_24hr_high    VARCHAR(250) NOT NULL default 0, -- tick2 - 24-hour high price
    tick2_24hr_low     VARCHAR(250) NOT NULL default 0, -- tick2 - 24-hour low price
    tick2_24hr_change  VARCHAR(250) NOT NULL default 0, -- tick2 - 24-hour percentage change
    tick2_24hr_volume  VARCHAR(250) NOT NULL default 0, -- tick2 - 24-hour volume
    last_updated  BIGINT UNSIGNED                       -- Last updated
) ENGINE=MyISAM;

CREATE INDEX tick1_id on markets (tick1_id);
CREATE INDEX tick2_id on markets (tick2_id);