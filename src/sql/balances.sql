DROP TABLE IF EXISTS balances;
CREATE TABLE balances (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    address_id BIGINT UNSIGNED, -- id of record in index_addresses
    tick_id    BIGINT UNSIGNED, -- id of record in index_tickers
    amount     VARCHAR(250)      -- AMOUNT of balance
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX tick_id ON balances (tick_id);
CREATE UNIQUE INDEX addr_tick ON balances (address_id, tick_id);