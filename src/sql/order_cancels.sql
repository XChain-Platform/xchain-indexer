DROP TABLE IF EXISTS order_cancels;
CREATE TABLE order_cancels (
    action_index      BIGINT UNSIGNED NOT NULL,  -- Unique action index
    order_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from orders table
    source_id         BIGINT UNSIGNED,           -- id of record in index_addresses table
    memo_id           BIGINT UNSIGNED,           -- id of record in index_memos table 
    status_id         BIGINT UNSIGNED            -- id of record in index_statuses table (valid / invalid)
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index       ON order_cancels (action_index);
CREATE        INDEX order_action_index ON order_cancels (order_action_index);
CREATE        INDEX source_id          ON order_cancels (source_id);
CREATE        INDEX memo_id            ON order_cancels (memo_id);
CREATE        INDEX status_id          ON order_cancels (status_id);