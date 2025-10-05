DROP TABLE IF EXISTS destroys;
CREATE TABLE destroys (
    action_index BIGINT UNSIGNED NOT NULL, -- Unique action index
    tick_id      BIGINT UNSIGNED,          -- id of record in index_ticks table
    amount       VARCHAR(250),              -- Amount of token to destroy
    memo_id      BIGINT UNSIGNED,          -- id of record in index_memos table 
    status_id    BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON destroys (action_index);
CREATE        INDEX tick_id        ON destroys (tick_id);
CREATE        INDEX memo_id        ON destroys (memo_id);
CREATE        INDEX status_id      ON destroys (status_id);

