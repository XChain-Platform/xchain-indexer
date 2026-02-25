DROP TABLE IF EXISTS broadcasts;
CREATE TABLE broadcasts (
    action_index           BIGINT UNSIGNED NOT NULL, -- Unique action index
    message                VARCHAR(250),             -- Message, oracle info, or feed info
    `value`                VARCHAR(25),              -- Numerical value of the broadcast
    fee                    VARCHAR(11),              -- Oracle / Feed usage  fee
    memo_id                BIGINT UNSIGNED,          -- id of record in index_memos table 
    broadcast_action_index BIGINT UNSIGNED,          -- broadcast action_index
    status_id              BIGINT UNSIGNED           -- id of record in index_statuses table

) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index           ON broadcasts (action_index);
CREATE        INDEX broadcast_action_index ON broadcasts (broadcast_action_index);
CREATE        INDEX memo_id                ON broadcasts (memo_id);
CREATE        INDEX status_id              ON broadcasts (status_id);
