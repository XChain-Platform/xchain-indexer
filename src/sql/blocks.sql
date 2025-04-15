DROP TABLE IF EXISTS blocks;
CREATE TABLE blocks (
    id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    block_index      BIGINT UNSIGNED,
    block_time       BIGINT UNSIGNED,
    credits_hash_id  BIGINT UNSIGNED,  -- id of record in index_transactions table (sha256 hash of credits data)
    debits_hash_id   BIGINT UNSIGNED,  -- id of record in index_transactions table (sha256 hash of debits data)
    actions_hash_id  BIGINT UNSIGNED   -- id of record in index_transactions table (sha256 hash of actions data)
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX block_index       ON blocks (block_index);
CREATE INDEX credits_hash_id   ON blocks (credits_hash_id);
CREATE INDEX debits_hash_id    ON blocks (debits_hash_id);
