DROP TABLE IF EXISTS dispenser_cancels;
CREATE TABLE dispenser_cancels (
    action_index           BIGINT UNSIGNED NOT NULL, -- Unique action index
    dispenser_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from dispensers table
    memo_id                BIGINT UNSIGNED,          -- id of record in index_memos table 
    status_id              BIGINT UNSIGNED           -- id of record in index_statuses table (valid / invalid)
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index           ON dispenser_cancels (action_index);
CREATE        INDEX dispenser_action_index ON dispenser_cancels (dispenser_action_index);
CREATE        INDEX memo_id                ON dispenser_cancels (memo_id);
CREATE        INDEX status_id              ON dispenser_cancels (status_id);