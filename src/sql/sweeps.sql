DROP TABLE IF EXISTS sweeps;
CREATE TABLE sweeps (
    action_index     BIGINT UNSIGNED NOT NULL, -- Unique action index
    balances         BIGINT UNSIGNED,          -- Indicates if token balances should be swept
    ownerships       BIGINT UNSIGNED,          -- Indicates if token ownerships should be swept
    destination_id   BIGINT UNSIGNED,          -- id of record in index_addresses table
    memo_id          BIGINT UNSIGNED,          -- id of record in index_memos table 
    status_id        BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON sweeps (action_index);
CREATE        INDEX destination_id ON sweeps (destination_id);
CREATE        INDEX memo_id        ON sweeps (memo_id);
CREATE        INDEX status_id      ON sweeps (status_id);

