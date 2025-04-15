DROP TABLE IF EXISTS credits;
CREATE TABLE credits (
    action_index BIGINT UNSIGNED NOT NULL, -- Unique action index
    address_id   BIGINT UNSIGNED,          -- id of record in index_addresses table
    tick_id      BIGINT UNSIGNED,          -- id of record in index_tickers table
    amount       VARCHAR(250)               -- AMOUNT of credit
) ENGINE=MyISAM DEFAULT  CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX action_index ON credits (action_index);
CREATE INDEX address_id   ON credits (address_id);
CREATE INDEX tick_id      ON credits (tick_id);
