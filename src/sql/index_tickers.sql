DROP TABLE IF EXISTS index_tickers;
CREATE TABLE index_tickers (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tick        TEXT NOT NULL,
    -- Block at which this id was first assigned (rollback-scoped, same role as the
    -- column on index_addresses). A wire ^<id> ticker reference resolves through
    -- this id, so rollback must delete ids created in orphaned blocks and the
    -- explicit dense counter (db.getNextTickerId) reproduces them on reapply.
    block_index BIGINT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE UNIQUE INDEX tick on index_tickers (tick(200));
-- Secondary index on block_index, mirroring index_addresses.sql. Declared here (not
-- only in the dated migration that added it out of band) so reconcileTableIndexes can
-- parse it and the definition path self-heals: without this line the index exists as a
-- ledger artifact only, and baselining that migration into the definitions would
-- silently drop it for fresh installs while long-lived DBs kept it. Reorg deletes scan
-- by block_index, so the index serves rollback as well as the parity checksum.
CREATE INDEX block_index on index_tickers (block_index);