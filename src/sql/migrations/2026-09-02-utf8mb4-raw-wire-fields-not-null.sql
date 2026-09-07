--********************************************************************
--
-- Copyright © 2025-2026 Dankest, LLC
-- Based on XChain Platform by Dankest, LLC - https://dankest.llc
--
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- This file is part of XChain Platform. Licensed under the GNU Affero
-- General Public License v3.0 or later; see LICENSE.md. A commercial
-- license (without AGPL source-disclosure terms) is available -
-- contact legal@dankest.llc.
--
--********************************************************************

-- xchain:migration mode=manual
--
-- Migration: the NOT NULL half of the raw-wire-field utf8mb4 widen. Paired with the
-- mode=auto 2026-09-02-utf8mb4-raw-wire-fields.sql of the same date; the reasoning for the
-- whole change lives there. These columns are split out for one reason, the same one that
-- split index_memos.memo out of the 2026-08-19 pass: the column is NOT NULL, and a MODIFY
-- that carries NOT NULL is indistinguishable from a narrowing to the auto-apply
-- destructive-DDL classifier (db._destructiveAutoStatement), so the file cannot be tagged
-- mode=auto. Omitting NOT NULL is not an option: a MODIFY restates the whole column, so it
-- would silently relax the column and diverge the two schema paths.
--
-- WHAT IS STILL WEDGED UNTIL THIS RUNS
-- ------------------------------------
-- contracts.code and deploy_chunks.code_part hold contract SOURCE, stored whether the
-- DEPLOY / DEPLOY_CHUNK was valid or not (deploy.js createContract, deploy_chunk.js
-- recordDeployChunk). A 4-byte character inside a JavaScript string literal is ordinary,
-- legal source, so this is the cheapest halt to arm of the whole set. gated_files.gate_ticker
-- and attests.provider_id are raw the same way (probed against the live writers). The NOT
-- NULL amount columns - deposits, withdrawals, the four stake / unstake tables and
-- reward_claims - are widened as defence in depth: db.normalizeDataValues nulls a
-- non-numeric AMOUNT before the INSERT, so they do not halt on errno 1366 today, and that
-- hand-maintained NUMBER_FIELDS list is the only reason (it has already failed once, the
-- 2026-07-05 CONTRACT_ACTION_INDEX wedge on LTC-regtest).
--
-- NOT CONSENSUS-VISIBLE. deposits and withdrawals DO enter a block-hash preimage
-- (db.getBlockHashes) and the preimage selects their amount, but it orders on
-- `ORDER BY ... d.amount ASC` with no explicit COLLATE: utf8mb4_general_ci orders every
-- BMP character exactly as utf8_general_ci does, and a 4-byte character cannot be present
-- in any existing row (it would have halted the indexer that wrote it), so the ordering
-- over every row that can exist today is unchanged. contracts is hashed on code_hash,
-- never on code. Widening rewrites no stored value: utf8mb3 is a strict subset of utf8mb4.
--
-- ROW FORMAT: gated_files.gate_ticker carries two secondary indexes. At utf8mb4 its key
-- part is 250 * 4 = 1000 bytes, which fits the 3072-byte InnoDB limit only under
-- ROW_FORMAT=DYNAMIC (the MariaDB 10.2+ default). On a legacy COMPACT or REDUNDANT table
-- the limit is 767 bytes and the ALTER fails with errno 1071 rather than applying, so
-- check the row format first and convert the table before running this file:
--
--   SELECT table_name, row_format FROM information_schema.tables
--    WHERE table_schema = DATABASE() AND table_name = 'gated_files';
--   -- if not Dynamic:
--   ALTER TABLE gated_files ROW_FORMAT=DYNAMIC;
--
-- IDEMPOTENT: re-running a MODIFY to the same type and charset is a no-op, and the
-- schema_migrations ledger records this file once per DB.
--
-- HOW TO RUN
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-09-02-utf8mb4-raw-wire-fields-not-null.sql

ALTER TABLE `contracts`
  MODIFY `code` MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL;

ALTER TABLE `deploy_chunks`
  MODIFY `code_part` MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL;

ALTER TABLE `deposits`
  MODIFY `amount` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL;

ALTER TABLE `withdrawals`
  MODIFY `amount` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL;

ALTER TABLE `stakes`
  MODIFY `amount` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL;

ALTER TABLE `unstakes`
  MODIFY `amount` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL;

ALTER TABLE `contract_stakes`
  MODIFY `amount` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL;

ALTER TABLE `contract_unstakes`
  MODIFY `amount` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL;

ALTER TABLE `reward_claims`
  MODIFY `amount` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL;

ALTER TABLE `gated_files`
  MODIFY `gate_ticker` VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL;

ALTER TABLE `attests`
  MODIFY `provider_id` VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL;
