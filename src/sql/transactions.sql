-- Table used to track individual transactions

DROP TABLE IF EXISTS transactions;
CREATE TABLE transactions (
  tx_index    BIGINT UNSIGNED NOT NULL,
  block_index BIGINT UNSIGNED NOT NULL,
  tx_hash_id  BIGINT UNSIGNED NOT NULL -- id of record in index_transactions table
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX tx_index    on transactions (tx_index);
CREATE        INDEX block_index on transactions (block_index);
CREATE        INDEX tx_hash_id  on transactions (tx_hash_id);
