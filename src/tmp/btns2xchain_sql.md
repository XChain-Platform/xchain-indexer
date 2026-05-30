# index_addresses
DROP TABLE index_addresses;
CREATE TABLE index_addresses LIKE Counterparty.index_addresses;
INSERT INTO index_addresses
SELECT * from Counterparty.index_addresses;


# index_transactions
DROP TABLE index_transactions;
CREATE TABLE index_transactions LIKE Counterparty.index_transactions;
INSERT INTO index_transactions
SELECT * from Counterparty.index_transactions;


# blocks
DROP TABLE IF EXISTS blocks;
CREATE TABLE blocks (
    block_index              INTEGER UNSIGNED PRIMARY KEY,
    block_time               INTEGER UNSIGNED,
    block_hash_id            INTEGER UNSIGNED,  -- id of record in index_transactions table
    previous_block_hash_id   INTEGER UNSIGNED   -- id of record in index_transactions table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;
CREATE INDEX block_hash_id          ON blocks (block_hash_id);
CREATE INDEX previous_block_hash_id ON blocks (previous_block_hash_id);
INSERT INTO blocks
SELECT block_index, block_time, block_hash_id, previous_block_hash_id from Counterparty.blocks where block_index>=789742;

# transactions
DROP TABLE IF EXISTS transactions;
CREATE TABLE transactions (
    tx_index       INTEGER UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tx_hash_id     INTEGER UNSIGNED, -- id of record in index_transactions
    block_index    INTEGER UNSIGNED,
    source_id      INTEGER UNSIGNED, -- id of record in index_addresses
    destination_id INTEGER UNSIGNED, -- id of record in index_addresses
    amount         BIGINT,           -- BTC amount sent
    fee            BIGINT,           -- BTC Fee paid (miners fee)
    data           MEDIUMTEXT        -- Decoded data
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci;
CREATE UNIQUE INDEX tx_hash_id     ON transactions (tx_hash_id);
CREATE        INDEX block_index    ON transactions (block_index);
CREATE        INDEX source_id      ON transactions (source_id);
CREATE        INDEX destination_id ON transactions (destination_id);
INSERT INTO transactions (tx_hash_id, block_index, source_id, data)
SELECT tx_hash_id, block_index, source_id, text FROM Counterparty.broadcasts WHERE status='valid' AND (text LIKE 'bt:%' OR text LIKE 'btns:%') ORDER BY tx_index ASC;
UPDATE transactions SET data=TRIM(LEADING 'bt:' FROM data);
UPDATE transactions SET data=TRIM(LEADING 'btns:' FROM data);