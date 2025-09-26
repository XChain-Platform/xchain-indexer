-- Table used to map files to tickers
-- Note : Used to pull a list of action_indexes where a file is linked to a tick

DROP TABLE IF EXISTS mappings_files;
CREATE TABLE mappings_files (
    action_index  BIGINT  UNSIGNED NOT NULL, -- Action index
    type_id       TINYINT UNSIGNED,          -- Integer value for mapping type
                                             -- 1 = tick (id=tick_id)
    id            BIGINT UNSIGNED NOT NULL   -- id of record
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index      ON mappings_files (action_index);
CREATE        INDEX type_id           ON mappings_files (type_id);
CREATE        INDEX id                ON mappings_files (id);
