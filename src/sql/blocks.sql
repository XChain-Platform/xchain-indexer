DROP TABLE IF EXISTS blocks;
CREATE TABLE blocks (
    id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    block_index      BIGINT UNSIGNED,
    block_time       BIGINT UNSIGNED,
    ledger_hash_id   BIGINT UNSIGNED,  -- id of record in index_transactions table (sha256 hash of credits/debits/escrow/balances data)
    actions_hash_id  BIGINT UNSIGNED   -- id of record in index_transactions table (sha256 hash of actions data)
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX block_index     ON blocks (block_index);
CREATE INDEX ledger_hash_id  ON blocks (ledger_hash_id);
CREATE INDEX actions_hash_id ON blocks (actions_hash_id);
