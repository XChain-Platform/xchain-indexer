DROP TABLE IF EXISTS order_matches;
CREATE TABLE order_matches (
    action_index      BIGINT UNSIGNED NOT NULL, -- Unique action index
    give_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index on GIVE_COIN network of the order request
    give_coin_id      BIGINT UNSIGNED NOT NULL, -- id of record in index_coins table
    give_tick_id      BIGINT UNSIGNED,          -- id of record in index_tickers table (NULL for native-coin side of a COINPay match)
    give_amount       VARCHAR(250),             -- Amount of GIVE_TICK
    get_action_index  BIGINT UNSIGNED NOT NULL, -- Unique action index on GET_COIN network of the order request
    get_coin_id       BIGINT UNSIGNED NOT NULL, -- id of record in index_coins table
    get_tick_id       BIGINT UNSIGNED,          -- id of record in index_tickers table (NULL for native-coin side of a COINPay match)
    get_amount        VARCHAR(250),             -- Amount of GET_TICK
    settlement_type   ENUM('instant','coinpay') DEFAULT 'instant', -- Settlement type (instant for token-token, coinpay for native coin pairs)
    status_id         BIGINT UNSIGNED           -- id of record in index_statuses table (valid / invalid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON order_matches (action_index);
CREATE        INDEX give_coin_id      ON order_matches (give_coin_id);
CREATE        INDEX give_tick_id      ON order_matches (give_tick_id);
CREATE        INDEX give_action_index ON order_matches (give_action_index);
CREATE        INDEX get_coin_id       ON order_matches (get_coin_id);
CREATE        INDEX get_tick_id       ON order_matches (get_tick_id);
CREATE        INDEX get_action_index  ON order_matches (get_action_index);
CREATE        INDEX status_id         ON order_matches (status_id);

