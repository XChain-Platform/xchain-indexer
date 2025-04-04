DROP TABLE IF EXISTS addresses;
CREATE TABLE IF NOT EXISTS addresses (
    action_index   INTEGER UNSIGNED NOT NULL, -- Unique action index
    source_id      INTEGER UNSIGNED,          -- id of record in index_addresses table
    fee_preference INTEGER UNSIGNED,
    require_memo   INTEGER UNSIGNED,
    status_id      INTEGER UNSIGNED           -- id of record in index_statuses table
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON addresses (action_index);
CREATE        INDEX source_id      ON addresses (source_id);
CREATE        INDEX status_id      ON addresses (status_id);