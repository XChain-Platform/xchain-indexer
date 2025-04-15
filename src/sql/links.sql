DROP TABLE IF EXISTS links;
CREATE TABLE links (
    action_index        INTEGER UNSIGNED NOT NULL, -- Unique action index
    link_action_index   INTEGER UNSIGNED,          -- id of record in index_mime_types table
    coin_id             INTEGER UNSIGNED,          -- id of record in index_coins table
    coin_action_index   INTEGER UNSIGNED,          -- id of record in index_mime_types table
    source_id           INTEGER UNSIGNED,          -- id of record in index_addresses table
    memo_id             INTEGER UNSIGNED,          -- id of record in index_memos table
    status_id           INTEGER UNSIGNED           -- id of record in index_statuses table
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON links (action_index);
CREATE        INDEX link_action_index ON links (link_action_index);
CREATE        INDEX coin_id           ON links (coin_id);
CREATE        INDEX coin_action_index ON links (coin_action_index);
CREATE        INDEX memo_id           ON links (memo_id);
CREATE        INDEX source_id         ON links (source_id);
CREATE        INDEX status_id         ON links (status_id);
