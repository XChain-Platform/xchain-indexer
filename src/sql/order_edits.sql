DROP TABLE IF EXISTS order_edits;
CREATE TABLE order_edits (
    action_index       BIGINT UNSIGNED NOT NULL, -- Unique action index
    order_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from orders table
    source_id          BIGINT UNSIGNED,          -- id of record in index_addresses table
    expiration         BIGINT UNSIGNED,          -- unix timestamp of swap expiration date/time
    allow_list         BIGINT UNSIGNED,          -- action_index of a list from the lists table
    block_list         BIGINT UNSIGNED,          -- action_index of a list from the lists table
    memo_id            BIGINT UNSIGNED,          -- id of record in index_memos table 
    status_id          BIGINT UNSIGNED           -- id of record in index_statuses table (valid / invalid)
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index       ON order_edits (action_index);
CREATE        INDEX order_action_index ON order_edits (order_action_index);
CREATE        INDEX source_id          ON order_edits (source_id);
CREATE        INDEX allow_list         ON order_edits (allow_list);
CREATE        INDEX block_list         ON order_edits (block_list);
CREATE        INDEX memo_id            ON order_edits (memo_id);
CREATE        INDEX status_id          ON order_edits (status_id);