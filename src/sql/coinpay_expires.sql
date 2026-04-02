DROP TABLE IF EXISTS coinpay_expires;
CREATE TABLE coinpay_expires (
    action_index            BIGINT UNSIGNED NOT NULL, -- Unique action index of this COINPAY_EXPIRE action
    obligation_action_index BIGINT UNSIGNED NOT NULL, -- FK to coinpay_obligations (ORDER_MATCH action_index)
    status_id               BIGINT UNSIGNED            -- id of record in index_statuses table (valid/invalid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index            ON coinpay_expires (action_index);
CREATE        INDEX obligation_action_index ON coinpay_expires (obligation_action_index);
CREATE        INDEX status_id               ON coinpay_expires (status_id);
