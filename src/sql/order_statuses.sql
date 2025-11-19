DROP TABLE IF EXISTS order_statuses;
CREATE TABLE order_statuses (
    action_index       BIGINT UNSIGNED NOT NULL, -- Unique action index
    order_action_index BIGINT UNSIGNED NOT NULL, -- Unique action index from orders table
    status_id          BIGINT UNSIGNED           -- id of record in index_statuses table (status of order tx open/invalid/complete/cancelled/expired)
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index       ON order_statuses (action_index);
CREATE        INDEX order_action_index ON order_statuses (order_action_index);
CREATE        INDEX status_id          ON order_statuses (status_id);