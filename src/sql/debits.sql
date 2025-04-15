DROP TABLE IF EXISTS debits;
CREATE TABLE debits (
    action_index BIGINT UNSIGNED NOT NULL, -- Unique action index
    address_id   BIGINT UNSIGNED,          -- id of record in index_addresses table
    tick_id      BIGINT UNSIGNED,          -- id of record in index_tickers table
    amount       VARCHAR(250)               -- AMOUNT of debit
) ENGINE=MyISAM DEFAULT  CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX action_index ON debits (action_index);
CREATE INDEX address_id   ON debits (address_id);
CREATE INDEX tick_id      ON debits (tick_id);
