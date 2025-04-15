DROP TABLE IF EXISTS list_items;
CREATE TABLE list_items (
    action_index BIGINT UNSIGNED NOT NULL, -- Unique action index
    item_id      BIGINT UNSIGNED           -- id of record (tick_id, address_id) tables
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index ON list_items (action_index);
CREATE        INDEX item_id      ON list_items (item_id);
