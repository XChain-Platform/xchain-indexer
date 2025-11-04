DROP TABLE IF EXISTS swap_expires;
CREATE TABLE swap_expires (
    action_index      BIGINT UNSIGNED NOT NULL, -- Unique action index
    swap_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from swaps table
    status_id         BIGINT UNSIGNED           -- id of record in index_statuses table (valid / invalid)
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON swap_expires (action_index);
CREATE        INDEX swap_action_index ON swap_expires (swap_action_index);
CREATE        INDEX status_id         ON swap_expires (status_id);