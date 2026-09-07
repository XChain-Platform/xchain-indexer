-- xchain:migration mode=auto
-- Migration: the attests batch chunk table (window header + chunk slot + body slice).
--
-- WHY
-- ---
-- ATTEST v5 (head) and v6 (continuation) carry a window of finalized attestation
-- responses on the DOGE rail, deflated, base64'd and split across as many wires as
-- the window needs. A single-wire batch is complete the moment its head lands, so it
-- reassembles in memory and needs no storage at all. A multi-wire batch does: the
-- head and its continuations are separate actions, in separate blocks, in either
-- order, and whichever one completes the index coverage has to reassemble the whole
-- body from what the chain already holds.
--
-- These columns are that chunk table, on the ANCHOR archive precedent
-- (anchor_actions.total_chunks / chunk_index / archive_b64, src/sql/anchor_actions.sql):
-- the head stores slot 0, each continuation stores one later slot, and the head also
-- stores the window header, because a continuation landing afterwards has no other way
-- to rebuild the head it must verify the reassembled body against.
--
-- The network is deliberately NOT among them. This database is one network, and a
-- batch declaring another one is refused before it is ever recorded valid, so a
-- network column here could only ever repeat the config it was checked against.
--
-- Additive and nullable throughout (IF NOT EXISTS on every ADD), so alterTableForDrift
-- converges any install at startup and an indexer that has not upgraded simply lacks
-- the columns and reassembles nothing. Nothing is backfilled: every pre-existing row
-- is a v0 request or a v1 response, neither of which is a chunk.
--
-- They hash nothing. The state hash covers a request's status flip through
-- resolved_block; it reads no batch column, and the batch's own verdict rides on the
-- action status that already existed.
--
-- No index accompanies them: the (request_id, version) lookup index this table already
-- declares is exactly the seek the chunk read performs.
--
-- POSITION matters as much as presence: all eight land AFTER batch_action_index, in the
-- order src/sql/attests.sql declares them, so a fresh install (definition path) and a
-- long-lived database (this ledger path) converge on a byte-identical SHOW CREATE TABLE.
-- test/unit/sql-schema-column-parity.test.js fails CI on any divergence.
--
-- HOW TO RUN
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-09-03-attests-batch-chunk-columns.sql

ALTER TABLE attests
  ADD COLUMN IF NOT EXISTS batch_window_start     BIGINT UNSIGNED AFTER batch_action_index,
  ADD COLUMN IF NOT EXISTS batch_window_end       BIGINT UNSIGNED AFTER batch_window_start,
  ADD COLUMN IF NOT EXISTS batch_row_count        INT UNSIGNED AFTER batch_window_end,
  ADD COLUMN IF NOT EXISTS batch_btc_block_height BIGINT UNSIGNED AFTER batch_row_count,
  ADD COLUMN IF NOT EXISTS batch_crc32            VARCHAR(8) AFTER batch_btc_block_height,
  ADD COLUMN IF NOT EXISTS batch_total_chunks     INT UNSIGNED AFTER batch_crc32,
  ADD COLUMN IF NOT EXISTS batch_chunk_index      INT UNSIGNED AFTER batch_total_chunks,
  ADD COLUMN IF NOT EXISTS batch_chunk_b64        MEDIUMTEXT AFTER batch_chunk_index;
