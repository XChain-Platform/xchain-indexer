DROP TABLE IF EXISTS sweeps;
CREATE TABLE sweeps (
    action_index     INTEGER UNSIGNED NOT NULL, -- Unique action index
    balances         INTEGER UNSIGNED,          -- Indicates if token balances should be swept
    ownerships       INTEGER UNSIGNED,          -- Indicates if token ownerships should be swept
    source_id        INTEGER UNSIGNED,          -- id of record in index_addresses table
    destination_id   INTEGER UNSIGNED,          -- id of record in index_addresses table
    memo_id          INTEGER UNSIGNED,          -- id of record in index_memos table 
    status_id        INTEGER UNSIGNED           -- id of record in index_statuses table
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON sweeps (action_index);
CREATE        INDEX source_id      ON sweeps (source_id);
CREATE        INDEX destination_id ON sweeps (destination_id);
CREATE        INDEX memo_id        ON sweeps (memo_id);
CREATE        INDEX status_id      ON sweeps (status_id);

