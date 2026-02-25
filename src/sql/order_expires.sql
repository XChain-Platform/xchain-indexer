DROP TABLE IF EXISTS order_expires;
CREATE TABLE order_expires (
    action_index       BIGINT UNSIGNED NOT NULL, -- Unique action index
    order_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from order table
    status_id          BIGINT UNSIGNED           -- id of record in index_statuses table (valid / invalid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index       ON order_expires (action_index);
CREATE        INDEX order_action_index ON order_expires (order_action_index);
CREATE        INDEX status_id          ON order_expires (status_id);