DROP TABLE IF EXISTS lists;
CREATE TABLE lists (
    action_index        INTEGER UNSIGNED NOT NULL, -- Unique action index
    type                VARCHAR(1),                -- List type (1=TICK, 2=ASSET, 3=ADDRESS)
    edit                VARCHAR(1),                -- Edit action (1=ADD, 2=REMOVE)
    source_id           INTEGER UNSIGNED,          -- id of record in index_addresses table
    list_action_index   INTEGER UNSIGNED,          -- list action_index
    status_id           INTEGER UNSIGNED           -- id of record in index_statuses table
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON lists (action_index);
CREATE        INDEX type              ON lists (type);
CREATE        INDEX edit              ON lists (edit);
CREATE        INDEX list_action_index ON lists (list_action_index);
CREATE        INDEX source_id         ON lists (source_id);
CREATE        INDEX status_id         ON lists (status_id);



