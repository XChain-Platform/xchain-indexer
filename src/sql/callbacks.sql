DROP TABLE IF EXISTS callbacks;
CREATE TABLE callbacks (
    action_index     BIGINT UNSIGNED NOT NULL, -- Unique action index
    tick_id          BIGINT UNSIGNED,          -- id of record in index_tickers
    callback_tick_id BIGINT UNSIGNED,          -- id of record in index_tickers
    callback_amount  VARCHAR(250),              -- Amount of token per unit
    memo_id          BIGINT UNSIGNED,          -- id of record in index_memos table 
    status_id        BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index     ON callbacks (action_index);
CREATE        INDEX tick_id          ON callbacks (tick_id);
CREATE        INDEX callback_tick_id ON callbacks (callback_tick_id);
CREATE        INDEX memo_id          ON callbacks (memo_id);
CREATE        INDEX status_id        ON callbacks (status_id);

