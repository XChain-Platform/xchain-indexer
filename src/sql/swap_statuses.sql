DROP TABLE IF EXISTS swap_statuses;
CREATE TABLE swap_statuses (
    action_index      BIGINT UNSIGNED NOT NULL, -- Unique action index
    swap_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from swaps table
    status_id         BIGINT UNSIGNED           -- id of record in index_statuses table (status of swap tx open/invalid/complete/cancelled/expired)
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON swap_statuses (action_index);
CREATE        INDEX swap_action_index ON swap_statuses (swap_action_index);
CREATE        INDEX status_id         ON swap_statuses (status_id);