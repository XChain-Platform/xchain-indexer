DROP TABLE IF EXISTS dispenser_edits;
CREATE TABLE dispenser_edits (
    action_index       BIGINT UNSIGNED NOT NULL,     -- Unique action index
    dispenser_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from dispensers table
    give_escrow        VARCHAR(250),                 -- Amount of GIVE_TICK to add to escrow
    expiration         BIGINT UNSIGNED,              -- unix timestamp of dispenser expiration date/time
    allow_list         BIGINT UNSIGNED,              -- action_index of a list from the lists table
    block_list         BIGINT UNSIGNED,              -- action_index of a list from the lists table
    memo_id            BIGINT UNSIGNED,              -- id of record in index_memos table 
    status_id          BIGINT UNSIGNED               -- id of record in index_statuses table (valid / invalid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index           ON dispenser_edits (action_index);
CREATE        INDEX dispenser_action_index ON dispenser_edits (dispenser_action_index);
CREATE        INDEX allow_list             ON dispenser_edits (allow_list);
CREATE        INDEX block_list             ON dispenser_edits (block_list);
CREATE        INDEX memo_id                ON dispenser_edits (memo_id);
CREATE        INDEX status_id              ON dispenser_edits (status_id);