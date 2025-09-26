-- Table used to map action_indexes
-- Note : Used to pull a list of action_indexes related to an address or tick

DROP TABLE IF EXISTS mappings_actions;
CREATE TABLE mappings_actions (
    action_index  BIGINT  UNSIGNED NOT NULL, -- Action index
    type_id       TINYINT UNSIGNED,          -- Integer value for mapping type
                                             -- 1 = tick    (id=tick_id)
                                             -- 2 = address (id=address_id)
    id            BIGINT UNSIGNED NOT NULL   -- id of record
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE        INDEX action_index      ON mappings_actions (action_index);
CREATE        INDEX type_id           ON mappings_actions (type_id);
CREATE        INDEX id                ON mappings_actions (id);
