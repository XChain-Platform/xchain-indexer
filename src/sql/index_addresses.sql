DROP TABLE IF EXISTS index_addresses;
CREATE TABLE index_addresses (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    address     VARCHAR(120) NOT NULL,
    -- Block at which this id was first assigned. Lets rollback delete index rows
    -- created in orphaned blocks so the explicit dense counter reproduces the same
    -- ids on reapply: this is what makes a wire ^<id> address reference resolve
    -- identically on every node. The id is assigned EXPLICITLY (db.getNextAddressId),
    -- never lazily by AUTO_INCREMENT (which never rewinds on DELETE); the
    -- AUTO_INCREMENT attribute is retained only as a dormant safety net. See
    -- src/addressRefFields.js for the consensus rationale.
    block_index BIGINT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX address on index_addresses (address);
-- Secondary index on block_index. Used by the advisory index-map parity checksum
-- (xchain-sync BlockHasher.computeIndexMapChecksum), which selects the deterministic
-- subset `WHERE block_index IS NOT NULL AND block_index <= ?`. Without it that scan
-- is a full table scan per /status poll on a large table. Rollback also filters by
-- block_index, so the index helps reorg deletes as well.
CREATE INDEX block_index on index_addresses (block_index);