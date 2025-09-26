DROP TABLE IF EXISTS files;
CREATE TABLE files (
    action_index        BIGINT UNSIGNED NOT NULL, -- Unique action index
    name                VARCHAR(250),             -- File Name (filename.ext)
    title               VARCHAR(250),             -- File Title (My Spreadsheet)
    type_id             BIGINT UNSIGNED,          -- id of record in index_mime_types table
    source_id           BIGINT UNSIGNED,          -- id of record in index_addresses table
    memo_id             BIGINT UNSIGNED,          -- id of record in index_memos table
    status_id           BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index ON files (action_index);
CREATE        INDEX type_id      ON files (type_id);
CREATE        INDEX memo_id      ON files (memo_id);
CREATE        INDEX source_id    ON files (source_id);
CREATE        INDEX status_id    ON files (status_id);