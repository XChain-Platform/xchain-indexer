DROP TABLE IF EXISTS batches;
CREATE TABLE batches (
    action_index BIGINT UNSIGNED NOT NULL, -- Unique action index
    status_id    BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON batches (action_index);
CREATE        INDEX status_id      ON batches (status_id);