DROP TABLE IF EXISTS addresses;
CREATE TABLE IF NOT EXISTS addresses (
    action_index   BIGINT UNSIGNED NOT NULL, -- Unique action index
    fee_preference BIGINT UNSIGNED,
    require_memo   BIGINT UNSIGNED,
    memo_id        BIGINT UNSIGNED,          -- id of record in index_memos table 
    status_id      BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index   ON addresses (action_index);
CREATE        INDEX memo_id        ON addresses (memo_id);
CREATE        INDEX status_id      ON addresses (status_id);