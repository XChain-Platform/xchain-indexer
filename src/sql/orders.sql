DROP TABLE IF EXISTS orders;
CREATE TABLE orders (
    action_index     BIGINT UNSIGNED NOT NULL, -- Unique action index
    give_coin_id     BIGINT UNSIGNED,          -- id of record in index_coins table
    give_tick_id     BIGINT UNSIGNED,          -- id of record in index_tickers table
    give_amount      VARCHAR(250),             -- Amount of GIVE_TICK in order
    get_coin_id      BIGINT UNSIGNED,          -- id of record in index_coins table
    get_tick_id      BIGINT UNSIGNED,          -- id of record in index_tickers table
    get_amount       VARCHAR(250),             -- Amount of GET_TICK in order
    get_address_id   BIGINT UNSIGNED,          -- id of record in index_addresses table
    give_ownership   TINYINT(1) NOT NULL DEFAULT 0, -- 1 = order escrows GIVE_TICK ownership instead of a balance amount
    get_ownership    TINYINT(1) NOT NULL DEFAULT 0, -- 1 = order requires matcher to currently own GET_TICK and transfer it
    expiration       BIGINT UNSIGNED,          -- unix timestamp of order expiration date/time
    allow_list       BIGINT UNSIGNED,          -- action_index of a list from the lists table
    block_list       BIGINT UNSIGNED,          -- action_index of a list from the lists table
    memo_id          BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id        BIGINT UNSIGNED,          -- id of record in index_statuses table (status of open order tx)
    payout_legs      TEXT                      -- programmable policy: JSON [{to,bps}] royalty/fee split of seller proceeds, applied at match (NULL = none)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON orders (action_index);
CREATE        INDEX give_coin_id   ON orders (give_coin_id);
CREATE        INDEX give_tick_id   ON orders (give_tick_id);
CREATE        INDEX get_coin_id    ON orders (get_coin_id);
CREATE        INDEX get_tick_id    ON orders (get_tick_id);
CREATE        INDEX allow_list     ON orders (allow_list);
CREATE        INDEX block_list     ON orders (block_list);
CREATE        INDEX get_address_id ON orders (get_address_id);
CREATE        INDEX memo_id        ON orders (memo_id);
CREATE        INDEX status_id      ON orders (status_id);
CREATE        INDEX give_ownership ON orders (give_ownership);
CREATE        INDEX get_ownership  ON orders (get_ownership);
