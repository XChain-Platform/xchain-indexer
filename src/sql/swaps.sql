DROP TABLE IF EXISTS swaps;
CREATE TABLE swaps (
    action_index     BIGINT UNSIGNED NOT NULL, -- Unique action index
    give_coin_id     BIGINT UNSIGNED,          -- id of record in index_coins table
    give_tick_id     BIGINT UNSIGNED,          -- id of record in index_tickers table
    give_amount      VARCHAR(250),             -- Amount of GIVE_TICK in swap
    get_coin_id      BIGINT UNSIGNED,          -- id of record in index_coins table
    get_tick_id      BIGINT UNSIGNED,          -- id of record in index_tickers table
    get_amount       VARCHAR(250),             -- Amount of GET_TICK in swap
    get_address_id   BIGINT UNSIGNED,          -- id of record in index_addresses table
    source_id        BIGINT UNSIGNED,          -- id of record in index_addresses table
    expiration       BIGINT UNSIGNED,          -- unix timestamp of swap expiration date/time
    allow_list       BIGINT UNSIGNED,          -- action_index of a list from the lists table
    block_list       BIGINT UNSIGNED,          -- action_index of a list from the lists table
    memo_id          BIGINT UNSIGNED,          -- id of record in index_memos table 
    status_id        BIGINT UNSIGNED           -- id of record in index_statuses table (status of open swap tx)
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON swaps (action_index);
CREATE        INDEX give_coin_id   ON swaps (give_coin_id);
CREATE        INDEX give_tick_id   ON swaps (give_tick_id);
CREATE        INDEX get_coin_id    ON swaps (get_coin_id);
CREATE        INDEX get_tick_id    ON swaps (get_tick_id);
CREATE        INDEX allow_list     ON swaps (allow_list);
CREATE        INDEX block_list     ON swaps (block_list);
CREATE        INDEX get_address_id ON swaps (get_address_id);
CREATE        INDEX source_id      ON swaps (source_id);
CREATE        INDEX memo_id        ON swaps (memo_id);
CREATE        INDEX status_id      ON swaps (status_id);
