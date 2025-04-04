DROP TABLE IF EXISTS airdrops;
CREATE TABLE airdrops (
    action_index INTEGER UNSIGNED NOT NULL, -- Unique action index
    tick_id      INTEGER UNSIGNED,          -- id of record in index_ticks
    source_id    INTEGER UNSIGNED,          -- id of record in index_addresses table
    list_id      INTEGER UNSIGNED,          -- id of record in index_transactions 
    amount       VARCHAR(250),              -- Amount of token in airdrop
    memo_id      INTEGER UNSIGNED,          -- id of record in index_memos table 
    status_id    INTEGER UNSIGNED           -- id of record in index_statuses table
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON airdrops (action_index);
CREATE        INDEX tick_id        ON airdrops (tick_id);
CREATE        INDEX source_id      ON airdrops (source_id);
CREATE        INDEX list_id        ON airdrops (list_id);
CREATE        INDEX memo_id        ON airdrops (memo_id);
CREATE        INDEX status_id      ON airdrops (status_id);

