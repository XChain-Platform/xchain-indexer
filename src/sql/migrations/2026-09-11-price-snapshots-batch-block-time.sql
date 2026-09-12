-- xchain:migration mode=auto
-- Migration: price_snapshots.batch_block_time, plus the index fee pricing reads it by.
--
-- WHY
-- ---
-- Native-coin fee pricing (db.getLatestPrice) selects the newest finalized round the
-- node HOLDS. A hub-connected node's oracle mirror holds a round the moment consensus
-- finalizes it, a whole batch window before the PRICE batch carrying it is mined; a
-- node that reads only the chain cannot hold that round until the batch lands in a
-- block it has processed. Both nodes are honest and they price the same fee-bearing
-- action against different rounds, so a price move past the fee tolerance inside the
-- landing latency gives opposite verdicts on the same action.
--
-- batch_block_time is the clock of the block the batch carrying this round LANDED in,
-- stamped by the hub's batch ingest for every round a landed batch carries (stored or
-- already finalized there) and mirrored down with the row. 0 means no landed batch is
-- known yet, which is exactly the state a round finalized ahead of its batch is in.
-- Under src/price_fee_batch_landed_activation.js the fee read bounds itself on it, and
-- the two node kinds converge on the newest round the chain could have shown them.
--
-- The axis is TIME, not the landing HEIGHT: a batch lands on one chain, so its height
-- names no block on any other, which is the same vacuity reference_block already has
-- off the reference chain. The landing block's clock is comparable everywhere.
--
-- NOT consensus-visible as DDL, and the read that uses it is gated. The column enters
-- no block-hash preimage; it is a mirrored projection column, and WHICH rounds a fee is
-- priced against is decided by the SQL predicate and its activation height. The gate
-- ships unarmed on every network, so a from-genesis replay is unchanged by this.
--
-- Non-unique index: many pairs share one round and one landing clock. The gated read
-- selects one coin_pair, bounds the landing clock and orders by round_number, so the
-- bounded column has to sit between them or the added bound degrades into a filter and
-- a filesort over every finalized round of the pair.
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS with the AFTER anchor matching the
-- definition (so SHOW CREATE TABLE stays byte-equal between a migrated DB and a fresh
-- install), and CREATE INDEX IF NOT EXISTS, a no-op on any install whose boot-time
-- reconcile already healed both in from src/sql/price_snapshots.sql.
--
-- HOW TO RUN
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-09-11-price-snapshots-batch-block-time.sql

ALTER TABLE price_snapshots
  ADD COLUMN IF NOT EXISTS batch_block_time BIGINT NOT NULL DEFAULT 0 AFTER push_generation;

CREATE INDEX IF NOT EXISTS idx_pair_batchtime_round ON price_snapshots (coin_pair, batch_block_time, round_number);
