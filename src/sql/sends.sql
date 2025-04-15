DROP TABLE IF EXISTS sends;
CREATE TABLE sends (
    action_index   BIGINT UNSIGNED NOT NULL, -- Unique action index
    tick_id        BIGINT UNSIGNED,          -- id of record in index_ticks table
    source_id      BIGINT UNSIGNED,          -- id of record in index_addresses table
    destination_id BIGINT UNSIGNED,          -- id of record in index_addresses table
    amount         VARCHAR(250),              -- Amount of token in send
    memo_id        BIGINT UNSIGNED,          -- id of record in index_memos table 
    status_id      BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index   ON sends (action_index);
CREATE        INDEX tick_id        ON sends (tick_id);
CREATE        INDEX source_id      ON sends (source_id);
CREATE        INDEX destination_id ON sends (destination_id);
CREATE        INDEX status_id      ON sends (status_id);