DROP TABLE IF EXISTS dividends;
CREATE TABLE dividends (
    action_index     BIGINT UNSIGNED NOT NULL, -- Unique action index
    tick_id          BIGINT UNSIGNED,          -- id of record in index_ticks
    dividend_tick_id BIGINT UNSIGNED,          -- id of record in index_ticks
    amount           VARCHAR(250),              -- Amount of token per unit
    memo_id          BIGINT UNSIGNED,          -- id of record in index_memos table 
    status_id        BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index     ON dividends (action_index);
CREATE        INDEX tick_id          ON dividends (tick_id);
CREATE        INDEX dividend_tick_id ON dividends (dividend_tick_id);
CREATE        INDEX memo_id          ON dividends (memo_id);
CREATE        INDEX status_id        ON dividends (status_id);

