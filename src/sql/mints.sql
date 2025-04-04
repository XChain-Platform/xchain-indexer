DROP TABLE IF EXISTS mints;
CREATE TABLE mints (
    action_index   INTEGER UNSIGNED NOT NULL, -- Unique action index
    tick_id        INTEGER UNSIGNED,          -- id of record in index_ticks table
    amount         VARCHAR(250),              -- Amount of token to mint
    source_id      INTEGER UNSIGNED,          -- id of record in index_addresses table (address that did MINT)
    destination_id INTEGER UNSIGNED,          -- id of record in index_addresses table (optional, mint and transfer)
    memo_id        INTEGER UNSIGNED,          -- id of record in index_memos table 
    status_id      INTEGER UNSIGNED           -- id of record in index_statuses table
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON mints (action_index);
CREATE        INDEX tick_id        ON mints (tick_id);
CREATE        INDEX source_id      ON mints (source_id);
CREATE        INDEX destination_id ON mints (destination_id);
CREATE        INDEX memo_id        ON mints (memo_id);
CREATE        INDEX status_id      ON mints (status_id);
