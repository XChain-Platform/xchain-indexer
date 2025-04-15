-- Table used to track individual actions within a transaction

DROP TABLE IF EXISTS actions;
CREATE TABLE actions (
  action_index    BIGINT UNSIGNED NOT NULL, -- Unique index for every action
  tx_index        BIGINT UNSIGNED NOT NULL, -- tx_index from the transactions table
  action_id       BIGINT UNSIGNED NOT NULL  -- id of record in index_actions table
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index    on actions (action_index);
CREATE        INDEX tx_index        on actions (tx_index);
CREATE        INDEX action_id       on actions (action_id);
