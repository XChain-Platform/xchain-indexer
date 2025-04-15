DROP TABLE IF EXISTS list_items_invalid;
CREATE TABLE list_items_invalid (
    action_index BIGINT UNSIGNED NOT NULL, -- Unique action index
    item_id      BIGINT UNSIGNED,           -- id of record (tick_id, address_id) tables
    status_id    BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index ON list_items_invalid (action_index);
CREATE        INDEX item_id      ON list_items_invalid (item_id);
CREATE        INDEX status_id    ON list_items_invalid (status_id);
