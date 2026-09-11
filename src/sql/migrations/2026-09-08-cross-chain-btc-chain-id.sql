-- xchain:migration mode=auto
-- Migration: chain identity on the three hub-mirrored cross-chain tables.
--
-- WHY
-- ---
-- The mirrored rows in cross_chain_matches, cross_chain_calls and capability_snapshots
-- are scoped by `network` alone, and on regtest one network name spans every Bitcoin
-- chain a venue has ever had. A venue that re-genesises its Bitcoin chain without
-- rebuilding the hub database keeps serving the dead chain's finalized matches and
-- capability snapshots to every fresh indexer, which then evaluates rows that can never
-- settle at every block (measured 2026-09-08: two relic matches and 33 snapshots on the
-- regtest venue).
--
-- btc_chain_id is the hash of BLOCK 1 on the Bitcoin chain the writing hub follows. Not
-- block 0: the regtest genesis hash is a chainparams constant, identical across every
-- re-genesis, while block 1 commits to the instant the chain was created. The hub stamps
-- it from the tip its Bitcoin indexer pushes; the mirror refuses a row whose value is
-- non-NULL and different from the chain this indexer follows, and purges the relics once
-- it learns which chain that is.
--
-- NULLABLE, and NULL is accepted by the filter: every row written before the column
-- existed carries NULL, so mainnet and testnet history keeps mirroring unchanged, and a
-- hub that has not yet been told its chain writes NULL rather than a wrong value.
--
-- NOT consensus-visible. The column enters no signed canonical and no hash preimage: the
-- match canonical (CrossChainDexEngine._canonicalMatch and the indexer's cross_settle
-- _canonical twin) and the XCALL canonical both enumerate their fields explicitly. It is
-- transport: it decides which rows a mirror accepts, never what a match says.
--
-- No index. The column is read per applied row and in one DELETE per expectation change,
-- never as a query predicate on a hot path.
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS, a no-op on any install whose boot-time
-- reconcileTableIndexes/alterTableForDrift has already healed the column in from the
-- definitions in src/sql/. Each column is declared LAST in its definition; the AFTER
-- anchors keep SHOW CREATE TABLE byte-equal between a migrated DB and a fresh install
-- (the column-parity test checks position).
--
-- HOW TO RUN
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-09-08-cross-chain-btc-chain-id.sql

ALTER TABLE cross_chain_matches
  ADD COLUMN IF NOT EXISTS btc_chain_id CHAR(64) AFTER created_at;

ALTER TABLE cross_chain_calls
  ADD COLUMN IF NOT EXISTS btc_chain_id CHAR(64) AFTER created_at;

ALTER TABLE capability_snapshots
  ADD COLUMN IF NOT EXISTS btc_chain_id CHAR(64) AFTER created_at;
