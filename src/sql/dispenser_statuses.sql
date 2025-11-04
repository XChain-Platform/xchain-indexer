DROP TABLE IF EXISTS dispenser_statuses;
CREATE TABLE dispenser_statuses (
    action_index           BIGINT UNSIGNED NOT NULL, -- Unique action index
    dispenser_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from dispensers table
    status_id              BIGINT UNSIGNED           -- id of record in index_statuses table (status of order tx open/invalid/complete/cancelled/expired)
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index           ON dispenser_statuses (action_index);
CREATE        INDEX dispenser_action_index ON dispenser_statuses (dispenser_action_index);
CREATE        INDEX status_id              ON dispenser_statuses (status_id);