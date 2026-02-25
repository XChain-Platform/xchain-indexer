-- Table used to track individual actions within a transaction

DROP TABLE IF EXISTS actions;
CREATE TABLE actions (
  action_index  BIGINT UNSIGNED NOT NULL, -- Unique index for every action
  block_index   BIGINT UNSIGNED NOT NULL, -- block_index from the blocks table
  tx_index      BIGINT UNSIGNED,          -- tx_index from the transactions table
  tx_vout       BIGINT UNSIGNED,          -- transaction output index
  action_id     BIGINT UNSIGNED NOT NULL, -- id of record in index_actions table
  action_format TINYINT UNSIGNED          -- FORMAT of action data (0-255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index    on actions (action_index);
CREATE        INDEX block_index     on actions (block_index);
CREATE        INDEX tx_index        on actions (tx_index);
CREATE        INDEX action_id       on actions (action_id);
CREATE        INDEX action_format   on actions (action_format);