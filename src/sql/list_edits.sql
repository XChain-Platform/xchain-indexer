DROP TABLE IF EXISTS list_edits;
CREATE TABLE list_edits (
    action_index BIGINT UNSIGNED NOT NULL,  -- Unique action index
    item_id      BIGINT UNSIGNED,           -- id of record (tick_id, asset_id, address_id) tables
    status_id    BIGINT UNSIGNED            -- id of record in index_statuses table
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index ON list_edits (action_index);
CREATE        INDEX item_id      ON list_edits (item_id);
CREATE        INDEX status_id    ON list_edits (status_id);
