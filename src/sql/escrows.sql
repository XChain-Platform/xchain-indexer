DROP TABLE IF EXISTS escrows;
CREATE TABLE escrows (
    action_index BIGINT UNSIGNED NOT NULL, -- Unique action index
    address_id   BIGINT UNSIGNED,          -- id of record in index_addresses table
    tick_id      BIGINT UNSIGNED,          -- id of record in index_tickers table
    amount       VARCHAR(250)               -- AMOUNT of credit
) ENGINE=InnoDB DEFAULT  CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX action_index ON escrows (action_index);
CREATE INDEX address_id   ON escrows (address_id);
CREATE INDEX tick_id      ON escrows (tick_id);
