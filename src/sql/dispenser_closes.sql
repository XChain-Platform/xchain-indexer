DROP TABLE IF EXISTS dispenser_closes;
CREATE TABLE dispenser_closes (
    action_index           BIGINT UNSIGNED NOT NULL, -- Unique action index
    dispenser_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from dispensers table
    status_id              BIGINT UNSIGNED           -- id of record in index_statuses table (valid / invalid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index           ON dispenser_closes (action_index);
CREATE        INDEX dispenser_action_index ON dispenser_closes (dispenser_action_index);
CREATE        INDEX status_id              ON dispenser_closes (status_id);