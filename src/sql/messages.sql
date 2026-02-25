DROP TABLE IF EXISTS messages;
-- TODO : Convert encryption_method field to INTEGER UNSIGNED and force value to 0-9 (0=null)
CREATE TABLE messages (
    action_index        BIGINT UNSIGNED NOT NULL, -- Unique action index
    destination_id      BIGINT UNSIGNED,          -- id of record in index_addresses table
    encryption_method   VARCHAR(1),               -- Encryption Method (1=ECDH, 2=AES)
    encryption_key      MEDIUMTEXT,               -- Public key to be used to exchange messages
    encrypted_message   MEDIUMTEXT,               -- Encrypted Message
    plaintext_message   MEDIUMTEXT,               -- Plaintext Message
    status_id           BIGINT UNSIGNED           -- id of record in index_statuses table
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX action_index      ON messages (action_index);
CREATE        INDEX encryption_method ON messages (encryption_method);
CREATE        INDEX destination_id    ON messages (destination_id);
CREATE        INDEX status_id         ON messages (status_id);
