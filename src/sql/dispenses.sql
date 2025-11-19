DROP TABLE IF EXISTS dispenses;
CREATE TABLE dispenses (
    action_index             BIGINT UNSIGNED NOT NULL, -- Unique action index
    dispenser_action_index   BIGINT UNSIGNED,          -- action_index of dispenser
    give_amount              VARCHAR(250),             -- Amount dispensed
    get_amount               VARCHAR(250),             -- Amount paid
    destination_id           BIGINT UNSIGNED,          -- id of record in index_addresses table
    status_id                BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index           ON dispenses (action_index);
CREATE        INDEX dispenser_action_index ON dispenses (dispenser_action_index);
CREATE        INDEX destination_id         ON dispenses (destination_id);
CREATE        INDEX status_id              ON dispenses (status_id);
