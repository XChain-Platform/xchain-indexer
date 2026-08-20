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

-- xchain:migration mode=auto
--
-- Migration: widen the user-text columns from utf8mb3 to utf8mb4.
--
-- WHY
-- ---
-- Every table here was declared DEFAULT CHARSET=utf8, which is utf8mb3: at most 3 bytes
-- per character, so no character outside the Basic Multilingual Plane fits. A 4-byte
-- character (any emoji, and plenty of CJK extension B and historic scripts) is legal
-- content in a broadcast, and under STRICT_TRANS_TABLES the INSERT fails with errno 1366
-- (ER_TRUNCATED_WRONG_VALUE_FOR_FIELD) rather than truncating. The block loop retries the
-- failing block forever, so one legal broadcast permanently halts an indexer, and every
-- indexer on that chain halts at the same height. transactions.data is the first column
-- reached, because it stores the WHOLE decoded action string; the per-action projections
-- listed below are the same user bytes after the parse, so each is the next halt in line.
--
-- Ingest semantics are unchanged: this widens the accepted byte domain and rewrites no
-- stored value. utf8mb3 is a strict subset of utf8mb4 and utf8mb4_general_ci orders BMP
-- characters exactly as utf8_general_ci does, so every existing row keeps its bytes and
-- its sort position.
--
-- NOT consensus-visible. None of these tables enter a block-hash preimage
-- (db.getBlockHashes covers balances/credits/debits/escrows, contracts, contract_state,
-- contract_executions, contract_emissions, deposits, withdrawals), and none of these
-- columns is compared against another column, so no join changes collation.
--
-- SCOPE
-- -----
-- The columns that ingest free-form wire text. Deliberately NOT here:
--   * contracts.code - same class of defect, but contracts IS in the contract_hash
--     preimage, and the byte-identical xchain-sync twin would have to move with it.
--   * contract_state.state_key / state_key_bin / state_value - the state_key collation
--     is a height-gated consensus flag-day (src/state_key_collation_activation.js).
--   * polls.callback_params - its ADD COLUMN migration (2026-07-05) is checksum-immutable
--     and declares plain MEDIUMTEXT, so a charset on the definition would break the
--     ADD-COLUMN parity gate with no legal way to converge the two paths.
--   * index_memos.memo - MODIFY of a NOT NULL column is destructive to the auto-apply
--     classifier, so it ships as the paired mode=manual file of the same date.
--   * grammar-constrained fields (amounts, block heights, hex hashes, addresses,
--     tickers, enums). An action that fails validation still persists its raw field
--     bytes, so those columns remain a halt vector; widening them touches columns that
--     ORDER BY inside consensus preimages and needs its own fork-safety ruling.
--
-- IDEMPOTENT: re-running a MODIFY to the same type and charset is a no-op, and the
-- schema_migrations ledger records this file once per DB. Fresh installs already get
-- utf8mb4 from the src/sql/<table>.sql definitions, which the schema-parity suite holds
-- byte-equal to the MODIFYs below in both directions.
--
-- NOTE: a charset widen on a VARCHAR is a COPY rebuild under a shared metadata lock, not
-- ALGORITHM=INSTANT. The tables here are small (bet_feeds, files, messages, polls,
-- broadcasts, issues, tokens) except transactions, which is one row per action-carrying
-- transaction; expect the transactions rebuild to dominate the run on a mainnet DB.
--
-- HOW TO RUN (it also applies unattended at startup)
--   mariadb -u <indexer_user> -p <indexer_db> < src/sql/migrations/2026-08-19-utf8mb4-user-text-columns.sql

ALTER TABLE transactions
  MODIFY data MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE broadcasts
  MODIFY message VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE files
  MODIFY name  VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY title VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE messages
  MODIFY encryption_key    MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY encrypted_message MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY plaintext_message MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE tokens
  MODIFY description VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE issues
  MODIFY description VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE polls
  MODIFY options  MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY question MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

ALTER TABLE bet_feeds
  MODIFY label    VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY outcomes VARCHAR(1100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  MODIFY details  TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
