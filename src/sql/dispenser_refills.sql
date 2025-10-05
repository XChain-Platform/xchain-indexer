DROP TABLE IF EXISTS dispenser_refills;
CREATE TABLE dispenser_refills (
    action_index           BIGINT UNSIGNED NOT NULL, -- Unique action index
    destination_id         BIGINT UNSIGNED,          -- id of record in index_addresses
    asset_id               BIGINT UNSIGNED,          -- id of record in assets table
    dispenser_action_index BIGINT UNSIGNED,          -- dispenser action_index
    dispense_quantity      BIGINT
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index           ON dispenser_refills (action_index);
CREATE        INDEX destination_id         ON dispenser_refills (destination_id);
CREATE        INDEX asset_id               ON dispenser_refills (asset_id);
CREATE        INDEX dispenser_action_index ON dispenser_refills (dispenser_action_index);
