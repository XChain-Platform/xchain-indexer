DROP TABLE IF EXISTS swap_cancels;
CREATE TABLE swap_cancels (
    action_index      BIGINT UNSIGNED NOT NULL, -- Unique action index
    swap_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from swaps table
    memo_id           BIGINT UNSIGNED,          -- id of record in index_memos table 
    status_id         BIGINT UNSIGNED           -- id of record in index_statuses table (valid / invalid)
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON swap_cancels (action_index);
CREATE        INDEX swap_action_index ON swap_cancels (swap_action_index);
CREATE        INDEX memo_id           ON swap_cancels (memo_id);
CREATE        INDEX status_id         ON swap_cancels (status_id);