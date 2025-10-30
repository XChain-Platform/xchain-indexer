DROP TABLE IF EXISTS swap_matches;
CREATE TABLE swap_matches (
    action_index      BIGINT UNSIGNED NOT NULL, -- Unique action index
    give_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index on GIVE_COIN network of the swap request
    give_coin_id      BIGINT UNSIGNED NOT NULL, -- id of record in index_coins table
    give_tick_id      BIGINT UNSIGNED NOT NULL, -- id of record in index_tickers table
    give_amount       VARCHAR(250),             -- Amount of GIVE_TICK in in SWAP_MATCH
    get_action_index  BIGINT UNSIGNED NOT NULL, -- Unique action index on GET_COIN network of the swap request
    get_coin_id       BIGINT UNSIGNED NOT NULL, -- id of record in index_coins table
    get_tick_id       BIGINT UNSIGNED NOT NULL, -- id of record in index_coins table
    get_amount        VARCHAR(250),             -- Amount of GET_TICK in in SWAP_MATCH
    status_id         BIGINT UNSIGNED           -- id of record in index_statuses table (valid / invalid)
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON swap_matches (action_index);
CREATE        INDEX give_coin_id      ON swap_matches (give_coin_id);
CREATE        INDEX give_tick_id      ON swap_matches (give_tick_id);
CREATE        INDEX give_action_index ON swap_matches (give_action_index);
CREATE        INDEX get_coin_id       ON swap_matches (get_coin_id);
CREATE        INDEX get_tick_id       ON swap_matches (get_tick_id);
CREATE        INDEX get_action_index  ON swap_matches (get_action_index);
CREATE        INDEX status_id         ON swap_matches (status_id);
