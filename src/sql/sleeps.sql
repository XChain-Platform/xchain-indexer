DROP TABLE IF EXISTS `sleeps`;
CREATE TABLE sleeps (
    action_index     BIGINT UNSIGNED NOT NULL, -- Unique action index
    type             BIGINT UNSIGNED,          -- 1=Address, 2=Ticker
    source_id        BIGINT UNSIGNED,          -- id of record in index_addresses table
    tick_id          BIGINT UNSIGNED,          -- id of record in index_tickers table
    memo_id          BIGINT UNSIGNED,          -- id of record in index_memos table 
    status_id        BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON sleeps (action_index);
CREATE        INDEX type           ON sleeps (type);
CREATE        INDEX source_id      ON sleeps (source_id);
CREATE        INDEX tick_id        ON sleeps (tick_id);
CREATE        INDEX memo_id        ON sleeps (memo_id);
CREATE        INDEX status_id      ON sleeps (status_id);

