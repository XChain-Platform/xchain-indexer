DROP TABLE IF EXISTS swap_edits;
CREATE TABLE swap_edits (
    action_index      BIGINT UNSIGNED NOT NULL, -- Unique action index
    swap_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from swaps table
    expiration        BIGINT UNSIGNED,          -- unix timestamp of swap expiration date/time
    allow_list        BIGINT UNSIGNED,          -- action_index of a list from the lists table
    block_list        BIGINT UNSIGNED,          -- action_index of a list from the lists table
    memo_id           BIGINT UNSIGNED,          -- id of record in index_memos table 
    status_id         BIGINT UNSIGNED           -- id of record in index_statuses table (valid / invalid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON swap_edits (action_index);
CREATE        INDEX swap_action_index ON swap_edits (swap_action_index);
CREATE        INDEX allow_list        ON swap_edits (allow_list);
CREATE        INDEX block_list        ON swap_edits (block_list);
CREATE        INDEX memo_id           ON swap_edits (memo_id);
CREATE        INDEX status_id         ON swap_edits (status_id);