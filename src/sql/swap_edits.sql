DROP TABLE IF EXISTS swap_edits;
CREATE TABLE swap_edits (
    action_index      BIGINT UNSIGNED NOT NULL, -- Unique action index
    swap_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from swaps table
    source_id         BIGINT UNSIGNED,          -- id of record in index_addresses table
    expiration        BIGINT UNSIGNED,          -- unix timestamp of swap expiration date/time
    memo_id           BIGINT UNSIGNED,          -- id of record in index_memos table 
    status_id         BIGINT UNSIGNED           -- id of record in index_statuses table (valid / invalid)
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON swap_edits (action_index);
CREATE        INDEX swap_action_index ON swap_edits (swap_action_index);
CREATE        INDEX source_id         ON swap_edits (source_id);
CREATE        INDEX memo_id           ON swap_edits (memo_id);
CREATE        INDEX status_id         ON swap_edits (status_id);