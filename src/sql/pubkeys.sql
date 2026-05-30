-- Maps a source address to its public key, copied from the decoder at index time

CREATE TABLE IF NOT EXISTS pubkeys (
  address_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  pubkey     VARCHAR(66) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
