DROP TABLE IF EXISTS dispenses;
CREATE TABLE dispenses (
    action_index    BIGINT UNSIGNED NOT NULL, -- Unique action index
    give_coin_id    BIGINT UNSIGNED,          -- id of record in index_coins table
    give_tick_id    BIGINT UNSIGNED,          -- id of record in index_tickers table
    give_amount     VARCHAR(250),             -- Amount of GIVE_TICK to dispense when triggered
    get_coin_id     BIGINT UNSIGNED,          -- id of record in index_coins table
    get_tick_id     BIGINT UNSIGNED,          -- id of record in index_tickers table
    get_amount      VARCHAR(250),             -- Amount of GET_TICK required to trigger dispenser
    get_address_id  BIGINT UNSIGNED,          -- id of record in index_addresses table (dispenser address)
    source_id       BIGINT UNSIGNED,          -- id of record in index_addresses table (purchasing address)
    status_id       BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;


CREATE UNIQUE INDEX action_index    ON dispenses (action_index);
CREATE        INDEX give_coin_id    ON dispenses (give_coin_id);
CREATE        INDEX give_tick_id    ON dispenses (give_tick_id);
CREATE        INDEX get_coin_id     ON dispenses (get_coin_id);
CREATE        INDEX get_tick_id     ON dispenses (get_tick_id);
CREATE        INDEX get_address_id  ON dispenses (get_address_id);
CREATE        INDEX source_id       ON dispenses (source_id);
CREATE        INDEX status_id       ON dispenses (status_id);
