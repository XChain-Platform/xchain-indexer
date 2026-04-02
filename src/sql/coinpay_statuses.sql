DROP TABLE IF EXISTS coinpay_statuses;
CREATE TABLE coinpay_statuses (
    action_index         BIGINT UNSIGNED NOT NULL, -- Unique action index that caused this status change
    coinpay_action_index BIGINT UNSIGNED NOT NULL, -- FK to coinpay_obligations (ORDER_MATCH action_index)
    status_id            BIGINT UNSIGNED            -- id of record in index_statuses table (pending_coinpay/fulfilled/expired/cancelled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index         ON coinpay_statuses (action_index);
CREATE        INDEX coinpay_action_index ON coinpay_statuses (coinpay_action_index);
CREATE        INDEX status_id            ON coinpay_statuses (status_id);
